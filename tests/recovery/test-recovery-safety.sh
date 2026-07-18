#!/usr/bin/env bash

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-recovery-tests.XXXXXX")"
TMP_DIR="$(cd "$TMP_DIR" && pwd -P)"
trap 'rm -rf -- "$TMP_DIR"' EXIT INT TERM
PASS_COUNT=0
FAIL_COUNT=0
LAST_OUTPUT=""
STAMP="20260717-010203"

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf 'ok %s - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'not ok %s - %s\n%s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1" "$2" >&2; }
expect_success() {
  local name="$1"; shift
  if LAST_OUTPUT="$("$@" 2>&1)"; then pass "$name"; else fail "$name" "$LAST_OUTPUT"; fi
}
expect_failure() {
  local name="$1" expected="$2"; shift 2
  if LAST_OUTPUT="$("$@" 2>&1)"; then
    fail "$name" 'command unexpectedly succeeded'
  elif [[ "$LAST_OUTPUT" != *"$expected"* ]]; then
    fail "$name" "expected '$expected', got: $LAST_OUTPUT"
  else
    pass "$name"
  fi
}
file_mode() {
  local mode
  if mode="$(stat -c '%a' -- "$1" 2>/dev/null)"; then
    :
  elif mode="$(stat -f '%Lp' -- "$1" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  printf '%s\n' "$mode"
}
sha256_digest() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}
CHECKPOINT_RUNNER_EPOCH='11111111-1111-4111-8111-111111111111'
LIVE_RUNNER_EPOCH='22222222-2222-4222-8222-222222222222'
export LIVE_RUNNER_EPOCH

make_sql_fixture() {
  local plain_path="$1" gzip_path="$2" mode="${3:-valid}"
  local index version
  {
    printf 'CREATE SCHEMA coturn;\n'
    printf 'CREATE SCHEMA ret0;\n'
    printf 'CREATE SCHEMA ret0_admin;\n'
    printf 'CREATE TABLE coturn.turnusers_lt (\n'
    printf ');\n'
    printf 'CREATE TABLE ret0.schema_migrations (\n);\n'
    printf 'CREATE TABLE ret0.hubs (\n);\n'
    printf 'CREATE TABLE ret0.owned_files (\n);\n'
    printf 'CREATE VIEW ret0_admin.admin_view AS\nSELECT 1;\n'
    for index in $(seq 1 351); do
      if [[ "$mode" == "missing-table" && "$index" == "351" ]]; then continue; fi
      if [[ "$mode" == "renamed-table" && "$index" == "351" ]]; then
        printf 'CREATE TABLE ret0.table_evil (\n);\n'
        continue
      fi
      printf 'CREATE TABLE ret0.table_%03d (\n);\n' "$index"
    done
    printf 'COPY ret0.schema_migrations (version) FROM stdin;\n'
    for index in $(seq 1 94); do
      version="$(printf '2019000000%04d' "$index")"
      if [[ "$mode" == "different-version" && "$index" == "94" ]]; then version=20269999999999; fi
      printf '%s\n' "$version"
    done
    printf '\\.\n'
    printf 'COPY ret0.hubs (hub_sid) FROM stdin;\n'
    if [[ "$mode" != "zero-hubs" ]]; then
      for index in $(seq 1 17); do
        if [[ "$mode" == "different-hub" && "$index" == 17 ]]; then printf 'room-evil\n'; else printf 'room-%02d\n' "$index"; fi
      done
    fi
    printf '\\.\n'
    if [[ "$mode" == "duplicate-hubs" ]]; then
      printf 'COPY ret0.hubs (hub_sid) FROM stdin;\nroom-two\n\\.\n'
    fi
    printf 'COPY ret0.owned_files (owned_file_uuid, state) FROM stdin;\n'
    [[ "$mode" == "zero-active" ]] || printf 'active-one\tactive\n'
    if [[ "$mode" == "different-owned" ]]; then printf 'deferred-evil\texpiring\n'; else printf 'deferred-one\texpiring\n'; fi
    if [[ "$mode" != "truncated-owned" ]]; then printf '\\.\n'; fi
    if [[ "$mode" == "extra-noncritical-ddl" ]]; then
      # shellcheck disable=SC2016
      printf 'CREATE FUNCTION ret0.untracked_fixture() RETURNS integer LANGUAGE sql AS $function$ SELECT 1 $function$;\n'
    fi
    if [[ "$mode" != "truncated-owned" ]]; then printf '%s\n' '-- PostgreSQL database dump complete'; fi
    if [[ "$mode" == "duplicate-marker" ]]; then printf '%s\n' '-- PostgreSQL database dump complete'; fi
  } >"$plain_path"
  gzip -c "$plain_path" >"$gzip_path"
}

make_database_contract() {
  local destination="$1" sql_path="$2" relations_json migrations_json hub_sids_json index sql_digest
  sql_digest="$(sha256_digest "$sql_path")"
  relations_json="$({
    printf 'coturn\tturnusers_lt\tBASE TABLE\n'
    printf 'ret0\tschema_migrations\tBASE TABLE\n'
    printf 'ret0\thubs\tBASE TABLE\n'
    printf 'ret0\towned_files\tBASE TABLE\n'
    for index in $(seq 1 351); do printf 'ret0\ttable_%03d\tBASE TABLE\n' "$index"; done
    printf 'ret0_admin\tadmin_view\tVIEW\n'
  } | jq -Rsc 'split("\n")[:-1] | map(split("\t") | {schema:.[0],name:.[1],type:.[2]})')"
  migrations_json="$({
    for index in $(seq 1 94); do printf '2019000000%04d\n' "$index"; done
  } | jq -Rsc 'split("\n")[:-1]')"
  hub_sids_json="$({
    for index in $(seq 1 17); do printf 'room-%02d\n' "$index"; done
  } | jq -Rsc 'split("\n")[:-1]')"
  jq -n --argjson relations "$relations_json" --argjson migrations "$migrations_json" \
    --argjson hub_sids "$hub_sids_json" --arg sql_digest "$sql_digest" '{
    schema_version:2,
    sql_dump_sha256:$sql_digest,
    provenance:{
      baseline:"yenhubs-reticulum-pre-sitting-2026-07",
      compatible_with:["pre-sitting-2026-07","sitting-candidate-2026-07"],
      minimum_relation_count:356,
      minimum_migration_count:94,
      minimum_hubs_count:17
    },
    schemas:["coturn","ret0","ret0_admin"],
    relations:$relations,
    migration_versions:$migrations,
    critical_inventory:{
      hub_sids:$hub_sids,
      owned_files:[
        {uuid:"active-one",state:"active"},
        {uuid:"deferred-one",state:"expiring"}
      ],
      active_owned_file_uuids:["active-one"]
    },
    critical_counts:{relations:356,migrations:94,hubs:17,owned_files:2,active_owned_files:1}
  }' | jq -S . >"$destination"
}

make_storage_fixture() {
  local destination="$1" mode="${2:-valid}"
  local tree="$destination-tree" tar_path="$destination.tar"
  mkdir -p "$tree/owned/ac/ti" "$tree/owned/de/fe"
  if [[ "$mode" != "missing-active" ]]; then
    printf 'blob' >"$tree/owned/ac/ti/active-one.blob"
    printf '{}' >"$tree/owned/ac/ti/active-one.meta.json"
  fi
  if [[ "$mode" == "symlink" ]]; then ln -s ../../../outside "$tree/owned/de/fe/deferred-one.blob"; else printf 'blob' >"$tree/owned/de/fe/deferred-one.blob"; fi
  [[ "$mode" == "incomplete" ]] || printf '{}' >"$tree/owned/de/fe/deferred-one.meta.json"
  if [[ "$mode" == "arbitrary-depth" ]]; then
    mkdir -p "$tree/owned/ac/ti/deeper"
    printf 'rogue' >"$tree/owned/ac/ti/deeper/rogue.blob"
  fi
  tar -C "$tree" -cf "$tar_path" owned
  gzip -c "$tar_path" >"$destination"
}

SQL_PLAIN="$TMP_DIR/retdb.sql"
SQL_GZIP="$TMP_DIR/retdb-$STAMP.sql.gz"
ZERO_ACTIVE_PLAIN="$TMP_DIR/zero-active.sql"
ZERO_ACTIVE_GZIP="$TMP_DIR/zero-active-retdb-$STAMP.sql.gz"
ZERO_HUBS_PLAIN="$TMP_DIR/zero-hubs.sql"
ZERO_HUBS_GZIP="$TMP_DIR/zero-hubs-retdb-$STAMP.sql.gz"
DUPLICATE_SQL_PLAIN="$TMP_DIR/duplicate.sql"
DUPLICATE_SQL_GZIP="$TMP_DIR/duplicate-retdb-$STAMP.sql.gz"
TRUNCATED_SQL_PLAIN="$TMP_DIR/truncated.sql"
TRUNCATED_SQL_GZIP="$TMP_DIR/truncated-retdb-$STAMP.sql.gz"
DIFFERENT_VERSION_SQL_PLAIN="$TMP_DIR/different-version.sql"
DIFFERENT_VERSION_SQL_GZIP="$TMP_DIR/different-version-retdb-$STAMP.sql.gz"
MISSING_TABLE_SQL_PLAIN="$TMP_DIR/missing-table.sql"
MISSING_TABLE_SQL_GZIP="$TMP_DIR/missing-table-retdb-$STAMP.sql.gz"
RENAMED_TABLE_SQL_PLAIN="$TMP_DIR/renamed-table.sql"
RENAMED_TABLE_SQL_GZIP="$TMP_DIR/renamed-table-retdb-$STAMP.sql.gz"
DIFFERENT_HUB_SQL_PLAIN="$TMP_DIR/different-hub.sql"
DIFFERENT_HUB_SQL_GZIP="$TMP_DIR/different-hub-retdb-$STAMP.sql.gz"
DIFFERENT_OWNED_SQL_PLAIN="$TMP_DIR/different-owned.sql"
DIFFERENT_OWNED_SQL_GZIP="$TMP_DIR/different-owned-retdb-$STAMP.sql.gz"
EXTRA_DDL_SQL_PLAIN="$TMP_DIR/extra-ddl.sql"
EXTRA_DDL_SQL_GZIP="$TMP_DIR/extra-ddl-retdb-$STAMP.sql.gz"
make_sql_fixture "$SQL_PLAIN" "$SQL_GZIP"
make_sql_fixture "$ZERO_ACTIVE_PLAIN" "$ZERO_ACTIVE_GZIP" zero-active
make_sql_fixture "$ZERO_HUBS_PLAIN" "$ZERO_HUBS_GZIP" zero-hubs
make_sql_fixture "$DUPLICATE_SQL_PLAIN" "$DUPLICATE_SQL_GZIP" duplicate-hubs
make_sql_fixture "$TRUNCATED_SQL_PLAIN" "$TRUNCATED_SQL_GZIP" truncated-owned
make_sql_fixture "$DIFFERENT_VERSION_SQL_PLAIN" "$DIFFERENT_VERSION_SQL_GZIP" different-version
make_sql_fixture "$MISSING_TABLE_SQL_PLAIN" "$MISSING_TABLE_SQL_GZIP" missing-table
make_sql_fixture "$RENAMED_TABLE_SQL_PLAIN" "$RENAMED_TABLE_SQL_GZIP" renamed-table
make_sql_fixture "$DIFFERENT_HUB_SQL_PLAIN" "$DIFFERENT_HUB_SQL_GZIP" different-hub
make_sql_fixture "$DIFFERENT_OWNED_SQL_PLAIN" "$DIFFERENT_OWNED_SQL_GZIP" different-owned
make_sql_fixture "$EXTRA_DDL_SQL_PLAIN" "$EXTRA_DDL_SQL_GZIP" extra-noncritical-ddl
DATABASE_CONTRACT="$TMP_DIR/database-contract.json"
make_database_contract "$DATABASE_CONTRACT" "$SQL_PLAIN"
DRIFTED_DATABASE_CONTRACT="$TMP_DIR/database-contract-drifted.json"
jq '(.relations[] | select(.schema == "ret0" and .name == "table_351") | .name) = "table_evil"' \
  "$DATABASE_CONTRACT" | jq -S . >"$DRIFTED_DATABASE_CONTRACT"
export STUB_DB_CONTRACT="$DATABASE_CONTRACT" STUB_DRIFTED_DB_CONTRACT="$DRIFTED_DATABASE_CONTRACT"

VALID_STORAGE="$TMP_DIR/ret-storage-$STAMP.tar.gz"
MISSING_STORAGE="$TMP_DIR/missing-ret-storage-$STAMP.tar.gz"
INCOMPLETE_STORAGE="$TMP_DIR/incomplete-ret-storage-$STAMP.tar.gz"
SYMLINK_STORAGE="$TMP_DIR/symlink-ret-storage-$STAMP.tar.gz"
ARBITRARY_DEPTH_STORAGE="$TMP_DIR/arbitrary-depth-ret-storage-$STAMP.tar.gz"
make_storage_fixture "$VALID_STORAGE" valid
make_storage_fixture "$MISSING_STORAGE" missing-active
make_storage_fixture "$INCOMPLETE_STORAGE" incomplete
make_storage_fixture "$SYMLINK_STORAGE" symlink
make_storage_fixture "$ARBITRARY_DEPTH_STORAGE" arbitrary-depth
gzip -cd "$VALID_STORAGE" >"$TMP_DIR/valid.tar"

pair_dir() {
  local name="$1" dump_source="$2" storage_source="$3"
  local directory="$TMP_DIR/pair-$name"
  mkdir -p "$directory"
  cp "$dump_source" "$directory/retdb-$STAMP.sql.gz"
  cp "$storage_source" "$directory/ret-storage-$STAMP.tar.gz"
  cp "$DATABASE_CONTRACT" "$directory/database-contract.json"
  printf '%s\n' "$directory"
}
VALID_PAIR="$(pair_dir valid "$SQL_GZIP" "$VALID_STORAGE")"
MISSING_PAIR="$(pair_dir missing "$SQL_GZIP" "$MISSING_STORAGE")"
INCOMPLETE_PAIR="$(pair_dir incomplete "$SQL_GZIP" "$INCOMPLETE_STORAGE")"
SYMLINK_PAIR="$(pair_dir symlink "$SQL_GZIP" "$SYMLINK_STORAGE")"
ZERO_ACTIVE_PAIR="$(pair_dir zero-active "$ZERO_ACTIVE_GZIP" "$VALID_STORAGE")"
ZERO_HUBS_PAIR="$(pair_dir zero-hubs "$ZERO_HUBS_GZIP" "$VALID_STORAGE")"
DUPLICATE_PAIR="$(pair_dir duplicate "$DUPLICATE_SQL_GZIP" "$VALID_STORAGE")"
TRUNCATED_PAIR="$(pair_dir truncated "$TRUNCATED_SQL_GZIP" "$VALID_STORAGE")"
DIFFERENT_VERSION_PAIR="$(pair_dir different-version "$DIFFERENT_VERSION_SQL_GZIP" "$VALID_STORAGE")"
MISSING_TABLE_PAIR="$(pair_dir missing-table "$MISSING_TABLE_SQL_GZIP" "$VALID_STORAGE")"
RENAMED_TABLE_PAIR="$(pair_dir renamed-table "$RENAMED_TABLE_SQL_GZIP" "$VALID_STORAGE")"
DIFFERENT_HUB_PAIR="$(pair_dir different-hub "$DIFFERENT_HUB_SQL_GZIP" "$VALID_STORAGE")"
DIFFERENT_OWNED_PAIR="$(pair_dir different-owned "$DIFFERENT_OWNED_SQL_GZIP" "$VALID_STORAGE")"
EXTRA_DDL_PAIR="$(pair_dir extra-ddl "$EXTRA_DDL_SQL_GZIP" "$VALID_STORAGE")"
ARBITRARY_DEPTH_PAIR="$(pair_dir arbitrary-depth "$SQL_GZIP" "$ARBITRARY_DEPTH_STORAGE")"

make_deployments_json() {
  jq -n --arg epoch "$LIVE_RUNNER_EPOCH" '
    def item($name; $containers): {
      metadata: {name:$name, uid:("uid-"+$name),annotations:{
        "yenhubs.org/bot-runner-recovery-phase":"active"}},
      spec: {replicas:1, selector:{matchLabels:{app:$name}}, template:{
        metadata:{annotations:{"yenhubs.org/bot-runner-recovery-epoch":$epoch}},
        spec:{initContainers:[],containers:$containers}}},
      status: {readyReplicas:1}
    };
    {items:[
      item("bot-orchestrator"; [{name:"bot-orchestrator",image:("ghcr.io/yengalvez/bot-orchestrator@sha256:"+("a"*64))}]),
      item("coturn"; [{name:"coturn",image:("ghcr.io/yengalvez/coturn@sha256:"+("b"*64))}]),
      item("dialog"; [{name:"dialog",image:("ghcr.io/yengalvez/dialog@sha256:"+("c"*64))}]),
      item("haproxy"; [{name:"haproxy",image:("ghcr.io/yengalvez/haproxy@sha256:"+("d"*64))}]),
      item("hubs"; [{name:"hubs",image:("ghcr.io/yengalvez/hubs@sha256:"+("e"*64))}]),
      item("nearspark"; [{name:"nearspark",image:("ghcr.io/yengalvez/nearspark@sha256:"+("f"*64))}]),
      item("pgbouncer"; [{name:"pgbouncer",image:("ghcr.io/yengalvez/pgbouncer@sha256:"+("1"*64))}]),
      item("pgbouncer-t"; [{name:"pgbouncer-t",image:("ghcr.io/yengalvez/pgbouncer@sha256:"+("1"*64))}]),
      item("photomnemonic"; [{name:"photomnemonic",image:("ghcr.io/yengalvez/photomnemonic@sha256:"+("3"*64))}]),
      item("pgsql"; [{name:"postgresql",image:("ghcr.io/yengalvez/postgres@sha256:"+("4"*64))}]),
      item("reticulum"; [{name:"postgrest",image:("ghcr.io/yengalvez/postgrest@sha256:"+("5"*64))},{name:"reticulum",image:("ghcr.io/yengalvez/reticulum@sha256:"+("6"*64))}]),
      item("spoke"; [{name:"spoke",image:("ghcr.io/yengalvez/spoke@sha256:"+("7"*64))}])
    ]}
  '
}
STUB_DEPLOYMENTS_JSON="$TMP_DIR/deployments.json"
make_deployments_json >"$STUB_DEPLOYMENTS_JSON"
export STUB_DEPLOYMENTS_JSON
VALUES_FIXTURE="$TMP_DIR/input-values.fixture.yaml"
cat >"$VALUES_FIXTURE" <<'YAML'
OVERRIDE_BOT_ORCHESTRATOR_IMAGE: ghcr.io/yengalvez/bot-orchestrator@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OVERRIDE_BOT_RUNNER_IMAGE: ghcr.io/yengalvez/bot-runner@sha256:8888888888888888888888888888888888888888888888888888888888888888
BOT_ORCHESTRATOR_ACCESS_KEY: fixture-rotated-orchestrator-key-at-least-32-chars
BOT_RUNNER_RECOVERY_EPOCH: 22222222-2222-4222-8222-222222222222
BOT_IMAGE_PULL_CONFIG_JSON_BASE64: eyJhdXRocyI6eyJnaGNyLmlvIjp7ImF1dGgiOiJZMmt0ZFhObGNqcGphUzEwYjJ0bGJnPT0ifX19 # gitleaks:allow non-secret CI fixture
OVERRIDE_COTURN_IMAGE: ghcr.io/yengalvez/coturn@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
OVERRIDE_DIALOG_IMAGE: ghcr.io/yengalvez/dialog@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
OVERRIDE_HAPROXY_IMAGE: ghcr.io/yengalvez/haproxy@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
OVERRIDE_HUBS_IMAGE: ghcr.io/yengalvez/hubs@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
OVERRIDE_NEARSPARK_IMAGE: ghcr.io/yengalvez/nearspark@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
OVERRIDE_PGBOUNCER_IMAGE: ghcr.io/yengalvez/pgbouncer@sha256:1111111111111111111111111111111111111111111111111111111111111111
OVERRIDE_PHOTOMNEMONIC_IMAGE: ghcr.io/yengalvez/photomnemonic@sha256:3333333333333333333333333333333333333333333333333333333333333333
OVERRIDE_POSTGRES_IMAGE: ghcr.io/yengalvez/postgres@sha256:4444444444444444444444444444444444444444444444444444444444444444
OVERRIDE_POSTGREST_IMAGE: ghcr.io/yengalvez/postgrest@sha256:5555555555555555555555555555555555555555555555555555555555555555
OVERRIDE_RETICULUM_IMAGE: ghcr.io/yengalvez/reticulum@sha256:6666666666666666666666666666666666666666666666666666666666666666
OVERRIDE_SPOKE_IMAGE: ghcr.io/yengalvez/spoke@sha256:7777777777777777777777777777777777777777777777777777777777777777
YAML
chmod 600 "$VALUES_FIXTURE"
VALUES_PROCESS_LOCAL_FIXTURE="$TMP_DIR/input-values.process-local.fixture.yaml"
sed \
  's|^OVERRIDE_BOT_RUNNER_IMAGE:.*$|OVERRIDE_BOT_RUNNER_IMAGE: No|' \
  "$VALUES_FIXTURE" >"$VALUES_PROCESS_LOCAL_FIXTURE"
chmod 600 "$VALUES_PROCESS_LOCAL_FIXTURE"
RUNNER_DIGEST_IMAGE='ghcr.io/yengalvez/bot-runner@sha256:8888888888888888888888888888888888888888888888888888888888888888'
LEGACY_DEPLOYMENTS_JSON="$TMP_DIR/deployments-legacy-process-local.json"
jq '
  (.items[].metadata.annotations) = null |
  (.items[].spec.template.metadata.annotations) = null |
  (.items[] | select(.metadata.name == "bot-orchestrator") | .spec.strategy) =
    {type:"Recreate"} |
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.automountServiceAccountToken) = false |
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.volumes) = [{
      name:"bot-orchestrator-tmp",emptyDir:{sizeLimit:"256Mi"}
    }] |
  (.items[] | select(.metadata.name == "pgsql") |
    .spec.template.spec.containers[0].name) = "postgresql" |
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[0]) += {
      securityContext:{
        runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,
        allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,
        capabilities:{drop:["ALL"]},seccompProfile:{type:"RuntimeDefault"}
      },
      env:[
        {name:"BOT_ACCESS_KEY",valueFrom:{secretKeyRef:{
          name:"configs",key:"BOT_ACCESS_KEY"}}},
        {name:"RUNNER_AUTOSTART",value:"true"},
        {name:"RUNNER_BACKEND",value:"ghost"},
        {name:"GHOST_RUNNER_SCRIPT",value:"/app/run-ghost-runner.js"}
      ],
      volumeMounts:[{name:"bot-orchestrator-tmp",mountPath:"/tmp"}]
    }
' "$STUB_DEPLOYMENTS_JSON" >"$LEGACY_DEPLOYMENTS_JSON"
LEGACY_WRONG_ACCESS_KEY_DEPLOYMENTS_JSON="$TMP_DIR/deployments-legacy-wrong-access-key.json"
jq '
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[0].env[] |
    select(.name == "BOT_ACCESS_KEY")) = {
      name:"BOT_RUNNER_ACCESS_KEY",valueFrom:{secretKeyRef:{
        name:"configs",key:"BOT_RUNNER_ACCESS_KEY"}}
    }
' "$LEGACY_DEPLOYMENTS_JSON" >"$LEGACY_WRONG_ACCESS_KEY_DEPLOYMENTS_JSON"
LEGACY_MIXED_ACCESS_KEYS_DEPLOYMENTS_JSON="$TMP_DIR/deployments-legacy-mixed-access-keys.json"
jq '
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[0].env) += [{
      name:"BOT_RUNNER_ACCESS_KEY",valueFrom:{secretKeyRef:{
        name:"configs",key:"BOT_RUNNER_ACCESS_KEY"}}
    }]
' "$LEGACY_DEPLOYMENTS_JSON" >"$LEGACY_MIXED_ACCESS_KEYS_DEPLOYMENTS_JSON"
LEGACY_MIXED_PGSQL_DEPLOYMENTS_JSON="$TMP_DIR/deployments-legacy-mixed-pgsql.json"
jq '
  (.items[] | select(.metadata.name == "pgsql") |
    .spec.template.spec.containers[0].name) = "pgsql"
' "$LEGACY_DEPLOYMENTS_JSON" >"$LEGACY_MIXED_PGSQL_DEPLOYMENTS_JSON"
LEGACY_RET_CONFIG_JSON="$TMP_DIR/ret-config-legacy.json"
jq -cn '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"ret-config",
  namespace:"hcce",uid:"ret-config-uid",resourceVersion:"ret-config-rv"},
  data:{"config.toml.template":"legacy = \"<BOT_ACCESS_KEY>\"\n"}}' \
  >"$LEGACY_RET_CONFIG_JSON"
LEGACY_CONFIGS_SECRET_JSON="$TMP_DIR/configs-legacy.json"
jq -cn '{apiVersion:"v1",kind:"Secret",metadata:{name:"configs",
  namespace:"hcce",uid:"configs-uid",resourceVersion:"configs-rv"},
  data:{BOT_ACCESS_KEY:"eA=="}}' >"$LEGACY_CONFIGS_SECRET_JSON"
export LEGACY_RET_CONFIG_JSON LEGACY_CONFIGS_SECRET_JSON
KUBERNETES_DEPLOYMENTS_JSON="$TMP_DIR/deployments-kubernetes-runner.json"
jq --arg image "$RUNNER_DIGEST_IMAGE" '
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.strategy) = {type:"Recreate"} |
  (.items[] | select(.metadata.name == "pgsql") |
    .spec.template.spec.containers[0].name) = "pgsql" |
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.serviceAccountName) = "bot-orchestrator" |
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.automountServiceAccountToken) = true |
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
    .env) = [{name:"BOT_RUNNER_IMAGE",value:$image}]
' "$STUB_DEPLOYMENTS_JSON" >"$KUBERNETES_DEPLOYMENTS_JSON"
RESTORE_VALUES_FIXTURE="$TMP_DIR/input-values.restore-fence.fixture.yaml"
sed \
  's|^BOT_RUNNER_RECOVERY_EPOCH:.*$|BOT_RUNNER_RECOVERY_EPOCH: 33333333-3333-4333-8333-333333333333|' \
  "$VALUES_FIXTURE" >"$RESTORE_VALUES_FIXTURE"
chmod 600 "$RESTORE_VALUES_FIXTURE"
export VALUES_FILE="$RESTORE_VALUES_FIXTURE"

make_checkpoint() {
  local directory="$1"
  mkdir -p "$directory"
  cp "$SQL_GZIP" "$directory/retdb-$STAMP.sql.gz"
  cp "$VALID_STORAGE" "$directory/ret-storage-$STAMP.tar.gz"
  cp "$DATABASE_CONTRACT" "$directory/database-contract.json"
  jq -n --arg stamp "$STAMP" --argjson epoch "$(date -u '+%s')" '{
    schema_version:2,
    provenance:{generator:"yenhubs-local-coordinated-checkpoint-v2",external_import:false},
    stamp:$stamp,created_at_utc:"2026-07-17T00:00:00Z",created_at_epoch:$epoch,
    kube_context:"fixture-context",namespace:"hcce",namespace_uid:"fixture-uid",
    ret_pvc_uid:"fixture-pvc-uid",operation_id:("9"*32),
    writer_quiescence:{required:true,started_at_utc:"2026-07-17T00:00:00Z",completed_at_utc:"2026-07-17T00:00:01Z"}
  }' >"$directory/checkpoint-metadata.json"
  jq --arg namespace hcce --arg uid fixture-uid \
    '{schema_version:3,namespace:$namespace,namespace_uid:$uid,
      bot_runner_runtime:{
        mode:"process-local",image:null,control_plane:{state:"legacy-absent"},
        recovery_epoch:{state:"legacy-absent"}},
      deployments:[.items[]|{name:.metadata.name,uid:.metadata.uid,
        replicas:.spec.replicas,init_containers:[],
        containers:[.spec.template.spec.containers[]|{name,image}]}]}' \
    "$LEGACY_DEPLOYMENTS_JSON" >"$directory/deployment-images.json"
  printf 'A=configured\n' >"$directory/configured-value-keys.txt"
  printf 'cluster\n' >"$directory/digitalocean-cluster.json"
  printf 'lbs\n' >"$directory/digitalocean-load-balancers.json"
  printf 'volumes\n' >"$directory/digitalocean-volumes.json"
  printf 'git\n' >"$directory/git-state.txt"
  printf '{}\n' >"$directory/k8s-configmaps-redacted.json"
  printf '{}\n' >"$directory/k8s-hcce-structure.json"
  refresh_manifest "$directory"
}

refresh_manifest() {
  local directory="$1" artifact digest
  : >"$directory/SHA256SUMS"
  while IFS= read -r artifact; do
    digest="$(sha256_digest "$directory/$artifact")"
    printf '%s  %s\n' "$digest" "$artifact" >>"$directory/SHA256SUMS"
  done < <(
    source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
    recovery_checkpoint_artifacts "$STAMP"
  )
}

GOOD_CHECKPOINT="$TMP_DIR/checkpoint-good"
make_checkpoint "$GOOD_CHECKPOINT"
DUMP_SHA="$(sha256_digest "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz")"
STORAGE_SHA="$(sha256_digest "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz")"
CONFIRM_DB="retdb:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA"
CONFIRM_STORAGE="ret-pvc:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:fixture-pvc-uid"

SIZE_FIXTURE="$TMP_DIR/file-size-fixture"
printf '1234' >"$SIZE_FIXTURE"
# Expansion is intentionally performed by the isolated Bash process below.
# shellcheck disable=SC2016
expect_success 'portable file size helper returns decimal bytes' bash -c '
  source "$1"
  [[ "$(recovery_file_size_bytes "$2")" == 4 ]]
' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$SIZE_FIXTURE"
expect_success 'offline validator accepts complete deferred pairs' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$VALID_PAIR/retdb-$STAMP.sql.gz" "$VALID_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects a missing active pair' 'missing_active_blobs=1' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$MISSING_PAIR/retdb-$STAMP.sql.gz" "$MISSING_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects an incomplete physical pair' 'incomplete_pairs=1' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$INCOMPLETE_PAIR/retdb-$STAMP.sql.gz" "$INCOMPLETE_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects archive links' 'links or unsupported entry types' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$SYMLINK_PAIR/retdb-$STAMP.sql.gz" "$SYMLINK_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects zero active rows' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$ZERO_ACTIVE_PAIR/retdb-$STAMP.sql.gz" "$ZERO_ACTIVE_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects zero room rows' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$ZERO_HUBS_PAIR/retdb-$STAMP.sql.gz" "$ZERO_HUBS_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects duplicate critical COPY' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$DUPLICATE_PAIR/retdb-$STAMP.sql.gz" "$DUPLICATE_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects truncated COPY and missing marker' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$TRUNCATED_PAIR/retdb-$STAMP.sql.gz" "$TRUNCATED_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects same-count migration version drift' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$DIFFERENT_VERSION_PAIR/retdb-$STAMP.sql.gz" "$DIFFERENT_VERSION_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects missing DDL with unchanged critical counts' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$MISSING_TABLE_PAIR/retdb-$STAMP.sql.gz" "$MISSING_TABLE_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects same-count relation-name drift' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$RENAMED_TABLE_PAIR/retdb-$STAMP.sql.gz" "$RENAMED_TABLE_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects same-count Hub SID drift' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$DIFFERENT_HUB_PAIR/retdb-$STAMP.sql.gz" "$DIFFERENT_HUB_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects same-count owned-file inventory drift' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$DIFFERENT_OWNED_PAIR/retdb-$STAMP.sql.gz" "$DIFFERENT_OWNED_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects noncritical SQL byte drift outside parsed inventories' 'complete critical' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$EXTRA_DDL_PAIR/retdb-$STAMP.sql.gz" "$EXTRA_DDL_PAIR/ret-storage-$STAMP.tar.gz"
expect_failure 'offline validator rejects arbitrary storage depth' 'outside the owned-file contract' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$ARBITRARY_DEPTH_PAIR/retdb-$STAMP.sql.gz" "$ARBITRARY_DEPTH_PAIR/ret-storage-$STAMP.tar.gz"
LINKED_ARTIFACT_PAIR="$TMP_DIR/pair-linked-artifact"
cp -R "$VALID_PAIR" "$LINKED_ARTIFACT_PAIR"
rm "$LINKED_ARTIFACT_PAIR/database-contract.json"
ln -s "$DATABASE_CONTRACT" "$LINKED_ARTIFACT_PAIR/database-contract.json"
expect_failure 'offline validator rejects a symlinked sidecar' 'linked or invalid' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$LINKED_ARTIFACT_PAIR/retdb-$STAMP.sql.gz" "$LINKED_ARTIFACT_PAIR/ret-storage-$STAMP.tar.gz"
LINKED_PAIR_COMPONENT="$TMP_DIR/pair-linked-component"
ln -s "$VALID_PAIR" "$LINKED_PAIR_COMPONENT"
expect_failure 'offline validator rejects a symlink directory component' 'linked or reached through a link' "$ROOT_DIR/deployment/validate-checkpoint.sh" "$LINKED_PAIR_COMPONENT/retdb-$STAMP.sql.gz" "$LINKED_PAIR_COMPONENT/ret-storage-$STAMP.tar.gz"

if parser_output="$(bash -c 'source "$1"; recovery_dump_copy_row_count "$2" hubs' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$DUPLICATE_SQL_PLAIN" 2>/dev/null)"; then
  fail 'duplicate SQL parser fails without usable stdout' "unexpected=$parser_output"
elif [[ -n "$parser_output" ]]; then
  fail 'duplicate SQL parser fails without usable stdout' "partial=$parser_output"
else
  pass 'duplicate SQL parser fails without usable stdout'
fi
if parser_output="$(bash -c 'source "$1"; recovery_extract_active_owned_file_uuids "$2"' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$TRUNCATED_SQL_PLAIN" 2>/dev/null)"; then
  fail 'truncated SQL parser fails without usable stdout' "unexpected=$parser_output"
elif [[ -n "$parser_output" ]]; then
  fail 'truncated SQL parser fails without usable stdout' "partial=$parser_output"
else
  pass 'truncated SQL parser fails without usable stdout'
fi

verify_checkpoint() { bash -c 'source "$1"; recovery_verify_checkpoint_directory "$2" "$3"' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$1" "$STAMP"; }
expect_success 'exact checkpoint layout and manifest pass' verify_checkpoint "$GOOD_CHECKPOINT"

EXTRA_CHECKPOINT="$TMP_DIR/checkpoint-extra"; cp -R "$GOOD_CHECKPOINT" "$EXTRA_CHECKPOINT"; printf 'backup\n' >"$EXTRA_CHECKPOINT/retdb-$STAMP.sql.gz.backup"
expect_failure 'checkpoint rejects .backup artifact' 'exact allowlisted artifact set' verify_checkpoint "$EXTRA_CHECKPOINT"
UNLISTED_CHECKPOINT="$TMP_DIR/checkpoint-unlisted"; cp -R "$GOOD_CHECKPOINT" "$UNLISTED_CHECKPOINT"; printf '{}\n' >"$UNLISTED_CHECKPOINT/rogue-snapshot.json"
expect_failure 'checkpoint rejects unlisted snapshot' 'exact allowlisted artifact set' verify_checkpoint "$UNLISTED_CHECKPOINT"
MUTATED_CHECKPOINT="$TMP_DIR/checkpoint-mutated"; cp -R "$GOOD_CHECKPOINT" "$MUTATED_CHECKPOINT"; printf 'mutation\n' >>"$MUTATED_CHECKPOINT/k8s-hcce-structure.json"
expect_failure 'checkpoint rejects a mutated snapshot' 'verification failed' verify_checkpoint "$MUTATED_CHECKPOINT"
OMITTED_CHECKPOINT="$TMP_DIR/checkpoint-omitted"; cp -R "$GOOD_CHECKPOINT" "$OMITTED_CHECKPOINT"; sed '/deployment-images.json$/d' "$OMITTED_CHECKPOINT/SHA256SUMS" >"$OMITTED_CHECKPOINT/new"; mv "$OMITTED_CHECKPOINT/new" "$OMITTED_CHECKPOINT/SHA256SUMS"
expect_failure 'checkpoint rejects an omitted checksum entry' 'exact checkpoint artifact set' verify_checkpoint "$OMITTED_CHECKPOINT"
DUP_MANIFEST_CHECKPOINT="$TMP_DIR/checkpoint-duplicate-manifest"; cp -R "$GOOD_CHECKPOINT" "$DUP_MANIFEST_CHECKPOINT"; first_manifest_line="$(sed -n '1p' "$DUP_MANIFEST_CHECKPOINT/SHA256SUMS")"; printf '%s\n' "$first_manifest_line" >>"$DUP_MANIFEST_CHECKPOINT/SHA256SUMS"
expect_failure 'checkpoint rejects duplicate checksum names' 'duplicate' verify_checkpoint "$DUP_MANIFEST_CHECKPOINT"
PREFIX_CHECKPOINT="$TMP_DIR/checkpoint-prefix"; cp -R "$GOOD_CHECKPOINT" "$PREFIX_CHECKPOINT"; sed '1s/  /  .\//' "$PREFIX_CHECKPOINT/SHA256SUMS" >"$PREFIX_CHECKPOINT/new"; mv "$PREFIX_CHECKPOINT/new" "$PREFIX_CHECKPOINT/SHA256SUMS"
expect_failure 'checkpoint rejects prefixed checksum names' 'prefixed' verify_checkpoint "$PREFIX_CHECKPOINT"
LINKED_CHECKPOINT="$TMP_DIR/checkpoint-linked-inventory"; cp -R "$GOOD_CHECKPOINT" "$LINKED_CHECKPOINT"; rm "$LINKED_CHECKPOINT/git-state.txt"; ln -s "$GOOD_CHECKPOINT/git-state.txt" "$LINKED_CHECKPOINT/git-state.txt"
expect_failure 'checkpoint rejects a symlinked checksummed inventory artifact' 'linked or non-regular' verify_checkpoint "$LINKED_CHECKPOINT"
EXTERNAL_CHECKPOINT="$TMP_DIR/checkpoint-external-provenance"; cp -R "$GOOD_CHECKPOINT" "$EXTERNAL_CHECKPOINT"; jq '.provenance.external_import = true' "$EXTERNAL_CHECKPOINT/checkpoint-metadata.json" >"$EXTERNAL_CHECKPOINT/new"; mv "$EXTERNAL_CHECKPOINT/new" "$EXTERNAL_CHECKPOINT/checkpoint-metadata.json"; refresh_manifest "$EXTERNAL_CHECKPOINT"
expect_failure 'checkpoint rejects externally imported provenance even when rechecksummed' '' verify_checkpoint "$EXTERNAL_CHECKPOINT"
OLD_SCHEMA_CHECKPOINT="$TMP_DIR/checkpoint-old-schema"; cp -R "$GOOD_CHECKPOINT" "$OLD_SCHEMA_CHECKPOINT"; jq '.schema_version = 1' "$OLD_SCHEMA_CHECKPOINT/checkpoint-metadata.json" >"$OLD_SCHEMA_CHECKPOINT/new"; mv "$OLD_SCHEMA_CHECKPOINT/new" "$OLD_SCHEMA_CHECKPOINT/checkpoint-metadata.json"; refresh_manifest "$OLD_SCHEMA_CHECKPOINT"
expect_failure 'checkpoint rejects legacy metadata lacking the coordinated v2 contract' '' verify_checkpoint "$OLD_SCHEMA_CHECKPOINT"
INCOMPLETE_PUBLICATION="$TMP_DIR/checkpoint-incomplete-publication"; cp -R "$GOOD_CHECKPOINT" "$INCOMPLETE_PUBLICATION"; printf 'yenhubs-incomplete:99999999999999999999999999999999\n' >"$INCOMPLETE_PUBLICATION/.yenhubs-incomplete"
expect_failure 'visible checkpoint with an incomplete publication marker is never valid' 'exact allowlisted artifact set' verify_checkpoint "$INCOMPLETE_PUBLICATION"

MATERIALIZE_CHECKPOINT="$TMP_DIR/checkpoint-materialize"; cp -R "$GOOD_CHECKPOINT" "$MATERIALIZE_CHECKPOINT"
# Expansion is intentionally performed by the isolated Bash process below.
# shellcheck disable=SC2016
expect_success 'materialized pair is private, jointly validated and immune to source mutation' bash -c '
  set -euo pipefail
  source "$1"
  recovery_materialize_checkpoint "$2" "$3"
  original="$RECOVERY_DUMP_SHA256"
  contract_original="$(recovery_sha256_digest "$RECOVERY_DATABASE_CONTRACT_COPY")"
  printf mutation >>"$2"
  printf mutation >>"$(dirname "$2")/database-contract.json"
  [[ "$(recovery_sha256_digest "$RECOVERY_DUMP_COPY")" == "$original" ]]
  [[ "$(recovery_sha256_digest "$RECOVERY_DATABASE_CONTRACT_COPY")" == "$contract_original" ]]
  mode="$(stat -c %a -- "$RECOVERY_DUMP_COPY" 2>/dev/null || stat -f %Lp -- "$RECOVERY_DUMP_COPY")"
  [[ "$mode" == 600 ]]
  recovery_cleanup_materialized_checkpoint
' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$MATERIALIZE_CHECKPOINT/retdb-$STAMP.sql.gz" "$ROOT_DIR/deployment/validate-checkpoint.sh"

INHERITED_NORMAL="$TMP_DIR/inherited-normal"
INHERITED_PREFIX="$TMP_DIR/yenhubs-restore-$STAMP.ABC123"
INHERITED_FALSE_PREFIX="$TMP_DIR/yenhubs-restore-$STAMP.ABC123-suffix"
INHERITED_TARGET="$TMP_DIR/inherited-target"
INHERITED_LINK="$TMP_DIR/inherited-link"
mkdir -p "$INHERITED_NORMAL" "$INHERITED_PREFIX" "$INHERITED_FALSE_PREFIX" "$INHERITED_TARGET"
ln -s "$INHERITED_TARGET" "$INHERITED_LINK"
for inherited_path in "$INHERITED_NORMAL" "$INHERITED_PREFIX" "$INHERITED_FALSE_PREFIX" "$INHERITED_LINK"; do
  # Expansion is intentionally performed by the isolated Bash process.
  # shellcheck disable=SC2016
  expect_success "failed materialization cannot delete inherited path $(basename "$inherited_path")" \
    env RECOVERY_MATERIALIZED_DIR="$inherited_path" \
      RECOVERY_MATERIALIZED_PARENT="$TMP_DIR" \
      RECOVERY_MATERIALIZED_MARKER="$inherited_path/.yenhubs-recovery-owner" \
      RECOVERY_MATERIALIZED_OWNED=1 RECOVERY_CHECKPOINT_STAMP=20990101-000000 \
      RECOVERY_DUMP_SHA256=evil RECOVERY_STORAGE_SHA256=evil bash -c '
      set -euo pipefail
      source "$1"
      [[ -z "$RECOVERY_MATERIALIZED_DIR" && "$RECOVERY_MATERIALIZED_OWNED" == 0 ]]
      [[ -z "$RECOVERY_CHECKPOINT_STAMP" && -z "$RECOVERY_DUMP_SHA256" && -z "$RECOVERY_STORAGE_SHA256" ]]
      if recovery_materialize_checkpoint "$2" "$3" >/dev/null 2>&1; then exit 1; fi
      recovery_cleanup_materialized_checkpoint
      [[ -e "$4" || -L "$4" ]]
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$TMP_DIR/does-not-exist" \
      "$ROOT_DIR/deployment/validate-checkpoint.sh" "$inherited_path"
done

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/stub-state"
KUBECTL_LOG="$TMP_DIR/kubectl.log"
export KUBECTL_LOG STUB_STATE_DIR="$TMP_DIR/stub-state" STUB_SQL_PLAIN="$SQL_PLAIN" STUB_TAR_STREAM="$TMP_DIR/valid.tar"

cat >"$TMP_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$KUBECTL_LOG"
if [[ "${1:-}" == "--context" ]]; then shift 2; fi
if [[ "${1:-}" == "--request-timeout=45s" ||
      "${1:-}" == "--request-timeout=75s" ||
      "${1:-}" == "--request-timeout=30s" ||
      "${1:-}" == "--request-timeout=3600s" ]]; then shift; else exit 89; fi
joined="$*"
if [[ "${STUB_MODE:-}" == parent-death-stream &&
      "$joined" == "exec -n hcce parent-death-probe -- destructive-stream" ]]; then
  trap 'printf terminated >"$STUB_STATE_DIR/parent-death-stream-terminated"; exit 143' TERM INT
  (
    trap '' TERM INT
    while :; do sleep 1; done
  ) &
  printf '%s' "$!" >"$STUB_STATE_DIR/parent-death-grandchild-pid"
  printf started >"$STUB_STATE_DIR/parent-death-stream-started"
  wait
  printf completed >"$STUB_STATE_DIR/parent-death-stream-completed"
  exit 0
fi
yaml_field() {
  local pattern="$1" file="$2"
  awk -v pattern="$pattern" '$0 ~ pattern {value=$0; sub(/^[^:]+:[[:space:]]*/, "", value); gsub(/^"|"$/, "", value); print value; exit}' "$file"
}
if [[ "$joined" == "config current-context" ]]; then printf '%s' "${STUB_CURRENT_CONTEXT:-fixture-context}"; exit 0; fi
if [[ "$joined" == "get lease yenhubs-operation-serialization -n hcce --ignore-not-found -o json" ]]; then
  [[ ! -f "$STUB_STATE_DIR/serialization-lease.json" ]] ||
    cat "$STUB_STATE_DIR/serialization-lease.json"
  exit 0
fi
if [[ "$joined" == "get lease yenhubs-operation-serialization -n hcce -o json" ]]; then
  [[ -f "$STUB_STATE_DIR/serialization-lease.json" ]] || exit 1
  if [[ -n "${YENHUBS_PARENT_LEASE_HOLDER:-}" ]]; then
    case "${STUB_MODE:-}" in
      stale-helper-parent-lease-missing)
        exit 1
        ;;
      stale-helper-parent-lease-replaced)
        jq '.metadata.uid = "replacement-serialization-lease-uid"' \
          "$STUB_STATE_DIR/serialization-lease.json"
        exit 0
        ;;
    esac
  fi
  lease_get_count=0
  [[ ! -f "$STUB_STATE_DIR/serialization-lease-get-count" ]] ||
    lease_get_count="$(cat "$STUB_STATE_DIR/serialization-lease-get-count")"
  lease_get_count=$((lease_get_count + 1))
  printf '%s' "$lease_get_count" >"$STUB_STATE_DIR/serialization-lease-get-count"
  if [[ "${STUB_MODE:-}" == lease-holder-lost && "$lease_get_count" -ge 1 ]]; then
    jq '.spec.holderIdentity = "cloud-apply:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" |
      .metadata.resourceVersion = "lease-rv-lost"' \
      "$STUB_STATE_DIR/serialization-lease.json" \
      >"$STUB_STATE_DIR/serialization-lease.next"
    mv "$STUB_STATE_DIR/serialization-lease.next" \
      "$STUB_STATE_DIR/serialization-lease.json"
  fi
  cat "$STUB_STATE_DIR/serialization-lease.json"
  exit 0
fi
if [[ "$joined" == "get role bot-orchestrator-runner-pods -n hcce-bot-runners -o json" ]]; then
  role_uid=runner-role-uid
  role_rv_number=1
  role_phase=active
  role_rules='[{"apiGroups":[""],"resources":["pods"],"verbs":["create","delete","get","list"]}]'
  [[ ! -f "$STUB_STATE_DIR/runner-role-uid" ]] || role_uid="$(cat "$STUB_STATE_DIR/runner-role-uid")"
  [[ ! -f "$STUB_STATE_DIR/runner-role-rv" ]] || role_rv_number="$(cat "$STUB_STATE_DIR/runner-role-rv")"
  [[ ! -f "$STUB_STATE_DIR/runner-role-phase" ]] || role_phase="$(cat "$STUB_STATE_DIR/runner-role-phase")"
  [[ ! -f "$STUB_STATE_DIR/runner-role-rules.json" ]] || role_rules="$(cat "$STUB_STATE_DIR/runner-role-rules.json")"
  jq -cn --arg uid "$role_uid" --arg rv "runner-role-rv-$role_rv_number" \
    --arg phase "$role_phase" --argjson rules "$role_rules" '
    {apiVersion:"rbac.authorization.k8s.io/v1",kind:"Role",
      metadata:{name:"bot-orchestrator-runner-pods",namespace:"hcce-bot-runners",
        uid:$uid,resourceVersion:$rv,annotations:{
          "yenhubs.org/runner-activation-phase":"active",
          "yenhubs.org/bot-runner-recovery-phase":$phase}},rules:$rules}
  '
  exit 0
fi
if [[ "$joined" == "get namespace hcce-bot-runners --ignore-not-found -o json" ]]; then
  if [[ "${STUB_RUNNER_NAMESPACE:-absent}" == present ]]; then
    printf '%s' '{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"hcce-bot-runners","uid":"fixture-runner-namespace-uid"}}'
  fi
  exit 0
fi
if [[ "$joined" == "get serviceaccount bot-orchestrator -n hcce --ignore-not-found -o json" ]]; then
  [[ "${STUB_RUNNER_RESIDUAL:-}" != serviceaccount ]] ||
    printf '%s' '{"apiVersion":"v1","kind":"ServiceAccount","metadata":{"name":"bot-orchestrator","namespace":"hcce","uid":"residual-sa-uid"}}'
  exit 0
fi
if [[ "$joined" == "get secret bot-images-pull -n hcce --ignore-not-found -o json" ]]; then
  if [[ "${STUB_HCCE_PULL_SECRET:-absent}" == present ]]; then
    printf '%s' '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"bot-images-pull","namespace":"hcce","uid":"fixture-pull-uid","resourceVersion":"fixture-pull-rv"}}'
  fi
  exit 0
fi
if [[ "$joined" == "get role bot-orchestrator-runner-pods -n hcce --ignore-not-found -o json" ]]; then
  [[ "${STUB_RUNNER_RESIDUAL:-}" != role ]] ||
    printf '%s' '{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"Role","metadata":{"name":"bot-orchestrator-runner-pods","namespace":"hcce","uid":"residual-role-uid"}}'
  exit 0
fi
if [[ "$joined" == "get rolebinding bot-orchestrator-runner-pods -n hcce --ignore-not-found -o json" ]]; then
  [[ "${STUB_RUNNER_RESIDUAL:-}" != rolebinding ]] ||
    printf '%s' '{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"RoleBinding","metadata":{"name":"bot-orchestrator-runner-pods","namespace":"hcce","uid":"residual-binding-uid"}}'
  exit 0
fi
if [[ "$joined" == "get validatingadmissionpolicy bot-runner-pods.yenhubs.org --ignore-not-found -o json" ]]; then
  [[ "${STUB_RUNNER_RESIDUAL:-}" != validatingadmissionpolicy ]] ||
    printf '%s' '{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingAdmissionPolicy","metadata":{"name":"bot-runner-pods.yenhubs.org","uid":"residual-vap-uid"}}'
  exit 0
fi
if [[ "$joined" == "get validatingadmissionpolicybinding bot-runner-pods.yenhubs.org --ignore-not-found -o json" ]]; then
  [[ "${STUB_RUNNER_RESIDUAL:-}" != validatingadmissionpolicybinding ]] ||
    printf '%s' '{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingAdmissionPolicyBinding","metadata":{"name":"bot-runner-pods.yenhubs.org","uid":"residual-vap-binding-uid"}}'
  exit 0
fi
if [[ "$joined" == get\ namespace\ hcce-bot-runners\ -o\ jsonpath=* ]]; then
  uid=fixture-runner-namespace-uid
  [[ "${STUB_RUNNER_RESOURCE_DRIFT:-}" != namespace ]] || uid=drifted-runner-namespace-uid
  printf 'v1\tNamespace\thcce-bot-runners\t%s' "$uid"
  exit 0
fi
if [[ "$joined" == get\ *\ *\ -n\ hcce-bot-runners\ -o\ jsonpath=* ]]; then
  resource="${2:-}"; name="${3:-}"; api_version=""; kind=""
  case "$resource/$name" in
    secret/bot-images-pull) api_version=v1; kind=Secret ;;
    serviceaccount/bot-runner) api_version=v1; kind=ServiceAccount ;;
    resourcequota/bot-runner-capacity) api_version=v1; kind=ResourceQuota ;;
    role/bot-orchestrator-runner-pods) api_version=rbac.authorization.k8s.io/v1; kind=Role ;;
    rolebinding/bot-orchestrator-runner-pods) api_version=rbac.authorization.k8s.io/v1; kind=RoleBinding ;;
    networkpolicy/bot-runner-default-deny|networkpolicy/bot-runner-egress)
      api_version=networking.k8s.io/v1; kind=NetworkPolicy ;;
    *) exit 1 ;;
  esac
  uid="uid-$name"
  [[ "${STUB_RUNNER_RESOURCE_DRIFT:-}" != "$name" ]] || uid="drifted-$uid"
  printf '%s\t%s\thcce-bot-runners\t%s\t%s' "$api_version" "$kind" "$name" "$uid"
  exit 0
fi
if [[ "$joined" == get\ validatingadmissionpolicy*\ bot-runner-pods.yenhubs.org\ -o\ jsonpath=* ]]; then
  resource="${2:-}"
  if [[ "$resource" == validatingadmissionpolicy ]]; then
    kind=ValidatingAdmissionPolicy
  elif [[ "$resource" == validatingadmissionpolicybinding ]]; then
    kind=ValidatingAdmissionPolicyBinding
  else
    exit 1
  fi
  uid="uid-$resource"
  [[ "${STUB_RUNNER_RESOURCE_DRIFT:-}" != "$resource" ]] || uid="drifted-$uid"
  printf 'admissionregistration.k8s.io/v1\t%s\tbot-runner-pods.yenhubs.org\t%s' "$kind" "$uid"
  exit 0
fi
if [[ "$joined" == get\ namespace\ * ]]; then printf '%s' "${STUB_NAMESPACE_UID:-fixture-uid}"; exit 0; fi
if [[ "$joined" == get\ pvc\ ret-pvc*"jsonpath"* ]]; then printf '%s' "${STUB_PVC_UID:-fixture-pvc-uid}"; exit 0; fi
if [[ "$joined" == "get configmap ret-config -n hcce -o json" ]]; then
  cat "${STUB_RET_CONFIG_JSON:-$LEGACY_RET_CONFIG_JSON}"
  exit 0
fi
if [[ "$joined" == "get secret configs -n hcce -o json" ]]; then
  cat "${STUB_CONFIGS_SECRET_JSON:-$LEGACY_CONFIGS_SECRET_JSON}"
  exit 0
fi
if [[ "$joined" == "get configmap yenhubs-recovery-operation-lock -n hcce -o json" ]]; then
  [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] || exit 1
  lock_count_file="$STUB_STATE_DIR/restore-lock-get-count"
  lock_count=0
  [[ ! -f "$lock_count_file" ]] || lock_count="$(cat "$lock_count_file")"
  lock_count=$((lock_count + 1))
  printf '%s' "$lock_count" >"$lock_count_file"
  lock_uid="$(cat "$STUB_STATE_DIR/restore-lock-uid" 2>/dev/null || printf restore-lock-uid)"
  if [[ "${STUB_MODE:-}" == "restore-lock-replaced-after-quiesce" &&
        ! -e "$STUB_STATE_DIR/lock-replaced-after-quiesce" ]]; then
    all_zero=true
    for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
      if [[ ! -f "$STUB_STATE_DIR/replicas-$writer" ||
            "$(cat "$STUB_STATE_DIR/replicas-$writer")" != 0 ]]; then
        all_zero=false
      fi
    done
    if [[ "$all_zero" == true ]]; then
      lock_uid=replacement-lock-uid
      printf '%s' "$lock_uid" >"$STUB_STATE_DIR/restore-lock-uid"
      : >"$STUB_STATE_DIR/lock-replaced-after-quiesce"
    fi
  fi
  lock_rv="$(cat "$STUB_STATE_DIR/restore-lock-rv" 2>/dev/null || printf lock-rv-1)"
  lock_owner="$(yaml_field 'yenhubs.org/recovery-owner:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_operation_id="$(yaml_field 'yenhubs.org/operation-id:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_token="$(yaml_field 'yenhubs.org/recovery-token:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_namespace_uid="$(yaml_field 'yenhubs.org/namespace-uid:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_pvc_uid="$(yaml_field 'yenhubs.org/pvc-uid:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_stamp="$(yaml_field 'yenhubs.org/checkpoint-stamp:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_dump="$(yaml_field 'yenhubs.org/dump-sha256:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_storage="$(yaml_field 'yenhubs.org/storage-sha256:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_pre_epoch="$(yaml_field 'yenhubs.org/pre-fence-epoch:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_target_epoch="$(yaml_field 'yenhubs.org/restore-fence-epoch:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_inventory="$(yaml_field 'yenhubs.org/deployment-inventory-sha256:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_state="$(yaml_field 'yenhubs.org/recovery-state:' "$STUB_STATE_DIR/restore-lock.yaml")"
  jq -cn --arg uid "$lock_uid" --arg rv "$lock_rv" --arg owner "$lock_owner" \
    --arg operation_id "$lock_operation_id" --arg token "$lock_token" \
    --arg namespace_uid "$lock_namespace_uid" --arg pvc_uid "$lock_pvc_uid" \
    --arg stamp "$lock_stamp" --arg dump "$lock_dump" --arg storage "$lock_storage" \
    --arg pre_epoch "$lock_pre_epoch" --arg target_epoch "$lock_target_epoch" \
    --arg inventory "$lock_inventory" --arg state "$lock_state" \
    '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"yenhubs-recovery-operation-lock",namespace:"hcce",uid:$uid,resourceVersion:$rv,labels:{"yenhubs.org/recovery-owner":$owner},annotations:({"yenhubs.org/operation-id":$operation_id,"yenhubs.org/recovery-token":$token,"yenhubs.org/namespace-uid":$namespace_uid,"yenhubs.org/pvc-uid":$pvc_uid,"yenhubs.org/checkpoint-stamp":$stamp,"yenhubs.org/dump-sha256":$dump,"yenhubs.org/storage-sha256":$storage} + if $pre_epoch == "" then {} else {"yenhubs.org/pre-fence-epoch":$pre_epoch,"yenhubs.org/restore-fence-epoch":$target_epoch,"yenhubs.org/deployment-inventory-sha256":$inventory} end + if $state == "" then {} else {"yenhubs.org/recovery-state":$state} end)},immutable:true}'
  exit 0
fi
if [[ "$joined" == get\ pod\ reticulum-0*metadata.uid* ]]; then printf 'reticulum-pod-uid'; exit 0; fi
if [[ "$joined" == get\ pod\ pgsql-0*metadata.uid* ]]; then printf 'pgsql-pod-uid'; exit 0; fi
if [[ "$joined" == rollout\ status\ * ]]; then
  if [[ "${STUB_MODE:-}" == "rollout-fail" && "$joined" == *"deployment/reticulum"* ]]; then exit 1; fi
  if [[ "${STUB_MODE:-}" == "resume-ret-fail" && "$joined" == *"deployment/reticulum"* &&
        -f "$STUB_STATE_DIR/replicas-reticulum" &&
        "$(cat "$STUB_STATE_DIR/replicas-reticulum")" == "1" ]]; then exit 1; fi
  if [[ "${STUB_MODE:-}" == "finalizer-failclose-drift" &&
        "$joined" == *"deployment/reticulum"* &&
        -f "$STUB_STATE_DIR/replicas-reticulum" &&
        "$(cat "$STUB_STATE_DIR/replicas-reticulum")" == "1" &&
        ! -e "$STUB_STATE_DIR/finalizer-failclose-triggered" ]]; then
    : >"$STUB_STATE_DIR/finalizer-failclose-triggered"
    rm -f -- "$STUB_STATE_DIR/restore-lock.yaml" \
      "$STUB_STATE_DIR/restore-lock-uid" "$STUB_STATE_DIR/restore-lock-rv"
    printf '%s' replacement-runner-role-uid >"$STUB_STATE_DIR/runner-role-uid"
    printf '%s' active >"$STUB_STATE_DIR/runner-role-phase"
    printf '%s' '[{"apiGroups":[""],"resources":["pods","secrets"],"verbs":["*"]}]' \
      >"$STUB_STATE_DIR/runner-role-rules.json"
    exit 1
  fi
  if [[ "${STUB_MODE:-}" == "runner-reappears-before-parent" &&
        "$joined" == *"deployment/coturn"* &&
        -f "$STUB_STATE_DIR/replicas-coturn" &&
        "$(cat "$STUB_STATE_DIR/replicas-coturn")" == "1" ]]; then
    : >"$STUB_STATE_DIR/runner-reappear"
  fi
  if [[ "${STUB_MODE:-}" == "checkpoint-process-local-adjacent-drift" &&
        "$joined" == *"deployment/coturn"* &&
        -f "$STUB_STATE_DIR/replicas-coturn" &&
        "$(cat "$STUB_STATE_DIR/replicas-coturn")" == "1" ]]; then
    : >"$STUB_STATE_DIR/checkpoint-adjacent-drift"
  fi
  if [[ "${STUB_MODE:-}" == "runner-transient-during-ret" &&
        "$joined" == *"deployment/reticulum"* &&
        -f "$STUB_STATE_DIR/replicas-reticulum" &&
        "$(cat "$STUB_STATE_DIR/replicas-reticulum")" == "1" ]]; then
    : >"$STUB_STATE_DIR/runner-reappear"
    sleep 0.05
    rm -f -- "$STUB_STATE_DIR/runner-reappear"
  fi
  exit 0
fi
if [[ "$joined" == get\ pod\ *"-l app=pgsql"*"jsonpath"* ]]; then printf 'pgsql-0'; exit 0; fi
if [[ "$joined" == get\ pod\ *"-l app=reticulum"*"jsonpath"* ]]; then printf 'reticulum-0'; exit 0; fi
if [[ "$joined" == get\ pod\ *"-l app=pgsql"*"-o json"* ]]; then
  if [[ "${STUB_MODE:-}" == "rogue-pgsql-owner" ]]; then
    printf '%s' '{"items":[{"metadata":{"name":"pgsql-0","uid":"pgsql-pod-uid","labels":{"app":"pgsql"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"rogue-rs","uid":"rogue-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[]}}]}'
  else
    printf '%s' '{"items":[{"metadata":{"name":"pgsql-0","uid":"pgsql-pod-uid","labels":{"app":"pgsql"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"pgsql-rs","uid":"pgsql-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[]}}]}'
  fi
  exit 0
fi
if [[ "$joined" == get\ pod\ *"-l app=reticulum"*"-o json"* ]]; then
  case "${STUB_MODE:-}" in
    backup-decoy-mount)
      printf '%s' '{"items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"reticulum-rs","uid":"reticulum-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[{"name":"durable","persistentVolumeClaim":{"claimName":"ret-pvc"}},{"name":"decoy","emptyDir":{}}],"containers":[{"name":"reticulum","volumeMounts":[{"name":"durable","mountPath":"/not-storage"},{"name":"decoy","mountPath":"/storage"}]}]}}]}'
      ;;
    backup-other-container)
      printf '%s' '{"items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"reticulum-rs","uid":"reticulum-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[{"name":"durable","persistentVolumeClaim":{"claimName":"ret-pvc"}}],"containers":[{"name":"reticulum","volumeMounts":[{"name":"durable","mountPath":"/storage"}]},{"name":"sidecar","volumeMounts":[{"name":"durable","mountPath":"/mirror"}]}]}}]}'
      ;;
    backup-other-claim)
      printf '%s' '{"items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"reticulum-rs","uid":"reticulum-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[{"name":"durable","persistentVolumeClaim":{"claimName":"ret-pvc"}},{"name":"other","persistentVolumeClaim":{"claimName":"other-pvc"}}],"containers":[{"name":"reticulum","volumeMounts":[{"name":"durable","mountPath":"/ret-pvc"},{"name":"other","mountPath":"/storage"}]}]}}]}'
      ;;
    backup-subpath)
      printf '%s' '{"items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"reticulum-rs","uid":"reticulum-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[{"name":"durable","persistentVolumeClaim":{"claimName":"ret-pvc"}}],"containers":[{"name":"reticulum","volumeMounts":[{"name":"durable","mountPath":"/storage","subPath":"owned"}]}]}}]}'
      ;;
    *)
      printf '%s' '{"items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"reticulum-rs","uid":"reticulum-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[{"name":"durable","persistentVolumeClaim":{"claimName":"ret-pvc"}}],"containers":[{"name":"reticulum","volumeMounts":[{"name":"durable","mountPath":"/storage"}]}]}}]}'
      ;;
  esac
  exit 0
fi
if [[ "$joined" == get\ pod\ ret-storage-*"-o json" ]]; then
  [[ -f "$STUB_STATE_DIR/pod-created" && -f "$STUB_STATE_DIR/applied.yaml" ]] || exit 1
  requested_pod="${3:-}"
  stored_pod="$(cat "$STUB_STATE_DIR/pod-name")"
  [[ "$requested_pod" == "$stored_pod" ]] || exit 1
  count_file="$STUB_STATE_DIR/restore-pod-get-count"
  count=0
  [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
  count=$((count + 1))
  printf '%s' "$count" >"$count_file"
  restore_uid="$(cat "$STUB_STATE_DIR/pod-uid")"
  if [[ ( "${STUB_MODE:-}" == "restore-pod-replaced" && "$count" -ge 3 ) ||
        ( "${STUB_MODE:-}" == "stale-helper-replaced" && "$count" -ge 2 ) ]]; then
    restore_uid="replacement-pod-uid"
  fi
  owner_role="$(yaml_field 'yenhubs.org/recovery-owner:' "$STUB_STATE_DIR/applied.yaml")"
  operation_id="$(yaml_field 'yenhubs.org/operation-id:' "$STUB_STATE_DIR/applied.yaml")"
  lock_uid="$(yaml_field 'yenhubs.org/operation-lock-uid:' "$STUB_STATE_DIR/applied.yaml")"
  owner_token="$(yaml_field 'yenhubs.org/operation-token:' "$STUB_STATE_DIR/applied.yaml")"
  helper_image="$(yaml_field '^[[:space:]]+image:' "$STUB_STATE_DIR/applied.yaml")"
  read_only="$(yaml_field '^[[:space:]]+readOnly:' "$STUB_STATE_DIR/applied.yaml")"
  helper_json="$(jq -cn --arg name "$stored_pod" --arg uid "$restore_uid" \
    --arg role "$owner_role" --arg operation_id "$operation_id" \
    --arg lock_uid "$lock_uid" --arg token "$owner_token" --arg image "$helper_image" \
    --argjson read_only "$read_only" '
    {apiVersion:"v1",kind:"Pod",metadata:{name:$name,uid:$uid,namespace:"hcce",
      labels:{"yenhubs.org/recovery-owner":$role,"yenhubs.org/operation-id":$operation_id},
      annotations:{"yenhubs.org/operation-lock-uid":$lock_uid,"yenhubs.org/operation-token":$token}},
      spec:{automountServiceAccountToken:false,enableServiceLinks:false,restartPolicy:"Never",
        activeDeadlineSeconds:3600,
        securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,fsGroup:1000,
          fsGroupChangePolicy:"OnRootMismatch",seccompProfile:{type:"RuntimeDefault"}},
        volumes:[{name:"storage",persistentVolumeClaim:{claimName:"ret-pvc",readOnly:$read_only}}],
        containers:[{name:"helper",image:$image,command:["sh","-c","sleep 3600"],
          securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,
            capabilities:{drop:["ALL"]}},
          volumeMounts:[{name:"storage",mountPath:"/storage",readOnly:$read_only}]}]}}
  ')"
  if [[ "${STUB_MODE:-}" == "restore-pod-decoy" ]]; then
    jq -c '.spec.volumes += [{name:"decoy",emptyDir:{}}] | .spec.containers[0].volumeMounts = [{name:"storage",mountPath:"/other",readOnly:false},{name:"decoy",mountPath:"/storage",readOnly:false}]' <<<"$helper_json"
  elif [[ "${STUB_MODE:-}" == "restore-pod-extra-volume" ]]; then
    jq -c '.spec.volumes += [{name:"decoy",emptyDir:{}}] | .spec.containers[0].volumeMounts += [{name:"decoy",mountPath:"/tmp/decoy",readOnly:false}]' <<<"$helper_json"
  else
    printf '%s' "$helper_json"
  fi
  exit 0
fi
if [[ "$joined" == "get pod -n hcce -o json" ||
      "$joined" == "get pod -n hcce-bot-runners -o json" ]]; then
  target_namespace="${4:-}"
  pods_json='{"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"100"},"items":[]}'
  if [[ "$target_namespace" == hcce && -e "$STUB_STATE_DIR/pod-created" ]]; then
    count_file="$STUB_STATE_DIR/consumer-count"; count=0; [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"; count=$((count + 1)); printf '%s' "$count" >"$count_file"
    pod_name="$(cat "$STUB_STATE_DIR/pod-name")"
    if [[ "${STUB_MODE:-}" == "extra-consumer" ||
          "${STUB_MODE:-}" == "backup-extra-consumer" ||
          ( "${STUB_MODE:-}" == "monitor-extra" && "$count" -ge 3 ) ||
          ( "${STUB_MODE:-}" == "backup-monitor-extra" && "$count" -ge 3 ) ]]; then
      pods_json="$(jq -cn --arg pod "$pod_name" '{apiVersion:"v1",kind:"PodList",items:[{metadata:{name:$pod,uid:"restore-pod-uid",labels:{}},spec:{volumes:[{persistentVolumeClaim:{claimName:"ret-pvc"}}]}},{metadata:{name:"rogue",uid:"rogue-pod-uid",labels:{}},spec:{volumes:[{persistentVolumeClaim:{claimName:"ret-pvc"}}]}}]}')"
    else
      pods_json="$(jq -cn --arg pod "$pod_name" '{apiVersion:"v1",kind:"PodList",items:[{metadata:{name:$pod,uid:"restore-pod-uid",labels:{}},spec:{volumes:[{persistentVolumeClaim:{claimName:"ret-pvc"}}]}}]}')"
    fi
  elif [[ "$target_namespace" == hcce ]]; then
    if [[ "${STUB_OPERATION:-}" == "storage-backup" ]]; then
      count_file="$STUB_STATE_DIR/consumer-count"; count=0; [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"; count=$((count + 1)); printf '%s' "$count" >"$count_file"
      if [[ "${STUB_MODE:-}" == "backup-extra-consumer" ||
            ( "${STUB_MODE:-}" == "backup-monitor-extra" && "$count" -ge 3 ) ]]; then
        pods_json='{"apiVersion":"v1","kind":"PodList","items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"}},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}},{"metadata":{"name":"rogue","uid":"rogue-pod-uid","labels":{}},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}}]}'
      else
        pods_json='{"apiVersion":"v1","kind":"PodList","items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"}},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}}]}'
      fi
    else
      pods_json='{"apiVersion":"v1","kind":"PodList","items":[]}'
    fi
  fi
  runner_count_file="$STUB_STATE_DIR/runner-list-count"
  runner_count=0
  [[ ! -f "$runner_count_file" ]] || runner_count="$(cat "$runner_count_file")"
  runner_count=$((runner_count + 1))
  printf '%s' "$runner_count" >"$runner_count_file"
  runner_labels=''
  runner_service_account=''
  case "${STUB_MODE:-}" in
    runner-residual|runner-timeout)
      runner_labels='{"app":"bot-runner","yenhubs.org/managed-by":"bot-orchestrator"}'
      ;;
    runner-app-only)
      runner_labels='{"app":"bot-runner"}'
      ;;
    runner-managed-only)
      runner_labels='{"yenhubs.org/managed-by":"bot-orchestrator"}'
      ;;
    runner-component-only)
      runner_labels='{"component":"bot-runner"}'
      ;;
    runner-parent-service-account)
      if [[ "$target_namespace" == hcce ]]; then
        runner_labels='{}'
        runner_service_account=bot-orchestrator
      fi
      ;;
    runner-namespace-unlabeled)
      if [[ "$target_namespace" == hcce-bot-runners ]]; then
        runner_labels='{}'
        runner_service_account=default
      fi
      ;;
    runner-reappears)
      if [[ "$runner_count" -ge 2 ]]; then
        runner_labels='{"app":"bot-runner","yenhubs.org/managed-by":"bot-orchestrator"}'
      fi
      ;;
    runner-reappears-during-storage|runner-reappears-before-parent|runner-transient-during-ret)
      if [[ -e "$STUB_STATE_DIR/runner-reappear" ]]; then
        runner_labels='{"app":"bot-runner","yenhubs.org/managed-by":"bot-orchestrator"}'
      fi
      ;;
    checkpoint-orphan-runner|finalizer-failclose-drift)
      if [[ "$target_namespace" == hcce-bot-runners &&
            ! -e "$STUB_STATE_DIR/checkpoint-orphan-runner-deleted" ]]; then
        runner_labels='{"app":"bot-runner","yenhubs.org/managed-by":"bot-orchestrator"}'
      fi
      ;;
  esac
  if [[ -n "$runner_labels" ]]; then
    pods_json="$(jq -c --argjson labels "$runner_labels" \
      --arg service_account "$runner_service_account" '
      .items += [{metadata:{name:"bot-runner-fixture",uid:"runner-pod-uid",labels:$labels},
        spec:({volumes:[]} + if $service_account == "" then {} else
          {serviceAccountName:$service_account} end)}]
    ' <<<"$pods_json")"
  fi
  pods_json="$(jq -c --arg namespace "$target_namespace" '
    .apiVersion = "v1" | .kind = "PodList" |
    .metadata.resourceVersion = "100" |
    .items |= map(.metadata.namespace = $namespace | .metadata.resourceVersion = "101")
  ' <<<"$pods_json")"
  printf '%s' "$pods_json"
  exit 0
fi
if [[ "$joined" == get\ --raw\ /api/v1/namespaces/*/pods\?* ]]; then
  raw_path="${3:-}"
  [[ "$raw_path" == *"allowWatchBookmarks=true"* &&
     "$raw_path" == *"resourceVersion="* &&
     "$raw_path" != *"resourceVersionMatch="* &&
     "$raw_path" != *"sendInitialEvents="* ]] || exit 1
  watch_namespace="${raw_path#/api/v1/namespaces/}"
  watch_namespace="${watch_namespace%%/pods\?*}"
  [[ "$watch_namespace" == hcce || "$watch_namespace" == hcce-bot-runners ]] || exit 1
  watch_count_file="$STUB_STATE_DIR/runner-watch-count-$watch_namespace"
  watch_count=0
  [[ ! -f "$watch_count_file" ]] || watch_count="$(cat "$watch_count_file")"
  watch_count=$((watch_count + 1))
  printf '%s' "$watch_count" >"$watch_count_file"
  if [[ "$raw_path" == *"timeoutSeconds=65"* ]]; then
    final_count_file="$STUB_STATE_DIR/runner-final-watch-count-$watch_namespace"
    final_count=0
    [[ ! -f "$final_count_file" ]] || final_count="$(cat "$final_count_file")"
    printf '%s' "$((final_count + 1))" >"$final_count_file"
  fi
  sleep 0.01
  if [[ "${STUB_MODE:-}" == runner-watch-fails-before-event ]]; then
    exit 1
  fi
  emit_runner_event=false
  if [[ ( ( "${STUB_MODE:-}" == runner-watch-transient &&
            "$watch_namespace" == hcce-bot-runners ) ||
          ( "${STUB_MODE:-}" == runner-watch-parent-service-account &&
            "$watch_namespace" == hcce ) ||
          ( "${STUB_MODE:-}" == runner-watch-runner-unlabeled &&
            "$watch_namespace" == hcce-bot-runners ) ||
          ( "${STUB_MODE:-}" == runner-watch-component-only &&
            "$watch_namespace" == hcce ) ) &&
        ! -e "$STUB_STATE_DIR/runner-watch-transient-emitted" ]]; then
    : >"$STUB_STATE_DIR/runner-watch-transient-emitted"
    emit_runner_event=true
  elif [[ "${STUB_MODE:-}" == runner-watch-stop-gap-transient &&
          "$raw_path" == *"timeoutSeconds=65"* &&
          ! -e "$STUB_STATE_DIR/runner-watch-transient-emitted" ]]; then
    : >"$STUB_STATE_DIR/runner-watch-transient-emitted"
    emit_runner_event=true
  elif [[ ( "${STUB_MODE:-}" == runner-reappears-during-storage ||
             "${STUB_MODE:-}" == runner-reappears-before-parent ||
             "${STUB_MODE:-}" == runner-transient-during-ret ) &&
           -e "$STUB_STATE_DIR/runner-reappear" &&
           ! -e "$STUB_STATE_DIR/runner-watch-event-$watch_namespace" ]]; then
    : >"$STUB_STATE_DIR/runner-watch-event-$watch_namespace"
    emit_runner_event=true
  fi
  if [[ "$emit_runner_event" == true ]]; then
    event_labels='{"app":"bot-runner"}'
    event_service_account=default
    if [[ "${STUB_MODE:-}" == runner-watch-parent-service-account ]]; then
      event_labels='{}'
      event_service_account=bot-orchestrator
    elif [[ "${STUB_MODE:-}" == runner-watch-runner-unlabeled ]]; then
      event_labels='{}'
      event_service_account=default
    elif [[ "${STUB_MODE:-}" == runner-watch-component-only ]]; then
      event_labels='{"component":"bot-runner"}'
      event_service_account=default
    fi
    jq -cn --arg namespace "$watch_namespace" --argjson labels "$event_labels" \
      --arg service_account "$event_service_account" '
      {type:"ADDED",object:{apiVersion:"v1",kind:"Pod",metadata:{
        name:"bot-runner-transient",namespace:$namespace,uid:"runner-transient-uid",
        resourceVersion:"102",labels:$labels},spec:{serviceAccountName:$service_account}}},
      {type:"DELETED",object:{apiVersion:"v1",kind:"Pod",metadata:{
        name:"bot-runner-transient",namespace:$namespace,uid:"runner-transient-uid",
        resourceVersion:"103",labels:$labels},spec:{serviceAccountName:$service_account}}}
    '
  else
    jq -cn '{type:"BOOKMARK",object:{metadata:{resourceVersion:"101",annotations:{
      "k8s.io/initial-events-end":"true"}}}}'
  fi
  exit 0
fi
if [[ "$joined" == get\ networkpolicy\ *"-o json" && "$joined" != "get networkpolicy -n hcce -o json" ]]; then
  [[ -f "$STUB_STATE_DIR/network-policy.yaml" ]] || exit 1
  requested_policy="${3:-}"
  stored_policy="$(cat "$STUB_STATE_DIR/network-policy-name")"
  [[ "$requested_policy" == "$stored_policy" ]] || exit 1
  policy_uid="$(cat "$STUB_STATE_DIR/network-policy-uid")"
  owner_role="$(yaml_field 'yenhubs.org/recovery-owner:' "$STUB_STATE_DIR/network-policy.yaml")"
  operation_id="$(yaml_field 'yenhubs.org/operation-id:' "$STUB_STATE_DIR/network-policy.yaml")"
  lock_uid="$(yaml_field 'yenhubs.org/operation-lock-uid:' "$STUB_STATE_DIR/network-policy.yaml")"
  owner_token="$(yaml_field 'yenhubs.org/operation-token:' "$STUB_STATE_DIR/network-policy.yaml")"
  jq -cn --arg name "$stored_policy" --arg uid "$policy_uid" --arg role "$owner_role" \
    --arg operation_id "$operation_id" --arg lock_uid "$lock_uid" --arg token "$owner_token" '
    {apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",
      metadata:{name:$name,uid:$uid,namespace:"hcce",
        labels:{"yenhubs.org/recovery-owner":$role,"yenhubs.org/operation-id":$operation_id},
        annotations:{"yenhubs.org/operation-lock-uid":$lock_uid,"yenhubs.org/operation-token":$token}},
      spec:{podSelector:{matchLabels:{"yenhubs.org/operation-id":$operation_id}},
        policyTypes:["Ingress","Egress"],ingress:[],egress:[]}}
  '
  exit 0
fi
if [[ "$joined" == "get networkpolicy -n hcce -o json" ]]; then
  if [[ -f "$STUB_STATE_DIR/network-policy.yaml" ]]; then
    policy_name="$(cat "$STUB_STATE_DIR/network-policy-name")"
    jq -cn --arg name "$policy_name" '{items:[{metadata:{name:$name}}]}'
  else
    printf '%s' '{"items":[]}'
  fi
  exit 0
fi
if [[ "$joined" == "get deployment -n hcce -o json" ]]; then cat "$STUB_DEPLOYMENTS_JSON"; exit 0; fi
if [[ "$joined" == "get replicaset -n hcce -o json" ]]; then
  jq -cn '
    {apiVersion:"v1",kind:"ReplicaSetList",items:
      ["reticulum","pgbouncer","pgbouncer-t","bot-orchestrator","coturn"] |
      map({apiVersion:"apps/v1",kind:"ReplicaSet",metadata:{name:(.+"-rs"),
        namespace:"hcce",uid:(.+"-rs-uid"),ownerReferences:[{
          apiVersion:"apps/v1",kind:"Deployment",name:.,uid:("uid-"+.),controller:true}]}})}
  '
  exit 0
fi
if [[ "$joined" == get\ replicaset\ *"-o json" ]]; then
  replica_set="${3:-}"
  deployment="${replica_set%-rs}"
  jq -cn --arg rs "$replica_set" --arg deployment "$deployment" \
    '{apiVersion:"apps/v1",kind:"ReplicaSet",metadata:{name:$rs,namespace:"hcce",uid:($rs+"-uid"),ownerReferences:[{apiVersion:"apps/v1",kind:"Deployment",name:$deployment,uid:("uid-"+$deployment),controller:true}]}}'
  exit 0
fi
if [[ "$joined" == get\ deployment\ *"jsonpath={.spec.replicas}"* ]]; then
  deployment="${3:-}"
  replica_file="$STUB_STATE_DIR/replicas-$deployment"
  if [[ -f "$replica_file" ]]; then cat "$replica_file"; else printf '1'; fi
  exit 0
fi
if [[ "$joined" == get\ deployment\ *"-o json" ]]; then
  deployment="${3:-}"
  replica_file="$STUB_STATE_DIR/replicas-$deployment"
  if [[ -f "$replica_file" ]]; then replicas="$(cat "$replica_file")"; else replicas=1; fi
  rv_file="$STUB_STATE_DIR/rv-$deployment"
  if [[ -f "$rv_file" ]]; then rv_number="$(cat "$rv_file")"; else rv_number=1; fi
  recovery_phase=active
  recovery_phase_override=false
  if [[ -f "$STUB_STATE_DIR/recovery-phase" ]]; then
    recovery_phase="$(cat "$STUB_STATE_DIR/recovery-phase")"
    recovery_phase_override=true
  fi
  recovery_epoch="$LIVE_RUNNER_EPOCH"
  recovery_epoch_override=false
  if [[ -f "$STUB_STATE_DIR/recovery-epoch" ]]; then
    recovery_epoch="$(cat "$STUB_STATE_DIR/recovery-epoch")"
    recovery_epoch_override=true
  fi
  deployment_json="$(jq -ce --arg name "$deployment" --arg rv "rv-$deployment-$rv_number" \
    --argjson replicas "$replicas" --arg recovery_phase "$recovery_phase" \
    --argjson recovery_phase_override "$recovery_phase_override" \
    --arg recovery_epoch "$recovery_epoch" \
    --argjson recovery_epoch_override "$recovery_epoch_override" '
    [.items[] | select(.metadata.name == $name)] | select(length == 1) | .[0] |
    .apiVersion = "apps/v1" | .kind = "Deployment" |
    .metadata.namespace = "hcce" | .metadata.resourceVersion = $rv |
    .metadata.generation = 1 |
    if $recovery_phase_override then
      .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] = $recovery_phase
    else . end |
    .spec.replicas = $replicas | .spec.strategy = (.spec.strategy // {}) |
    .spec.template.metadata = ((.spec.template.metadata // {}) + {labels:{app:$name}}) |
    if $recovery_epoch_override then
      .spec.template.metadata.annotations["yenhubs.org/bot-runner-recovery-epoch"] = $recovery_epoch
    else . end |
    .status = {observedGeneration:1,replicas:$replicas,readyReplicas:$replicas,
      availableReplicas:$replicas,updatedReplicas:$replicas,unavailableReplicas:0}
  ' "$STUB_DEPLOYMENTS_JSON")"
  if [[ "${STUB_MODE:-}" == epoch-reticulum-only &&
        "$deployment" == bot-orchestrator ]] ||
     [[ "${STUB_MODE:-}" == epoch-parent-only &&
        "$deployment" == reticulum ]]; then
    deployment_json="$(jq -c '
      del(.spec.template.metadata.annotations[
        "yenhubs.org/bot-runner-recovery-epoch"
      ])
    ' <<<"$deployment_json")"
  fi
  if [[ ( "${STUB_MODE:-}" == checkpoint-process-local-mode-drift &&
        "$deployment" == bot-orchestrator &&
        -e "$STUB_STATE_DIR/checkpoint-backup-complete" ) ||
        ( "${STUB_MODE:-}" == checkpoint-process-local-adjacent-drift &&
          "$deployment" == bot-orchestrator &&
          -e "$STUB_STATE_DIR/checkpoint-adjacent-drift" ) ]]; then
    deployment_json="$(jq -c '
      .spec.template.spec.containers[0].env += [{
        name:"ORCHESTRATOR_POD_UID",value:"late-partial-binding"
      }]
    ' <<<"$deployment_json")"
  fi
  if [[ "${STUB_MODE:-}" == finalizer-failclose-drift &&
        -e "$STUB_STATE_DIR/finalizer-failclose-triggered" &&
        "$deployment" == pgbouncer ]]; then
    deployment_json="$(jq -c '
      .metadata.uid = "replacement-uid-pgbouncer" |
      .spec.selector.matchLabels.app = "replacement-pgbouncer" |
      .spec.template.metadata.labels.app = "replacement-pgbouncer"
    ' <<<"$deployment_json")"
  fi
  printf '%s' "$deployment_json"
  exit 0
fi
if [[ "$joined" == get\ pod\ *"-o name"* ]]; then
  if [[ "$joined" == *"-l app="* ]]; then
    if [[ ! -e "$STUB_STATE_DIR/waited" ]]; then
      printf 'pod/workload-0\n'
    elif [[ "${STUB_MODE:-}" == residual ]] ||
         [[ "${STUB_MODE:-}" == checkpoint-parent-wait-failure &&
            "$joined" == *"-l app=bot-orchestrator"* ]]; then
      printf 'pod/workload-still-running\n'
    fi
    exit 0
  fi
fi
if [[ "$joined" == wait\ --for=delete\ * ]]; then
  if [[ "${STUB_MODE:-}" == runner-timeout && "$joined" == *"pod/bot-runner-"* ]]; then
    exit 1
  fi
  [[ "${STUB_MODE:-}" != timeout ]] || exit 1
  : >"$STUB_STATE_DIR/waited"
  exit 0
fi
if [[ "$joined" == wait\ --for=condition=Ready\ * ]]; then exit 0; fi
if [[ "$joined" == scale\ deployment\ * ]]; then
  deployment="${3:-}"
  current_expected="" rv_expected="" replicas=""
  for argument in "$@"; do
    case "$argument" in
      --current-replicas=*) current_expected="${argument#*=}" ;;
      --resource-version=*) rv_expected="${argument#*=}" ;;
      --replicas=*) replicas="${argument#*=}" ;;
    esac
  done
  replica_file="$STUB_STATE_DIR/replicas-$deployment"
  rv_file="$STUB_STATE_DIR/rv-$deployment"
  current=1; [[ ! -f "$replica_file" ]] || current="$(cat "$replica_file")"
  rv_number=1; [[ ! -f "$rv_file" ]] || rv_number="$(cat "$rv_file")"
  [[ "$current_expected" == "$current" && "$rv_expected" == "rv-$deployment-$rv_number" && "$replicas" =~ ^[0-9]+$ ]] || exit 1
  printf '%s' "$replicas" >"$replica_file"
  printf '%s' "$((rv_number + 1))" >"$rv_file"
  if [[ "${STUB_MODE:-}" == checkpoint-local-input-mutation &&
        "$deployment" == bot-orchestrator && "$replicas" == 0 ]]; then
    [[ -n "${STUB_MUTABLE_VALUES_PATH:-}" &&
       -n "${STUB_MUTABLE_MANIFEST_PATH:-}" ]] || exit 1
    printf '%s\n' 'invalid: [' >"$STUB_MUTABLE_VALUES_PATH"
    printf '%s\n' 'tampered-after-fence' >"$STUB_MUTABLE_MANIFEST_PATH"
  fi
  exit 0
fi
if [[ "$joined" == "replace -f - -o json" ]]; then
  replace_payload="$(mktemp "$STUB_STATE_DIR/replace-payload.XXXXXX")"
  trap 'rm -f -- "$replace_payload"' EXIT
  cat >"$replace_payload"
  if [[ "${STUB_MODE:-}" == replace-payload-concurrency ]]; then
    replace_kind="$(jq -er '.kind' "$replace_payload")"
    : >"$STUB_STATE_DIR/replace-ready-$replace_kind"
    for _ in {1..200}; do
      [[ -e "$STUB_STATE_DIR/replace-ready-Lease" &&
         -e "$STUB_STATE_DIR/replace-ready-Role" ]] && break
      sleep 0.01
    done
    [[ -e "$STUB_STATE_DIR/replace-ready-Lease" &&
       -e "$STUB_STATE_DIR/replace-ready-Role" ]] || exit 1
  fi
  if [[ "$(jq -r '.kind // ""' "$replace_payload")" == Lease ]]; then
    [[ -f "$STUB_STATE_DIR/serialization-lease.json" ]] || exit 1
    [[ "${STUB_MODE:-}" != lease-cas-conflict ]] || exit 1
    current_uid="$(jq -er '.metadata.uid' "$STUB_STATE_DIR/serialization-lease.json")"
    current_rv="$(jq -er '.metadata.resourceVersion' "$STUB_STATE_DIR/serialization-lease.json")"
    [[ "$(jq -er '.metadata.uid' "$replace_payload")" == "$current_uid" &&
       "$(jq -er '.metadata.resourceVersion' "$replace_payload")" == "$current_rv" ]] || exit 1
    lease_rv_number=1
    [[ ! "$current_rv" =~ ^lease-rv-([0-9]+)$ ]] || lease_rv_number="${BASH_REMATCH[1]}"
    lease_rv_number=$((lease_rv_number + 1))
    jq -c --arg uid "$current_uid" --arg rv "lease-rv-$lease_rv_number" \
      '.metadata.uid = $uid | .metadata.resourceVersion = $rv' \
      "$replace_payload" >"$STUB_STATE_DIR/serialization-lease.next"
    mv "$STUB_STATE_DIR/serialization-lease.next" \
      "$STUB_STATE_DIR/serialization-lease.json"
    cat "$STUB_STATE_DIR/serialization-lease.json"
    exit 0
  fi
  if [[ "$(jq -r '.kind // ""' "$replace_payload")" == Role ]]; then
    if [[ "${STUB_MODE:-}" == restore-role-replace-retry &&
          ! -e "$STUB_STATE_DIR/role-replace-failed-once" ]]; then
      : >"$STUB_STATE_DIR/role-replace-failed-once"
      exit 1
    fi
    current_role_uid=runner-role-uid
    current_role_rv_number=1
    [[ ! -f "$STUB_STATE_DIR/runner-role-uid" ]] || current_role_uid="$(cat "$STUB_STATE_DIR/runner-role-uid")"
    [[ ! -f "$STUB_STATE_DIR/runner-role-rv" ]] || current_role_rv_number="$(cat "$STUB_STATE_DIR/runner-role-rv")"
    [[ "$(jq -er '.metadata.uid' "$replace_payload")" == "$current_role_uid" &&
       "$(jq -er '.metadata.resourceVersion' "$replace_payload")" == \
         "runner-role-rv-$current_role_rv_number" ]] || exit 1
    current_role_rv_number=$((current_role_rv_number + 1))
    printf '%s' "$current_role_uid" >"$STUB_STATE_DIR/runner-role-uid"
    printf '%s' "$current_role_rv_number" >"$STUB_STATE_DIR/runner-role-rv"
    jq -c '.rules' "$replace_payload" >"$STUB_STATE_DIR/runner-role-rules.json"
    jq -r '.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"]' \
      "$replace_payload" >"$STUB_STATE_DIR/runner-role-phase"
    jq -c --arg rv "runner-role-rv-$current_role_rv_number" \
      '.metadata.resourceVersion = $rv' "$replace_payload"
    exit 0
  fi
  [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] || exit 1
  current_uid="$(cat "$STUB_STATE_DIR/restore-lock-uid")"
  current_rv="$(cat "$STUB_STATE_DIR/restore-lock-rv")"
  [[ "$(jq -er '.metadata.uid' "$replace_payload")" == "$current_uid" &&
     "$(jq -er '.metadata.resourceVersion' "$replace_payload")" == "$current_rv" &&
     "$(jq -er '.metadata.annotations["yenhubs.org/recovery-state"]' "$replace_payload")" == \
       restore-complete-awaiting-reactivation ]] || exit 1
  awk '
    /yenhubs.org\/recovery-state:/ {
      print "    yenhubs.org/recovery-state: \"restore-complete-awaiting-reactivation\""
      next
    }
    {print}
  ' "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
  mv "$STUB_STATE_DIR/restore-lock.next" "$STUB_STATE_DIR/restore-lock.yaml"
  printf '%s' lock-rv-2 >"$STUB_STATE_DIR/restore-lock-rv"
  jq -c '.metadata.resourceVersion = "lock-rv-2"' "$replace_payload"
  exit 0
fi
if [[ "$joined" == "create -f - -o json" ]]; then
  lease_create_payload="$STUB_STATE_DIR/serialization-lease-create.yaml"
  cat >"$lease_create_payload"
  grep -q '^kind: Lease$' "$lease_create_payload" || exit 1
  [[ ! -e "$STUB_STATE_DIR/serialization-lease.json" &&
     "${STUB_MODE:-}" != lease-create-conflict ]] || exit 1
  lease_holder="$(yaml_field 'holderIdentity:' "$lease_create_payload")"
  lease_acquire="$(yaml_field 'acquireTime:' "$lease_create_payload")"
  lease_renew="$(yaml_field 'renewTime:' "$lease_create_payload")"
  lease_transitions="$(yaml_field 'leaseTransitions:' "$lease_create_payload")"
  jq -cn --arg holder "$lease_holder" --arg acquire "$lease_acquire" \
    --arg renew "$lease_renew" --argjson transitions "$lease_transitions" '
    {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
     metadata:{name:"yenhubs-operation-serialization",namespace:"hcce",
       uid:"serialization-lease-uid",resourceVersion:"lease-rv-1",
       labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
     spec:{holderIdentity:$holder,leaseDurationSeconds:120,
       acquireTime:$acquire,renewTime:$renew,leaseTransitions:$transitions}}
  ' >"$STUB_STATE_DIR/serialization-lease.json"
  cat "$STUB_STATE_DIR/serialization-lease.json"
  exit 0
fi
if [[ "$joined" == "create -f -" ]]; then
  create_count_file="$STUB_STATE_DIR/create-count"
  create_count=0; [[ ! -f "$create_count_file" ]] || create_count="$(cat "$create_count_file")"
  create_count=$((create_count + 1)); printf '%s' "$create_count" >"$create_count_file"
  create_payload="$STUB_STATE_DIR/create-payload-$create_count.yaml"
  cat >"$create_payload"
  if grep -q '^kind: ConfigMap$' "$create_payload"; then
    [[ "${STUB_MODE:-}" != "restore-lock-exists" && ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] || exit 1
    cp "$create_payload" "$STUB_STATE_DIR/restore-lock.yaml"
    printf '%s' restore-lock-uid >"$STUB_STATE_DIR/restore-lock-uid"
    printf '%s' lock-rv-1 >"$STUB_STATE_DIR/restore-lock-rv"
  elif grep -q '^kind: NetworkPolicy$' "$create_payload"; then
    [[ ! -e "$STUB_STATE_DIR/network-policy.yaml" ]] || exit 1
    cp "$create_payload" "$STUB_STATE_DIR/network-policy.yaml"
    yaml_field '^[[:space:]]+name:' "$create_payload" >"$STUB_STATE_DIR/network-policy-name"
    printf '%s' network-policy-uid >"$STUB_STATE_DIR/network-policy-uid"
  elif grep -q '^kind: Pod$' "$create_payload"; then
    cp "$create_payload" "$STUB_STATE_DIR/applied.yaml"
    [[ "${STUB_MODE:-}" != "restore-pod-already-exists" ]] || exit 1
    yaml_field '^[[:space:]]+name:' "$create_payload" >"$STUB_STATE_DIR/pod-name"
    printf '%s' restore-pod-uid >"$STUB_STATE_DIR/pod-uid"
    : >"$STUB_STATE_DIR/pod-created"
  else
    exit 1
  fi
  exit 0
fi
if [[ "$joined" == delete\ --raw=*" -f -" ]]; then
  delete_count_file="$STUB_STATE_DIR/delete-count"
  delete_count=0; [[ ! -f "$delete_count_file" ]] || delete_count="$(cat "$delete_count_file")"
  delete_count=$((delete_count + 1)); printf '%s' "$delete_count" >"$delete_count_file"
  delete_payload="$STUB_STATE_DIR/delete-options-$delete_count.json"
  cat >"$delete_payload"
  jq -e '
    (keys | sort) == ["apiVersion","kind","preconditions","propagationPolicy"] and
    .apiVersion == "v1" and .kind == "DeleteOptions" and
    .propagationPolicy == "Foreground" and
    (.preconditions | keys) == ["uid"] and
    (.preconditions.uid | type == "string" and length > 0)
  ' >/dev/null "$delete_payload" || exit 1
  expected_uid="$(jq -r '.preconditions.uid' "$delete_payload")"
  raw_path=""
  for argument in "$@"; do [[ "$argument" != --raw=* ]] || raw_path="${argument#--raw=}"; done
  case "$raw_path" in
    /api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock)
      [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] || exit 1
      current_uid="$(cat "$STUB_STATE_DIR/restore-lock-uid")"
      if [[ "${STUB_MODE:-}" == "restore-lock-replaced-on-release" ]]; then
        current_uid=replacement-lock-uid
        printf '%s' "$current_uid" >"$STUB_STATE_DIR/restore-lock-uid"
      fi
      [[ "$expected_uid" == "$current_uid" ]] || exit 1
      rm -f -- "$STUB_STATE_DIR/restore-lock.yaml" "$STUB_STATE_DIR/restore-lock-uid" "$STUB_STATE_DIR/restore-lock-rv"
      ;;
    /api/v1/namespaces/hcce-bot-runners/pods/bot-runner-fixture)
      [[ "$expected_uid" == runner-pod-uid ]] || exit 1
      : >"$STUB_STATE_DIR/checkpoint-orphan-runner-deleted"
      ;;
    /api/v1/namespaces/hcce/pods/*)
      [[ -f "$STUB_STATE_DIR/pod-created" ]] || exit 1
      current_uid="$(cat "$STUB_STATE_DIR/pod-uid")"
      [[ "$expected_uid" == "$current_uid" ]] || exit 1
      rm -f -- "$STUB_STATE_DIR/pod-created" "$STUB_STATE_DIR/pod-name" "$STUB_STATE_DIR/pod-uid"
      ;;
    /apis/networking.k8s.io/v1/namespaces/hcce/networkpolicies/*)
      [[ -f "$STUB_STATE_DIR/network-policy.yaml" ]] || exit 1
      current_uid="$(cat "$STUB_STATE_DIR/network-policy-uid")"
      [[ "$expected_uid" == "$current_uid" ]] || exit 1
      rm -f -- "$STUB_STATE_DIR/network-policy.yaml" "$STUB_STATE_DIR/network-policy-name" "$STUB_STATE_DIR/network-policy-uid"
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "$joined" == "get deployment,service,ingress,certificate,pvc,networkpolicy,serviceaccount,role,rolebinding -n hcce -o json" ]]; then printf '%s' '{"items":[]}'; exit 0; fi
if [[ "$joined" == "get configmap -n hcce -o json" ]]; then printf '%s' '{"items":[{"metadata":{"name":"fixture-config","namespace":"hcce","uid":"cm-uid","annotations":{"sentinel":"SECRET_SENTINEL"}},"data":{"credential":"SECRET_SENTINEL"},"binaryData":{"certificate":"SECRET_SENTINEL"}}]}'; exit 0; fi
if [[ "$joined" == exec\ * ]]; then
  if [[ "$joined" == exec\ -i\ *"-d retdb -At"* ]]; then
    contract_count_file="$STUB_STATE_DIR/db-contract-count"
    contract_count=0
    [[ ! -f "$contract_count_file" ]] || contract_count="$(cat "$contract_count_file")"
    contract_count=$((contract_count + 1))
    printf '%s' "$contract_count" >"$contract_count_file"
    if [[ "${STUB_MODE:-}" == contract-drift-after && "$contract_count" -ge 2 ]]; then
      cat "$STUB_DRIFTED_DB_CONTRACT"
    else
      cat "$STUB_DB_CONTRACT"
    fi
  elif [[ "$joined" == *pg_dump* ]]; then
    if [[ "${STUB_MODE:-}" == checkpoint-process-local-mode-drift ]]; then
      : >"$STUB_STATE_DIR/checkpoint-backup-complete"
    fi
    cat "$STUB_SQL_PLAIN"
  elif [[ "$joined" == *"count(*) from information_schema.tables"* ]]; then
    case "${STUB_MODE:-}" in zero-db-active) printf '356\n94\n17\n0\n';; zero-db-hubs) printf '356\n94\n0\n1\n';; *) printf '356\n94\n17\n1\n';; esac
  elif [[ "$joined" == *"select count(*) from ret0.owned_files"* ]]; then case "${STUB_MODE:-}" in zero-db-active) printf '0\n';; duplicate-db-uuids) printf '2\n';; *) printf '1\n';; esac
  elif [[ "$joined" == *"select owned_file_uuid from ret0.owned_files"* ]]; then
    uuid_count_file="$STUB_STATE_DIR/uuid-query-count"
    uuid_count=0
    [[ ! -f "$uuid_count_file" ]] || uuid_count="$(cat "$uuid_count_file")"
    uuid_count=$((uuid_count + 1))
    printf '%s' "$uuid_count" >"$uuid_count_file"
    case "${STUB_MODE:-}" in
      zero-db-active) : ;;
      duplicate-db-uuids) printf 'active-one\nactive-one\n' ;;
      restored-uuid-mismatch) printf 'other-one\n' ;;
      active-drift-after) if [[ "$uuid_count" -ge 2 ]]; then printf 'other-one\n'; else printf 'active-one\n'; fi ;;
      *) printf 'active-one\n' ;;
    esac
  elif [[ "$joined" == *"cd /storage; { find owned -type d"* ]]; then
    printf '%s\n' \
      owned/ owned/ac/ owned/ac/ti/ owned/de/ owned/de/fe/ \
      owned/ac/ti/active-one.blob owned/ac/ti/active-one.meta.json \
      owned/de/fe/deferred-one.blob owned/de/fe/deferred-one.meta.json
  elif [[ "$joined" == *"unsafe-owned-root"* ]]; then [[ "${STUB_MODE:-}" != destination-nonempty ]] || printf '/storage/owned/existing\n'
  elif [[ "$joined" == *"find /storage/owned"*"wc -l"* ]]; then printf '2\n2\n'
  elif [[ "$joined" == *"basename {} .meta.json"* ]]; then printf 'active-one\ndeferred-one\n'
  elif [[ "$joined" == *"basename {} .blob"* ]]; then printf 'active-one\ndeferred-one\n'
  elif [[ "$joined" == *"tar -C /storage -cf - owned"* ]]; then [[ "${STUB_MODE:-}" != backup-monitor-extra ]] || sleep 0.08; cat "$STUB_TAR_STREAM"
  elif [[ "$joined" == *"tar -C /storage -xf -"* ]]; then
    if [[ "${STUB_MODE:-}" == runner-reappears-during-storage ]]; then
      : >"$STUB_STATE_DIR/runner-reappear"
      sleep 0.08
    elif [[ "${STUB_MODE:-}" == monitor-extra || "${STUB_MODE:-}" == restore-pod-replaced ]]; then
      sleep 0.08
    fi
    cat >/dev/null
  elif [[ "$joined" == *"psql -v ON_ERROR_STOP=1 -q"* ]]; then cat >/dev/null
  else printf '0\n'
  fi
  exit 0
fi
printf 'Unhandled kubectl stub call: %s\n' "$joined" >&2
exit 90
STUB
chmod 700 "$TMP_DIR/bin/kubectl"
cat >"$TMP_DIR/bin/doctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '[]\n'
STUB
chmod 700 "$TMP_DIR/bin/doctl"
RUNNER_CONTROL_PLANE_VERIFIER_FIXTURE="$TMP_DIR/runner-control-plane-verifier.fixture.js"
cat >"$RUNNER_CONTROL_PLANE_VERIFIER_FIXTURE" <<'STUB'
const fs = require("node:fs");
const path = require("node:path");

const stateDirectory = process.env.STUB_STATE_DIR;
if (!stateDirectory || process.env.KUBECTL_CONTEXT !== "fixture-context") process.exit(2);
for (const name of ["HCCE_INPUT_VALUES_PATH", "HCCE_MANIFEST_PATH"]) {
  const value = process.env[name];
  if (!value || !fs.statSync(value).isFile()) process.exit(2);
}
const countPath = path.join(stateDirectory, "runner-control-plane-verifier-count");
const previous = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
const count = previous + 1;
fs.writeFileSync(countPath, String(count), { mode: 0o600 });
fs.appendFileSync(
  path.join(stateDirectory, "runner-control-plane-verifier.log"),
  `${count}\t${process.env.HCCE_INPUT_VALUES_PATH}\t${process.env.HCCE_MANIFEST_PATH}\n`,
  { mode: 0o600 }
);
if (
  process.env.STUB_MODE === "checkpoint-control-plane-preflight-failure" ||
  process.env.STUB_MODE === "checkpoint-bootstrap-control-plane" ||
  (process.env.STUB_MODE === "checkpoint-active-control-plane-drift" && count >= 3)
) {
  process.stderr.write("runner_live_control_plane_verification_failed\n");
  process.exit(1);
}
process.stdout.write("runner_live_control_plane_verified\n");
STUB
chmod 600 "$RUNNER_CONTROL_PLANE_VERIFIER_FIXTURE"
GENERATED_MANIFEST_VERIFIER_FIXTURE="$TMP_DIR/generated-manifest-verifier.fixture.js"
cat >"$GENERATED_MANIFEST_VERIFIER_FIXTURE" <<'STUB'
const fs = require("node:fs");
const path = require("node:path");

const stateDirectory = process.env.STUB_STATE_DIR;
if (!stateDirectory) process.exit(2);
for (const name of ["HCCE_INPUT_VALUES_PATH", "HCCE_MANIFEST_PATH"]) {
  const value = process.env[name];
  if (!value || !fs.statSync(value).isFile()) process.exit(2);
}
const countPath = path.join(stateDirectory, "generated-manifest-verifier-count");
const previous = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
const count = previous + 1;
fs.writeFileSync(countPath, String(count), { mode: 0o600 });
if (process.env.STUB_MODE === "checkpoint-tampered-manifest") {
  process.stderr.write("Manifest verification failed\n");
  process.exit(1);
}
process.stdout.write("Manifest verification passed (fixture).\n");
STUB
chmod 600 "$GENERATED_MANIFEST_VERIFIER_FIXTURE"
RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE="$TMP_DIR/hcce.fixture.yaml"
printf '%s\n' 'apiVersion: v1' >"$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE"
chmod 600 "$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE"
export PATH="$TMP_DIR/bin:$PATH"
export RECOVERY_WAIT_RETRY_DELAY_SECONDS=0
export RECOVERY_STREAM_POLL_SECONDS=0.01
# shellcheck disable=SC2031 # Intentional global fixture values after isolated subshells.
export YENHUBS_RECOVERY_TEST_MODE=local-fixture
# shellcheck disable=SC2031 # Intentional global fixture value after isolated subshells.
export RECOVERY_TEST_STABLE_ABSENCE_SECONDS=0
export YENHUBS_RECOVERY_RUNNER_CONTROL_PLANE_VERIFIER="$RUNNER_CONTROL_PLANE_VERIFIER_FIXTURE"
export YENHUBS_RECOVERY_GENERATED_MANIFEST_VERIFIER="$GENERATED_MANIFEST_VERIFIER_FIXTURE"
export HCCE_MANIFEST_PATH="$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE"

reset_stub() {
  unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
    YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY
  : >"$KUBECTL_LOG"
  rm -f -- "$STUB_STATE_DIR/waited" "$STUB_STATE_DIR/applied.yaml" \
    "$STUB_STATE_DIR/pod-created" "$STUB_STATE_DIR/consumer-count" \
    "$STUB_STATE_DIR/db-contract-count" "$STUB_STATE_DIR/uuid-query-count" \
    "$STUB_STATE_DIR/restore-pod-get-count" "$STUB_STATE_DIR/restore-lock-get-count" \
    "$STUB_STATE_DIR/restore-lock.yaml" "$STUB_STATE_DIR/restore-lock-uid" \
    "$STUB_STATE_DIR/restore-lock-rv" "$STUB_STATE_DIR/network-policy.yaml" \
    "$STUB_STATE_DIR/network-policy-name" "$STUB_STATE_DIR/network-policy-uid" \
    "$STUB_STATE_DIR/pod-name" "$STUB_STATE_DIR/pod-uid" \
    "$STUB_STATE_DIR/create-count" "$STUB_STATE_DIR/delete-count" \
    "$STUB_STATE_DIR/replace-ready-Lease" \
    "$STUB_STATE_DIR/replace-ready-Role" \
    "$STUB_STATE_DIR/serialization-lease.json" \
    "$STUB_STATE_DIR/serialization-lease.next" \
    "$STUB_STATE_DIR/serialization-lease-create.yaml" \
    "$STUB_STATE_DIR/serialization-lease-get-count" \
    "$STUB_STATE_DIR/runner-role-uid" "$STUB_STATE_DIR/runner-role-rv" \
    "$STUB_STATE_DIR/runner-role-phase" "$STUB_STATE_DIR/runner-role-rules.json" \
    "$STUB_STATE_DIR/parent-death-stream-started" \
    "$STUB_STATE_DIR/parent-death-stream-terminated" \
    "$STUB_STATE_DIR/parent-death-stream-completed" \
    "$STUB_STATE_DIR/parent-death-grandchild-pid" \
    "$STUB_STATE_DIR/checkpoint-orphan-runner-deleted" \
    "$STUB_STATE_DIR/runner-control-plane-verifier-count" \
    "$STUB_STATE_DIR/runner-control-plane-verifier.log" \
    "$STUB_STATE_DIR/generated-manifest-verifier-count" \
    "$STUB_STATE_DIR/finalizer-failclose-triggered" \
    "$STUB_STATE_DIR/lock-replaced-after-quiesce" \
    "$STUB_STATE_DIR/role-replace-failed-once" \
    "$STUB_STATE_DIR/runner-list-count" "$STUB_STATE_DIR/runner-reappear" \
    "$STUB_STATE_DIR/runner-watch-transient-emitted"
  rm -f -- "$STUB_STATE_DIR/recovery-phase" "$STUB_STATE_DIR/recovery-epoch"
  find "$STUB_STATE_DIR" -maxdepth 1 -type f \
    \( -name 'replicas-*' -o -name 'rv-*' -o -name 'create-payload-*' \
       -o -name 'delete-options-*' -o -name 'runner-watch-count-*' \
       -o -name 'runner-final-watch-count-*' \
       -o -name 'runner-watch-event-*' -o -name 'replace-payload.*' \) -delete
}

run_checkpoint_input_snapshot_test() {
  local checkpoint_output="$1"
  local mutable_values="$TMP_DIR/checkpoint-mutable-values.yaml"
  local mutable_manifest="$TMP_DIR/checkpoint-mutable-manifest.yaml"
  local pair_count values_snapshot manifest_snapshot
  cp "$VALUES_FIXTURE" "$mutable_values"
  cp "$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" "$mutable_manifest"
  chmod 600 "$mutable_values" "$mutable_manifest"
  reset_stub
  expect_success 'checkpoint resume is independent of local input rotation after fencing' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$mutable_values" HCCE_MANIFEST_PATH="$mutable_manifest" \
    STUB_MODE=checkpoint-local-input-mutation \
    STUB_MUTABLE_VALUES_PATH="$mutable_values" \
    STUB_MUTABLE_MANIFEST_PATH="$mutable_manifest" \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$checkpoint_output"
  pair_count="$(awk -F '\t' '{print $2 "\t" $3}' \
    "$STUB_STATE_DIR/runner-control-plane-verifier.log" |
    LC_ALL=C sort -u | wc -l | tr -d ' ')"
  IFS=$'\t' read -r values_snapshot manifest_snapshot < <(
    awk -F '\t' 'NR == 1 {print $2 "\t" $3}' \
      "$STUB_STATE_DIR/runner-control-plane-verifier.log"
  )
  if [[ "$pair_count" == 1 && -n "$values_snapshot" && -n "$manifest_snapshot" &&
        "$values_snapshot" != "$mutable_values" &&
        "$manifest_snapshot" != "$mutable_manifest" &&
        ! -e "$values_snapshot" && ! -e "$manifest_snapshot" ]] &&
     grep -q '^invalid: \[$' "$mutable_values" &&
     grep -q '^tampered-after-fence$' "$mutable_manifest"; then
    pass 'checkpoint binds one private values/manifest pair and removes both snapshots'
  else
    fail 'checkpoint immutable local-input binding' \
      "pairs=$pair_count values=$values_snapshot manifest=$manifest_snapshot"
  fi
}

run_restore_role_retry_test() {
  local inventory_sha confirmation retry_consumer retry_exact=true
  inventory_sha="$(sha256_digest "$GOOD_CHECKPOINT/deployment-images.json")"
  confirmation="prepare-fence:fixture-context:hcce:fixture-uid:fixture-pvc-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:$inventory_sha:$LIVE_RUNNER_EPOCH:33333333-3333-4333-8333-333333333333"
  reset_stub
  expect_success 'prepare-fence retries one Role CAS failure only in the main driver' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
    RESTORE_CHECKPOINT_PREPARE_FENCE=1 \
    CONFIRM_PREPARE_RESTORE_FENCE="$confirmation" \
    STUB_MODE=restore-role-replace-retry \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
  for retry_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ "$(grep -Ec "scale deployment $retry_consumer .*--replicas=0" \
          "$KUBECTL_LOG" || :)" != 1 ]]; then
      retry_exact=false
    fi
  done
  if [[ -e "$STUB_STATE_DIR/role-replace-failed-once" &&
        "$(cat "$STUB_STATE_DIR/runner-role-rv")" == 2 &&
        "$retry_exact" == true && -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'Role retry causes no subshell fail-close, duplicate fence or lock release'
  else
    fail 'Role retry escaped the main restore driver' "$(cat "$KUBECTL_LOG")"
  fi
}

# shellcheck disable=SC2016 # Expanded by the isolated Bash process.
expect_success 'production stable-absence timing remains 61 seconds' \
  env -u YENHUBS_RECOVERY_TEST_MODE -u RECOVERY_TEST_STABLE_ABSENCE_SECONDS \
  bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    [[ "$(recovery_stable_absence_seconds)" == 61 ]]
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
# shellcheck disable=SC2016 # Expanded by the isolated Bash process.
expect_success 'exact live fixture identity permits bounded zero-second timing' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    [[ "$(recovery_stable_absence_seconds)" == 0 ]]
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
# shellcheck disable=SC2016 # Expanded by the isolated Bash process.
expect_failure 'non-fixture context cannot enable recovery timing overrides' \
  'exact isolated fixture identity' env EXPECTED_KUBE_CONTEXT=production-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_stable_absence_seconds
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

reset_stub
# shellcheck disable=SC2016 # Expanded by the isolated Bash process.
expect_success 'live runner epoch requires and returns the exact shared binding' \
  env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce bash -c '
    set -euo pipefail
    source "$1"
    [[ "$(recovery_live_runner_epoch)" == "$LIVE_RUNNER_EPOCH" ]]
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
for asymmetric_epoch_mode in epoch-reticulum-only epoch-parent-only; do
  reset_stub
  # shellcheck disable=SC2016 # Expanded by the isolated Bash process.
  if env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
      STUB_MODE="$asymmetric_epoch_mode" bash -c '
        set -euo pipefail
        source "$1"
        recovery_live_runner_epoch >/dev/null
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"; then
    fail "$asymmetric_epoch_mode is rejected" 'asymmetric epoch was accepted'
  else
    pass "$asymmetric_epoch_mode is rejected"
  fi
done

reset_stub
DELETE_ERR_SENTINEL="$STUB_STATE_DIR/expected-delete-404-err-trap"
rm -f -- "$DELETE_ERR_SENTINEL"
# shellcheck disable=SC2016 # Expanded by the isolated Bash process.
expect_success 'expected UID-delete 404 cannot inherit a caller recovery ERR trap' \
  env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
  STUB_MODE=checkpoint-orphan-runner bash -c '
    set -Eeuo pipefail
    source "$1"
    sentinel="$2"
    recovery_kubectl_mutate() { recovery_kubectl "$@"; }
    trap "printf triggered >\"$sentinel\"" ERR
    recovery_delete_namespaced_with_uid_in_namespace \
      hcce-bot-runners pod bot-runner-fixture runner-pod-uid 1
    [[ ! -e "$sentinel" ]]
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$DELETE_ERR_SENTINEL"

seed_serialization_lease() {
  local holder="${1:-}" renew_time="${2:-2026-07-18T00:00:00.000000Z}"
  local transitions="${3:-0}"
  if [[ -z "$holder" ]]; then
    jq -cn --argjson transitions "$transitions" '
      {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
       metadata:{name:"yenhubs-operation-serialization",namespace:"hcce",
         uid:"serialization-lease-uid",resourceVersion:"lease-rv-1",
         labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
       spec:{leaseDurationSeconds:120,leaseTransitions:$transitions}}
    ' >"$STUB_STATE_DIR/serialization-lease.json"
  else
    jq -cn --arg holder "$holder" --arg renew "$renew_time" \
      --argjson transitions "$transitions" '
      {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
       metadata:{name:"yenhubs-operation-serialization",namespace:"hcce",
         uid:"serialization-lease-uid",resourceVersion:"lease-rv-1",
         labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
       spec:{holderIdentity:$holder,leaseDurationSeconds:120,
         acquireTime:$renew,renewTime:$renew,leaseTransitions:$transitions}}
    ' >"$STUB_STATE_DIR/serialization-lease.json"
  fi
}
seed_restore_lock() {
  local lease_mode="${1:-adopted}"
  local operation_id="88888888888888888888888888888888"
  local operation_token="77777777777777777777777777777777"
  local deployment entry consumers='[]' fingerprint
  cat >"$STUB_STATE_DIR/restore-lock.yaml" <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: yenhubs-recovery-operation-lock
  namespace: hcce
  labels:
    yenhubs.org/recovery-owner: checkpoint-restore
  annotations:
    yenhubs.org/operation-id: "$operation_id"
    yenhubs.org/recovery-token: "$operation_token"
    yenhubs.org/namespace-uid: "fixture-uid"
    yenhubs.org/pvc-uid: "fixture-pvc-uid"
    yenhubs.org/checkpoint-stamp: "$STAMP"
    yenhubs.org/dump-sha256: "$DUMP_SHA"
    yenhubs.org/storage-sha256: "$STORAGE_SHA"
immutable: true
EOF
  printf '%s' restore-lock-uid >"$STUB_STATE_DIR/restore-lock-uid"
  printf '%s' lock-rv-1 >"$STUB_STATE_DIR/restore-lock-rv"
  if [[ "$lease_mode" == adopted ]]; then
    seed_serialization_lease \
      root-recovery:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
      "$(date -u '+%Y-%m-%dT%H:%M:%S.000000Z')" 1
    export YENHUBS_PARENT_LEASE_HOLDER=root-recovery:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
    export YENHUBS_PARENT_LEASE_UID=serialization-lease-uid
    export YENHUBS_PARENT_PROCESS_PID="$$"
    YENHUBS_PARENT_PROCESS_START_IDENTITY="$(
      ps -o lstart= -p "$$" | awk '{$1=$1; print}'
    )"
    export YENHUBS_PARENT_PROCESS_START_IDENTITY
  elif [[ "$lease_mode" == available ]]; then
    seed_serialization_lease
    unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
      YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY
  else
    return 2
  fi
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    fingerprint="$(jq -er --arg name "$deployment" '
      [.items[] | select(.metadata.name == $name)] | select(length == 1) | .[0] |
      .spec.strategy = {} |
      .spec.template.metadata = ((.spec.template.metadata // {}) + {labels:{app:$name}}) |
      {selector:.spec.selector,strategy:.spec.strategy,template:.spec.template} | @base64
    ' "$STUB_DEPLOYMENTS_JSON")"
    entry="$(jq -cn --arg name "$deployment" --arg uid "uid-$deployment" \
      --arg rv "rv-$deployment-1" --arg selector "$deployment" \
      --arg fingerprint "$fingerprint" \
      '{name:$name,uid:$uid,initial_resource_version:$rv,original_replicas:1,selector:$selector,fingerprint:$fingerprint}')"
    consumers="$(jq -cn --argjson consumers "$consumers" --argjson entry "$entry" '$consumers + [$entry]')"
  done
  RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn --arg operation_id "$operation_id" \
    --argjson consumers "$consumers" \
    '{schema_version:1,operation_id:$operation_id,consumers:$consumers}')"
  export EXPECTED_RET_PVC_UID=fixture-pvc-uid
  export RECOVERY_OPERATION_OWNER=checkpoint-restore
  export RECOVERY_OPERATION_LOCK_NAME=yenhubs-recovery-operation-lock
  export RECOVERY_OPERATION_LOCK_UID=restore-lock-uid
  export RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=lock-rv-1
  export RECOVERY_OPERATION_TOKEN="$operation_token"
  export RECOVERY_OPERATION_ID="$operation_id"
  export RECOVERY_CONSUMER_CONTRACT_JSON
}
seed_stale_restore_helper() {
  local operation_id="88888888888888888888888888888888"
  local operation_token="77777777777777777777777777777777"
  local image="ghcr.io/yengalvez/reticulum@sha256:6666666666666666666666666666666666666666666666666666666666666666"
  cat >"$STUB_STATE_DIR/network-policy.yaml" <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ret-storage-restore-deny-${operation_id:0:12}
  namespace: hcce
  labels:
    yenhubs.org/recovery-owner: ret-storage-restore
    yenhubs.org/operation-id: "$operation_id"
  annotations:
    yenhubs.org/operation-lock-uid: "restore-lock-uid"
    yenhubs.org/operation-token: "$operation_token"
spec:
  podSelector:
    matchLabels:
      yenhubs.org/operation-id: "$operation_id"
  policyTypes: [Ingress, Egress]
  ingress: []
  egress: []
EOF
  printf '%s' "ret-storage-restore-deny-${operation_id:0:12}" >"$STUB_STATE_DIR/network-policy-name"
  printf '%s' network-policy-uid >"$STUB_STATE_DIR/network-policy-uid"
  cat >"$STUB_STATE_DIR/applied.yaml" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ret-storage-restore-${operation_id:0:12}
  namespace: hcce
  labels:
    yenhubs.org/recovery-owner: ret-storage-restore
    yenhubs.org/operation-id: "$operation_id"
  annotations:
    yenhubs.org/operation-lock-uid: "restore-lock-uid"
    yenhubs.org/operation-token: "$operation_token"
spec:
  automountServiceAccountToken: false
  enableServiceLinks: false
  restartPolicy: Never
  activeDeadlineSeconds: 3600
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: helper
      image: $image
      command: ["sh", "-c", "sleep 3600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: storage
          mountPath: /storage
          readOnly: false
  volumes:
    - name: storage
      persistentVolumeClaim:
        claimName: ret-pvc
        readOnly: false
EOF
  printf '%s' "ret-storage-restore-${operation_id:0:12}" >"$STUB_STATE_DIR/pod-name"
  printf '%s' restore-pod-uid >"$STUB_STATE_DIR/pod-uid"
  : >"$STUB_STATE_DIR/pod-created"
  for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf 0 >"$STUB_STATE_DIR/replicas-$writer"
    printf 2 >"$STUB_STATE_DIR/rv-$writer"
  done
}
assert_no_kube() { if [[ -s "$KUBECTL_LOG" ]]; then fail "$1" "$(cat "$KUBECTL_LOG")"; else pass "$1"; fi; }

run_stale_helper_cleanup_tests() {
  local confirmation lease_failure_mode
  confirmation="restore-lock:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:restore-lock-uid:fixture-pvc-uid"

  reset_stub
  seed_restore_lock available
  seed_stale_restore_helper
  expect_success 'stale-lock recovery removes its exact operation-bound helper before the lock' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
    CONFIRM_CLEAR_RESTORE_LOCK="$confirmation" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
  if [[ ! -e "$STUB_STATE_DIR/pod-created" &&
        ! -e "$STUB_STATE_DIR/network-policy.yaml" &&
        ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     [[ "$(grep -c 'delete --raw=' "$KUBECTL_LOG" || :)" == 3 ]]; then
    pass 'stale helper cleanup is exact, complete and clear-only'
  else
    fail 'stale helper cleanup is exact, complete and clear-only' "$(cat "$KUBECTL_LOG")"
  fi
  if [[ -f "$STUB_STATE_DIR/delete-options-1.json" &&
        -f "$STUB_STATE_DIR/delete-options-2.json" &&
        -f "$STUB_STATE_DIR/delete-options-3.json" ]] &&
     jq -e '.preconditions.uid == "restore-pod-uid"' \
       "$STUB_STATE_DIR/delete-options-1.json" >/dev/null &&
     jq -e '.preconditions.uid == "network-policy-uid"' \
       "$STUB_STATE_DIR/delete-options-2.json" >/dev/null &&
     jq -e '.preconditions.uid == "restore-lock-uid"' \
       "$STUB_STATE_DIR/delete-options-3.json" >/dev/null; then
    pass 'stale helper cleanup emits three exact UID-preconditioned DeleteOptions'
  else
    fail 'stale helper cleanup emits three exact UID-preconditioned DeleteOptions' \
      "$(cat "$STUB_STATE_DIR"/delete-options-*.json 2>/dev/null || :)"
  fi

  for lease_failure_mode in \
    stale-helper-parent-lease-missing \
    stale-helper-parent-lease-replaced; do
    reset_stub
    seed_restore_lock available
    seed_stale_restore_helper
    expect_failure "stale helper cleanup rejects $lease_failure_mode" '' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
      CONFIRM_CLEAR_RESTORE_LOCK="$confirmation" STUB_MODE="$lease_failure_mode" \
      "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
    if [[ -e "$STUB_STATE_DIR/pod-created" &&
          -e "$STUB_STATE_DIR/network-policy.yaml" &&
          -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
       ! grep -q 'delete --raw=' "$KUBECTL_LOG"; then
      pass "$lease_failure_mode preserves the helper, policy and lock without deletion"
    else
      fail "$lease_failure_mode preserves the helper, policy and lock without deletion" \
        "$(cat "$KUBECTL_LOG")"
    fi
  done

  reset_stub
  seed_restore_lock available
  seed_stale_restore_helper
  expect_failure 'stale helper same-name replacement is never adopted or deleted' \
    'identity/spec changed' env EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 CONFIRM_CLEAR_RESTORE_LOCK="$confirmation" \
    STUB_MODE=stale-helper-replaced \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
  if [[ -e "$STUB_STATE_DIR/pod-created" &&
        -e "$STUB_STATE_DIR/network-policy.yaml" &&
        -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     ! grep -q 'delete --raw=.*/pods/' "$KUBECTL_LOG"; then
    pass 'replacement helper, deny policy and retained lock remain untouched'
  else
    fail 'replacement helper, deny policy and retained lock remain untouched' \
      "$(cat "$KUBECTL_LOG")"
  fi
}

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == stale-helper ]]; then
  run_stale_helper_cleanup_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused stale-helper test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused stale-helper tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-input-snapshot ]]; then
  run_checkpoint_input_snapshot_test "$TMP_DIR/checkpoint-input-snapshot-focus"
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused checkpoint-input-snapshot test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused checkpoint-input-snapshot tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-errtrap ]]; then
  run_restore_role_retry_test
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused restore-errtrap test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused restore-errtrap tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-gates ||
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-adjacent ]]; then
  checkpoint_focus_parent="$TMP_DIR/checkpoint-gate-focus"
  if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-gates ]]; then
    for checkpoint_focus_mode in \
      checkpoint-control-plane-preflight-failure \
      checkpoint-bootstrap-control-plane \
      checkpoint-tampered-manifest; do
      reset_stub
      if [[ "$checkpoint_focus_mode" == checkpoint-tampered-manifest ]]; then
        checkpoint_focus_error='generated Cloud manifest is invalid'
      else
        checkpoint_focus_error='active runner control plane is not exact'
      fi
      expect_failure "focused preflight $checkpoint_focus_mode" \
        "$checkpoint_focus_error" \
        env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$VALUES_FIXTURE" STUB_MODE="$checkpoint_focus_mode" \
        STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE=present \
        STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
        "$ROOT_DIR/deployment/create-checkpoint.sh" \
        "$checkpoint_focus_parent/$checkpoint_focus_mode"
      if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
        fail "focused $checkpoint_focus_mode preflight does not scale" \
          "$(cat "$KUBECTL_LOG")"
      else
        pass "focused $checkpoint_focus_mode preflight does not scale"
      fi
    done
  fi

  reset_stub
  expect_failure 'focused adjacent Cloud drift gate blocks parent resume' \
    'active runner control plane is not exact' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=checkpoint-active-control-plane-drift \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present \
    STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$checkpoint_focus_parent/adjacent-drift"
  checkpoint_focus_parent_resume_count="$(grep -Ec -- \
    'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" || :)"
  checkpoint_focus_verifier_count="$(cat \
    "$STUB_STATE_DIR/runner-control-plane-verifier-count" 2>/dev/null || :)"
  if [[ "$checkpoint_focus_parent_resume_count" == 0 &&
        "$checkpoint_focus_verifier_count" =~ ^[3-9][0-9]*$ &&
        "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]]; then
    pass 'focused adjacent drift leaves token-bearing parent at zero'
  else
    fail 'focused adjacent drift resumed token-bearing parent' \
      "verifier-count=$checkpoint_focus_verifier_count $(cat "$KUBECTL_LOG")"
  fi
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused checkpoint gate test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused checkpoint gate tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-orphan ]]; then
  checkpoint_orphan_output="$TMP_DIR/checkpoint-orphan-focus"
  reset_stub
  expect_success 'focused checkpoint UID-deletes an isolated orphan and resumes' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=checkpoint-orphan-runner \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$checkpoint_orphan_output"
  orphan_focus_zero="$(grep -n -- \
    'scale deployment bot-orchestrator .*--replicas=0' "$KUBECTL_LOG" |
    head -1 | cut -d: -f1 || :)"
  orphan_focus_delete="$(grep -n \
    'delete --raw=/api/v1/namespaces/hcce-bot-runners/pods/bot-runner-fixture' \
    "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
  orphan_focus_dump="$(grep -n 'pg_dump -U' "$KUBECTL_LOG" |
    head -1 | cut -d: -f1 || :)"
  orphan_focus_resume="$(grep -n -- \
    'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" |
    head -1 | cut -d: -f1 || :)"
  if [[ "$orphan_focus_zero" =~ ^[0-9]+$ &&
        "$orphan_focus_delete" =~ ^[0-9]+$ &&
        "$orphan_focus_dump" =~ ^[0-9]+$ &&
        "$orphan_focus_resume" =~ ^[0-9]+$ &&
        "$orphan_focus_zero" -lt "$orphan_focus_delete" &&
        "$orphan_focus_delete" -lt "$orphan_focus_dump" &&
        "$orphan_focus_dump" -lt "$orphan_focus_resume" ]]; then
    pass 'focused orphan ordering is parent-zero then UID-delete then backup then resume'
  else
    fail 'focused orphan ordering' "$(cat "$KUBECTL_LOG")"
  fi
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused checkpoint-orphan test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused checkpoint-orphan tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-process-local ]]; then
  process_local_capture="$TMP_DIR/process-local-focus-capture"
  process_local_checkpoint="$TMP_DIR/process-local-focus-checkpoint"
  reset_stub
  expect_success 'focused process-local inventory capture accepts the exact legacy boundary' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    "$ROOT_DIR/deployment/capture-instance-state.sh" "$process_local_capture"
  if jq -e '
    [.deployments[] | select(.name == "pgsql") | .containers[].name] ==
      ["postgresql"]
  ' "$process_local_capture/deployment-images.json" >/dev/null; then
    pass 'focused process-local inventory preserves pgsql/postgresql'
  else
    fail 'focused process-local inventory preserves pgsql/postgresql' \
      'historical container identity was not captured'
  fi
  reset_stub
  expect_failure 'focused process-local capture rejects BOT_RUNNER_ACCESS_KEY substitution' \
    'partial Kubernetes runner bindings' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    STUB_DEPLOYMENTS_JSON="$LEGACY_WRONG_ACCESS_KEY_DEPLOYMENTS_JSON" \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    "$ROOT_DIR/deployment/capture-instance-state.sh" \
    "$TMP_DIR/process-local-focus-wrong-key"
  reset_stub
  expect_failure 'focused process-local capture rejects mixed access-key contracts' \
    'partial Kubernetes runner bindings' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    STUB_DEPLOYMENTS_JSON="$LEGACY_MIXED_ACCESS_KEYS_DEPLOYMENTS_JSON" \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    "$ROOT_DIR/deployment/capture-instance-state.sh" \
    "$TMP_DIR/process-local-focus-mixed-keys"
  reset_stub
  expect_failure 'focused process-local capture rejects pgsql/pgsql mixture' \
    'historical AUD-065 contract' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    STUB_DEPLOYMENTS_JSON="$LEGACY_MIXED_PGSQL_DEPLOYMENTS_JSON" \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    "$ROOT_DIR/deployment/capture-instance-state.sh" \
    "$TMP_DIR/process-local-focus-mixed-pgsql"

  for candidate_key in BOT_ORCHESTRATOR_ACCESS_KEY DASHBOARD_ACCESS_KEY; do
    candidate_fixture="$TMP_DIR/process-local-parent-env-$candidate_key.json"
    jq --arg name "$candidate_key" '
      (.items[] | select(.metadata.name == "bot-orchestrator") |
        .spec.template.spec.containers[0].env) += [{name:$name,value:"fixture"}]
    ' "$LEGACY_DEPLOYMENTS_JSON" >"$candidate_fixture"
    reset_stub
    expect_failure "focused process-local capture rejects parent $candidate_key" \
      'partial Kubernetes runner bindings' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      STUB_DEPLOYMENTS_JSON="$candidate_fixture" \
      VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      "$ROOT_DIR/deployment/capture-instance-state.sh" \
      "$TMP_DIR/process-local-focus-parent-env-$candidate_key"
  done

  candidate_fixture="$TMP_DIR/process-local-parent-pull-secret.json"
  jq '(.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.imagePullSecrets) = [{name:"bot-images-pull"}]' \
    "$LEGACY_DEPLOYMENTS_JSON" >"$candidate_fixture"
  reset_stub
  expect_failure 'focused process-local capture rejects parent imagePullSecrets' \
    'partial Kubernetes runner bindings' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    STUB_DEPLOYMENTS_JSON="$candidate_fixture" \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    "$ROOT_DIR/deployment/capture-instance-state.sh" \
    "$TMP_DIR/process-local-focus-parent-pull-secret"

  candidate_fixture="$TMP_DIR/process-local-parent-key-checksum.json"
  jq '(.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.metadata.annotations) = {
      "yenhubs.org/bot-orchestrator-access-key-checksum":("a" * 64)
    }' "$LEGACY_DEPLOYMENTS_JSON" >"$candidate_fixture"
  reset_stub
  expect_failure 'focused process-local capture rejects parent candidate checksum' \
    'partial Kubernetes runner bindings' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    STUB_DEPLOYMENTS_JSON="$candidate_fixture" \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    "$ROOT_DIR/deployment/capture-instance-state.sh" \
    "$TMP_DIR/process-local-focus-parent-key-checksum"

  for candidate_env in \
    turkeyCfg_BOT_RUNNER_ACCESS_KEY \
    turkeyCfg_BOT_ORCHESTRATOR_ACCESS_KEY \
    turkeyCfg_DASHBOARD_ACCESS_KEY \
    turkeyCfg_BOT_RUNNER_RECOVERY_EPOCH; do
    candidate_fixture="$TMP_DIR/process-local-ret-env-$candidate_env.json"
    jq --arg name "$candidate_env" '
      (.items[] | select(.metadata.name == "reticulum") |
        .spec.template.spec.containers[] | select(.name == "reticulum") |
        .env) = [{name:$name,value:"fixture"}]
    ' "$LEGACY_DEPLOYMENTS_JSON" >"$candidate_fixture"
    reset_stub
    expect_failure "focused process-local capture rejects Reticulum $candidate_env" \
      'partial Kubernetes runner bindings' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      STUB_DEPLOYMENTS_JSON="$candidate_fixture" \
      VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      "$ROOT_DIR/deployment/capture-instance-state.sh" \
      "$TMP_DIR/process-local-focus-ret-env-$candidate_env"
  done

  for checksum_name in \
    yenhubs.org/bot-runner-access-key-checksum \
    yenhubs.org/bot-orchestrator-access-key-checksum \
    yenhubs.org/dashboard-access-key-checksum; do
    checksum_slug="${checksum_name##*/}"
    candidate_fixture="$TMP_DIR/process-local-ret-checksum-$checksum_slug.json"
    jq --arg name "$checksum_name" '
      (.items[] | select(.metadata.name == "reticulum") |
        .spec.template.metadata.annotations) = {($name):("b" * 64)}
    ' "$LEGACY_DEPLOYMENTS_JSON" >"$candidate_fixture"
    reset_stub
    expect_failure "focused process-local capture rejects Reticulum $checksum_slug" \
      'partial Kubernetes runner bindings' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      STUB_DEPLOYMENTS_JSON="$candidate_fixture" \
      VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      "$ROOT_DIR/deployment/capture-instance-state.sh" \
      "$TMP_DIR/process-local-focus-ret-checksum-$checksum_slug"
  done

  for secret_key in \
    BOT_RUNNER_ACCESS_KEY BOT_ORCHESTRATOR_ACCESS_KEY DASHBOARD_ACCESS_KEY; do
    candidate_secret="$TMP_DIR/process-local-configs-$secret_key.json"
    jq --arg name "$secret_key" '.data[$name] = "eA=="' \
      "$LEGACY_CONFIGS_SECRET_JSON" >"$candidate_secret"
    reset_stub
    expect_failure "focused process-local capture rejects configs/$secret_key" \
      'configs Secret contains isolated-runner credentials' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
      STUB_CONFIGS_SECRET_JSON="$candidate_secret" \
      VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      "$ROOT_DIR/deployment/capture-instance-state.sh" \
      "$TMP_DIR/process-local-focus-configs-$secret_key"
  done

  for marker_slug in runner-key orchestrator-key dashboard-key recovery-epoch section; do
    case "$marker_slug" in
      runner-key) marker='<BOT_RUNNER_ACCESS_KEY>' ;;
      orchestrator-key) marker='<BOT_ORCHESTRATOR_ACCESS_KEY>' ;;
      dashboard-key) marker='<DASHBOARD_ACCESS_KEY>' ;;
      recovery-epoch) marker='<BOT_RUNNER_RECOVERY_EPOCH>' ;;
      section) marker='[ret."Elixir.Ret.BotOrchestrator"]' ;;
    esac
    candidate_config="$TMP_DIR/process-local-ret-config-$marker_slug.json"
    jq --arg marker "$marker" '.data["config.toml.template"] += $marker' \
      "$LEGACY_RET_CONFIG_JSON" >"$candidate_config"
    reset_stub
    expect_failure "focused process-local capture rejects ret-config $marker_slug" \
      'Reticulum config contains isolated-runner markers' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
      STUB_RET_CONFIG_JSON="$candidate_config" \
      VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      "$ROOT_DIR/deployment/capture-instance-state.sh" \
      "$TMP_DIR/process-local-focus-ret-config-$marker_slug"
  done

  reset_stub
  expect_failure 'focused process-local capture rejects hcce bot-images-pull Secret' \
    'partial Kubernetes runner bindings' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_HCCE_PULL_SECRET=present VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    "$ROOT_DIR/deployment/capture-instance-state.sh" \
    "$TMP_DIR/process-local-focus-hcce-pull-secret"
  reset_stub
  expect_success 'focused process-local checkpoint publishes and resumes exactly' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$process_local_checkpoint"
  reset_stub
  expect_failure 'focused mixed PostgreSQL identity blocks checkpoint before downtime' \
    'historical AUD-065 contract' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_MIXED_PGSQL_DEPLOYMENTS_JSON" \
    STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-focus-checkpoint-mixed-pgsql"
  if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
    fail 'focused mixed PostgreSQL identity performs zero writer scale mutations' \
      "$(cat "$KUBECTL_LOG")"
  else
    pass 'focused mixed PostgreSQL identity performs zero writer scale mutations'
  fi
  reset_stub
  expect_failure 'focused process-local mode drift blocks every writer resume' \
    'Checkpoint runner mode changed while writers were fenced' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_MODE=checkpoint-process-local-mode-drift \
    STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-focus-mode-drift"
  if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
     ! grep -q 'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" &&
     [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'focused process-local drift retains the lock with parent authority at zero'
  else
    fail 'focused process-local drift resumed or released authority' "$(cat "$KUBECTL_LOG")"
  fi
  reset_stub
  expect_failure 'focused adjacent process-local drift blocks parent resume' \
    'Checkpoint runner mode changed while writers were fenced' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_MODE=checkpoint-process-local-adjacent-drift \
    STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-focus-adjacent-drift"
  if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
     ! grep -q 'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" &&
     [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'focused adjacent process-local drift leaves parent zero under lock'
  else
    fail 'focused adjacent process-local drift resumed parent' "$(cat "$KUBECTL_LOG")"
  fi
  reset_stub
  expect_failure 'focused pre-watcher quiesce failure safely reconstructs resume monitoring' \
    'Pods still remain for deployment/bot-orchestrator; refusing further mutation' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_MODE=checkpoint-parent-wait-failure \
    STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-focus-parent-wait"
  if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 1 ]] &&
     [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'focused pre-watcher failure restores parent and releases its lock safely'
  else
    fail 'focused pre-watcher failure strands parent or lock' "$(cat "$KUBECTL_LOG")"
  fi
  partial_process_local="$TMP_DIR/process-local-focus-partial.json"
  jq '(.items[] | select(.metadata.name == "bot-orchestrator") |
      .spec.template.spec.containers[0].env) += [
        {name:"ORCHESTRATOR_POD_UID",value:"partial"}
      ]' "$LEGACY_DEPLOYMENTS_JSON" >"$partial_process_local"
  reset_stub
  expect_failure 'focused partial isolated binding never falls back to process-local' \
    'not bound to recovery phase active' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$partial_process_local" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$TMP_DIR/process-local-partial"
  if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
    fail 'focused partial isolated binding mutates writer scale' "$(cat "$KUBECTL_LOG")"
  else
    pass 'focused partial isolated binding performs zero writer scale mutations'
  fi
  reset_stub
  expect_failure 'focused residual runner Namespace never falls back to process-local' \
    'not bound to recovery phase active' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$TMP_DIR/process-local-namespace"
  if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
    fail 'focused residual runner Namespace mutates writer scale' "$(cat "$KUBECTL_LOG")"
  else
    pass 'focused residual runner Namespace performs zero writer scale mutations'
  fi
  for residual_resource in role validatingadmissionpolicy; do
    reset_stub
    expect_failure "focused residual $residual_resource never falls back to process-local" \
      'not bound to recovery phase active' \
      env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
      EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
      VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
      STUB_RUNNER_RESIDUAL="$residual_resource" \
      "$ROOT_DIR/deployment/create-checkpoint.sh" \
      "$TMP_DIR/process-local-residual-$residual_resource"
    if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
      fail "focused residual $residual_resource mutates writer scale" "$(cat "$KUBECTL_LOG")"
    else
      pass "focused residual $residual_resource performs zero writer scale mutations"
    fi
  done
  annotated_process_local="$TMP_DIR/process-local-focus-annotated.json"
  jq '(.items[] | select(.metadata.name == "pgbouncer") |
      .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"]) = "active"' \
    "$LEGACY_DEPLOYMENTS_JSON" >"$annotated_process_local"
  reset_stub
  expect_failure 'focused non-parent runner annotation never falls back to process-local' \
    'not bound to recovery phase active' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$annotated_process_local" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-annotated"
  if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
    fail 'focused non-parent runner annotation mutates writer scale' "$(cat "$KUBECTL_LOG")"
  else
    pass 'focused non-parent runner annotation performs zero writer scale mutations'
  fi
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused process-local checkpoint test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused process-local checkpoint tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

reset_stub
# Lease capabilities are local to the sourcing process; poisoned inherited
# paths/PIDs must be discarded without touching their targets.
lease_poison_stop="$TMP_DIR/lease-poison-stop"
lease_poison_failure="$TMP_DIR/lease-poison-failure"
printf 'sentinel-stop\n' >"$lease_poison_stop"
printf 'sentinel-failure\n' >"$lease_poison_failure"
# shellcheck disable=SC2016
expect_success 'serialization Lease process capabilities reject environment poisoning' \
  env RECOVERY_SERIALIZATION_LEASE_HOLDER=root-recovery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
    RECOVERY_SERIALIZATION_LEASE_UID=poison-uid RECOVERY_SERIALIZATION_LEASE_REQUIRED=1 \
    RECOVERY_SERIALIZATION_HEARTBEAT_PID=999999 \
    RECOVERY_SERIALIZATION_HEARTBEAT_STOP="$lease_poison_stop" \
    RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE="$lease_poison_failure" \
    RECOVERY_SERIALIZATION_PARENT_PID=999998 bash -c '
      source "$1"
      [[ -z "$RECOVERY_SERIALIZATION_LEASE_HOLDER" &&
         -z "$RECOVERY_SERIALIZATION_LEASE_UID" &&
         "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 0 &&
         -z "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" &&
         -z "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" &&
         -z "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE" &&
         -z "$RECOVERY_SERIALIZATION_PARENT_PID" ]]
      [[ "$(cat "$2")" == sentinel-stop && "$(cat "$3")" == sentinel-failure ]]
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
      "$lease_poison_stop" "$lease_poison_failure"

# Root and Cloud share this strict Kubernetes MicroTime/metadata shape. Null is
# not treated as absence for any optional metadata collection.
# shellcheck disable=SC2016
expect_success 'serialization Lease validator enforces exact shared MicroTime and null contract' \
  bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    valid="$(jq -cn '\''
      {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
       metadata:{name:"yenhubs-operation-serialization",namespace:"hcce",
         uid:"lease-uid",resourceVersion:"lease-rv-1",
         labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
       spec:{holderIdentity:"root-recovery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
         leaseDurationSeconds:120,leaseTransitions:0,
         acquireTime:"2026-07-18T00:00:00.000000Z",
         renewTime:"2026-07-18T00:00:00.000000Z"}}
    '\'')"
    recovery_serialization_lease_json_is_valid "$valid"
    for filter in \
      ".metadata.deletionTimestamp = null" \
      ".metadata.annotations = null" \
      ".metadata.ownerReferences = null" \
      ".metadata.finalizers = null" \
      ".spec.acquireTime = \"2026-07-18T00:00:00Z\"" \
      ".spec.renewTime = \"2026-07-18T00:00:00.000Z\"" \
      ".spec.renewTime = \"2026-07-18T00:00:00.000000000Z\""; do
      if recovery_serialization_lease_json_is_valid "$(jq -c "$filter" <<<"$valid")"; then
        exit 1
      fi
    done
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

reset_stub
# shellcheck disable=SC2016
expect_success 'serialization Lease acquires, revalidates and CAS-releases without deletion' \
  env EXPECTED_KUBE_CONTEXT=fixture-context RECOVERY_LEASE_HEARTBEAT_SECONDS=1 bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_acquire_operation_serialization root-recovery
    recovery_require_operation_serialization
    [[ "$RECOVERY_SERIALIZATION_LEASE_HOLDER" =~ ^root-recovery: ]]
    recovery_release_operation_serialization
    jq -e '\''(.metadata | has("deletionTimestamp") | not) and
      (.spec | keys | sort) == ["leaseDurationSeconds","leaseTransitions"]'\'' \
      "$2" >/dev/null
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
    "$STUB_STATE_DIR/serialization-lease.json"

reset_stub
seed_serialization_lease
lease_replace_payload="$TMP_DIR/concurrent-lease-replace.json"
role_replace_payload="$TMP_DIR/concurrent-role-replace.json"
lease_replace_output="$TMP_DIR/concurrent-lease-output.json"
role_replace_output="$TMP_DIR/concurrent-role-output.json"
cp "$STUB_STATE_DIR/serialization-lease.json" "$lease_replace_payload"
jq -cn '
  {apiVersion:"rbac.authorization.k8s.io/v1",kind:"Role",
   metadata:{name:"bot-orchestrator-runner-pods",namespace:"hcce-bot-runners",
     uid:"runner-role-uid",resourceVersion:"runner-role-rv-1",annotations:{
       "yenhubs.org/runner-activation-phase":"active",
       "yenhubs.org/bot-runner-recovery-phase":"restore-fence"}},rules:[]}
' >"$role_replace_payload"
STUB_MODE=replace-payload-concurrency kubectl --context fixture-context \
  --request-timeout=30s replace -f - -o json \
  <"$lease_replace_payload" >"$lease_replace_output" &
lease_replace_pid=$!
STUB_MODE=replace-payload-concurrency kubectl --context fixture-context \
  --request-timeout=30s replace -f - -o json \
  <"$role_replace_payload" >"$role_replace_output" &
role_replace_pid=$!
if wait "$lease_replace_pid"; then lease_replace_status=0; else lease_replace_status=$?; fi
if wait "$role_replace_pid"; then role_replace_status=0; else role_replace_status=$?; fi
if [[ "$lease_replace_status" == 0 && "$role_replace_status" == 0 ]] &&
   jq -e '.kind == "Lease" and .metadata.resourceVersion == "lease-rv-2"' \
     "$lease_replace_output" >/dev/null &&
   jq -e '.kind == "Role" and .metadata.resourceVersion == "runner-role-rv-2"' \
     "$role_replace_output" >/dev/null &&
   [[ "$(cat "$STUB_STATE_DIR/runner-role-rv")" == 2 ]] &&
   ! find "$STUB_STATE_DIR" -maxdepth 1 -name 'replace-payload.*' \
     -print -quit | grep -q .; then
  pass 'replace fixture isolates concurrent Lease heartbeat and resource CAS payloads'
else
  fail 'replace fixture isolates concurrent Lease heartbeat and resource CAS payloads' \
    "lease-status=$lease_replace_status role-status=$role_replace_status $(cat "$KUBECTL_LOG")"
fi

reset_stub
seed_serialization_lease \
  cloud-apply:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  "$(date -u '+%Y-%m-%dT%H:%M:%S.000000Z')" 4
# shellcheck disable=SC2016
expect_failure 'active Cloud apply Lease excludes root recovery before mutation' \
  'Another deployment or recovery operation owns' \
  env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
    NAMESPACE=hcce
    source "$1"
    recovery_acquire_operation_serialization root-recovery
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

reset_stub
seed_serialization_lease \
  cloud-apply:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  2000-01-01T00:00:00.000000Z 4
# shellcheck disable=SC2016
expect_success 'stale Cloud apply Lease is taken over only through resourceVersion CAS' \
  env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_acquire_operation_serialization root-recovery
    [[ "$(jq -r .spec.leaseTransitions "$2")" == 5 ]]
    recovery_release_operation_serialization
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
    "$STUB_STATE_DIR/serialization-lease.json"

reset_stub
seed_serialization_lease \
  cloud-apply:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  2000-01-01T00:00:00.000000Z 4
# shellcheck disable=SC2016
expect_failure 'serialization Lease takeover rejects a lost resourceVersion CAS' \
  'takeover lost its resourceVersion CAS' \
  env EXPECTED_KUBE_CONTEXT=fixture-context STUB_MODE=lease-cas-conflict bash -c '
    NAMESPACE=hcce
    source "$1"
    recovery_acquire_operation_serialization root-recovery
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

reset_stub
# shellcheck disable=SC2016
expect_failure 'serialization Lease ownership loss is detected before further mutation' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context STUB_MODE=lease-holder-lost bash -c '
    NAMESPACE=hcce
    source "$1"
    recovery_acquire_operation_serialization root-recovery
    trap '\''recovery_release_operation_serialization >/dev/null 2>&1 || :'\'' EXIT
    recovery_require_operation_serialization
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

# These calls deliberately place the supervisor under an `if`, matching the
# coordinator callsites where Bash disables implicit errexit inside functions.
# Both Lease boundaries must therefore propagate failure explicitly.
# shellcheck disable=SC2016
expect_failure 'supervised stream rejects Lease loss before launching kubectl under a conditional caller' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
    set -Eeuo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_process_start_identity() { printf "fixture-start\n"; }
    recovery_process_identity_is_live() { :; }
    recovery_require_operation_serialization() { return 1; }
    if recovery_kubectl_stream_supervised 1 5 get namespace hcce -o json; then
      exit 0
    else
      exit 1
    fi
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

# shellcheck disable=SC2016
expect_failure 'supervised stream cannot overwrite final Lease loss with a successful kubectl status' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
    set -Eeuo pipefail
    NAMESPACE=hcce
    source "$1"
    LEASE_CALLS=0
    recovery_process_start_identity() { printf "fixture-start\n"; }
    recovery_process_identity_is_live() { :; }
    recovery_require_operation_serialization() {
      LEASE_CALLS=$((LEASE_CALLS + 1))
      [[ "$LEASE_CALLS" == 1 ]]
    }
    kill() { return 1; }
    if recovery_kubectl_stream_supervised 1 5 get namespace hcce -o json; then
      exit 0
    else
      exit 1
    fi
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

reset_stub
parent_death_owner_pid=""
# shellcheck disable=SC2016 # Expanded by the isolated owner process.
env EXPECTED_KUBE_CONTEXT=fixture-context STUB_MODE=parent-death-stream \
  RECOVERY_LEASE_HEARTBEAT_SECONDS=1 RECOVERY_STREAM_POLL_SECONDS=0.01 \
  bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_acquire_operation_serialization root-recovery
    recovery_kubectl_stream_mutate 30 exec -n hcce parent-death-probe -- destructive-stream
    printf completed >"$2/parent-death-owner-completed"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$STUB_STATE_DIR" &
parent_death_owner_pid=$!
for _ in {1..200}; do
  [[ ! -e "$STUB_STATE_DIR/parent-death-stream-started" ]] || break
  sleep 0.01
done
if [[ ! -e "$STUB_STATE_DIR/parent-death-stream-started" ]]; then
  kill -KILL "$parent_death_owner_pid" 2>/dev/null || :
  wait "$parent_death_owner_pid" 2>/dev/null || :
  fail 'parent SIGKILL kills orphaned stream group and stops Lease renewal' \
    'stream did not start'
else
  parent_death_rv_before="$(jq -r '.metadata.resourceVersion' \
    "$STUB_STATE_DIR/serialization-lease.json")"
  kill -KILL "$parent_death_owner_pid"
  wait "$parent_death_owner_pid" 2>/dev/null || :
  for _ in {1..400}; do
    [[ ! -e "$STUB_STATE_DIR/parent-death-stream-terminated" ]] || break
    sleep 0.01
  done
  parent_death_grandchild_pid="$(cat \
    "$STUB_STATE_DIR/parent-death-grandchild-pid" 2>/dev/null || :)"
  parent_death_grandchild_state=""
  # The supervisor intentionally grants the process group two seconds to
  # honor TERM before issuing KILL. Observe beyond that bounded grace period
  # instead of sampling a descendant while the TERM grace is still active.
  for _ in {1..400}; do
    parent_death_grandchild_state="$(
      ps -o stat= -p "$parent_death_grandchild_pid" 2>/dev/null |
        awk '{$1=$1; print}' || :
    )"
    [[ -n "$parent_death_grandchild_state" &&
       "$parent_death_grandchild_state" != Z* ]] || break
    sleep 0.01
  done
  parent_death_rv_after="$(jq -r '.metadata.resourceVersion' \
    "$STUB_STATE_DIR/serialization-lease.json")"
  if [[ -e "$STUB_STATE_DIR/parent-death-stream-terminated" &&
        ! -e "$STUB_STATE_DIR/parent-death-stream-completed" &&
        ! -e "$STUB_STATE_DIR/parent-death-owner-completed" &&
        "$parent_death_rv_before" == "$parent_death_rv_after" &&
        "$parent_death_grandchild_pid" =~ ^[1-9][0-9]*$ &&
        ( -z "$parent_death_grandchild_state" ||
          "$parent_death_grandchild_state" == Z* ) ]]; then
    pass 'parent SIGKILL kills orphaned stream group and stops Lease renewal'
  else
    fail 'parent SIGKILL kills orphaned stream group and stops Lease renewal' \
      "rv-before=$parent_death_rv_before rv-after=$parent_death_rv_after grandchild=$parent_death_grandchild_pid state=$parent_death_grandchild_state"
  fi
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == sigkill ]]; then
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused recovery safety test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused SIGKILL recovery safety tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

# Expansion is intentionally performed by the isolated Bash process.
# shellcheck disable=SC2016
expect_success 'managed bot-runner helper accepts one exact empty PodList' \
  env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_require_no_managed_bot_runner_pods
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
for partial_runner_mode in runner-app-only runner-managed-only runner-component-only; do
  reset_stub
  # Expansion is intentionally performed by the isolated Bash process.
  # shellcheck disable=SC2016
  expect_failure "managed bot-runner union rejects $partial_runner_mode" \
    'Managed bot-runner Pods remain' env EXPECTED_KUBE_CONTEXT=fixture-context \
    STUB_MODE="$partial_runner_mode" bash -c '
      set -euo pipefail
      NAMESPACE=hcce
      source "$1"
      recovery_require_no_managed_bot_runner_pods
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
done
reset_stub
# A parent-namespace Pod using the orchestrator ServiceAccount retains the
# projected API token even if it drops every runner label.
# shellcheck disable=SC2016
expect_failure 'orchestrator ServiceAccount Pod without runner labels fails closed' \
  'Managed bot-runner Pods remain' env EXPECTED_KUBE_CONTEXT=fixture-context \
  STUB_MODE=runner-parent-service-account bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_require_no_managed_bot_runner_pods
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
reset_stub
# The dedicated namespace has no workload except ephemeral runner Pods, so any
# Pod there is unsafe even when it strips every identifying label.
# shellcheck disable=SC2016
expect_failure 'unlabelled Pod in the dedicated runner namespace fails closed' \
  'Managed bot-runner Pods remain' env EXPECTED_KUBE_CONTEXT=fixture-context \
  STUB_RUNNER_NAMESPACE=present STUB_MODE=runner-namespace-unlabeled bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_require_no_managed_bot_runner_pods
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
reset_stub
# Expansion is intentionally performed by the isolated Bash process.
# shellcheck disable=SC2016
expect_failure 'managed bot-runner residual Pod fails closed' \
  'Managed bot-runner Pods remain' env EXPECTED_KUBE_CONTEXT=fixture-context \
  STUB_MODE=runner-residual bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_require_no_managed_bot_runner_pods
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
reset_stub
# Expansion is intentionally performed by the isolated Bash process.
# shellcheck disable=SC2016
expect_failure 'managed bot-runner deletion timeout fails closed' \
  'Timed out waiting for managed bot-runner pods' env EXPECTED_KUBE_CONTEXT=fixture-context \
  STUB_MODE=runner-timeout bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_wait_for_no_managed_bot_runner_pods 1s
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
reset_stub
# Expansion is intentionally performed by the isolated Bash process.
# shellcheck disable=SC2016
expect_success 'managed bot-runner event watcher completes ready/stop handshake' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid YENHUBS_WATCH_TEST_DEBUG=1 \
  RECOVERY_TEST_STABLE_ABSENCE_SECONDS=1 bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-monitor-stop.XXXXXX")"
    failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-monitor-failure.XXXXXX")"
    ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-monitor-ready.XXXXXX")"
    chmod 600 "$stop_path" "$failure_path" "$ready_path"
    trap '\''rm -f -- "$stop_path" "$failure_path" "$ready_path"'\'' EXIT
    watcher_pid=""
    recovery_start_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" watcher_pid
    recovery_require_no_managed_bot_runner_watch_healthy \
      "$failure_path" "$ready_path" "$watcher_pid"
    recovery_stop_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" "$watcher_pid"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
if [[ "$(cat "$STUB_STATE_DIR/runner-watch-count-hcce" 2>/dev/null || :)" -ge 2 ]]; then
  pass 'runner watcher completes a post-ready exact-RV round before honoring stop'
else
  fail 'runner watcher completes a post-ready exact-RV round before honoring stop' \
    "$(cat "$KUBECTL_LOG")"
fi
if [[ "$(cat "$STUB_STATE_DIR/runner-final-watch-count-hcce" 2>/dev/null || :)" -ge 2 ]]; then
  pass 'runner watcher retries early clean closes until the stable window elapses'
else
  fail 'runner watcher retries early clean closes until the stable window elapses' \
    "$(cat "$KUBECTL_LOG")"
fi
reset_stub
# The stop marker is written from boundary LIST resourceVersions. The watcher
# must use those exact RVs for its final round, which replays a transient event
# occurring after the boundary LIST instead of trusting a later empty LIST.
# shellcheck disable=SC2016
expect_success 'runner watcher covers a transient event in the final-close to stop gap' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  STUB_MODE=runner-watch-stop-gap-transient bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-stop-gap-stop.XXXXXX")"
    failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-stop-gap-failure.XXXXXX")"
    ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-stop-gap-ready.XXXXXX")"
    chmod 600 "$stop_path" "$failure_path" "$ready_path"
    trap '\''rm -f -- "$stop_path" "$failure_path" "$ready_path"'\'' EXIT
    watcher_pid=""
    recovery_start_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" watcher_pid
    if recovery_stop_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" "$watcher_pid"; then
      exit 1
    fi
    [[ "$(<"$failure_path")" == runner_watch_failed ]]
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
if [[ "$(cat "$STUB_STATE_DIR/runner-watch-count-hcce" 2>/dev/null || :)" -ge 3 ]]; then
  pass 'stop-boundary fixture required a post-marker watch round'
else
  fail 'stop-boundary fixture required a post-marker watch round' "$(cat "$KUBECTL_LOG")"
fi
last_hcce_watch="$(grep 'get --raw /api/v1/namespaces/hcce/pods?' "$KUBECTL_LOG" | tail -n 1 || :)"
if [[ "$last_hcce_watch" == *'resourceVersion=100'* &&
      "$last_hcce_watch" == *'timeoutSeconds=65'* ]]; then
  pass 'stop-boundary final watch uses exact RV and the 65-second safety window'
else
  fail 'stop-boundary final watch uses exact RV and the 65-second safety window' \
    "$last_hcce_watch"
fi
reset_stub
# A spawned kubectl process is not a usable handoff until the first exact-RV
# watch round for every namespace has closed successfully.
# shellcheck disable=SC2016
expect_failure 'runner watcher never marks ready when watch fails before its first event' \
  'before its ready handshake' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  STUB_MODE=runner-watch-fails-before-event bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-no-event-stop.XXXXXX")"
    failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-no-event-failure.XXXXXX")"
    ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-no-event-ready.XXXXXX")"
    chmod 600 "$stop_path" "$failure_path" "$ready_path"
    trap '\''rm -f -- "$stop_path" "$failure_path" "$ready_path"'\'' EXIT
    watcher_pid=""
    recovery_start_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" watcher_pid
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
if [[ -s "$STUB_STATE_DIR/runner-watch-count-hcce" ]]; then
  pass 'failed pre-event watch fixture executed without a ready handoff'
else
  fail 'failed pre-event watch fixture executed' 'watch command did not run'
fi
reset_stub
# The watch stream emits ADDED and DELETED back-to-back while every LIST is
# empty. A polling monitor would pass; the resourceVersion watch must fail.
# shellcheck disable=SC2016
expect_success 'runner ADDED+DELETED between empty LISTs is remembered fail-closed' \
  env EXPECTED_KUBE_CONTEXT=fixture-context STUB_MODE=runner-watch-transient bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-transient-stop.XXXXXX")"
    failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-transient-failure.XXXXXX")"
    ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-transient-ready.XXXXXX")"
    chmod 600 "$stop_path" "$failure_path" "$ready_path"
    trap '\''rm -f -- "$stop_path" "$failure_path" "$ready_path"'\'' EXIT
    if node "$2" --context fixture-context --namespace hcce \
      --runner-namespace hcce-bot-runners --stop "$stop_path" \
      --failure "$failure_path" --ready "$ready_path"; then
      exit 1
    fi
    [[ "$(<"$failure_path")" == runner_watch_failed ]]
    recovery_require_no_managed_bot_runner_pods
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
  "$ROOT_DIR/deployment/watch-bot-runner-pods.mjs"

reset_stub
# shellcheck disable=SC2016
expect_success 'parent orchestrator-SA Pod event without labels is remembered fail-closed' \
  env EXPECTED_KUBE_CONTEXT=fixture-context \
  STUB_MODE=runner-watch-parent-service-account bash -c '
    set -euo pipefail
    stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-sa-stop.XXXXXX")"
    failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-sa-failure.XXXXXX")"
    ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-sa-ready.XXXXXX")"
    chmod 600 "$stop_path" "$failure_path" "$ready_path"
    trap '\''rm -f -- "$stop_path" "$failure_path" "$ready_path"'\'' EXIT
    if node "$1" --context fixture-context --namespace hcce \
      --runner-namespace hcce-bot-runners --stop "$stop_path" \
      --failure "$failure_path" --ready "$ready_path"; then
      exit 1
    fi
    [[ "$(<"$failure_path")" == runner_watch_failed ]]
  ' _ "$ROOT_DIR/deployment/watch-bot-runner-pods.mjs"

reset_stub
# shellcheck disable=SC2016
expect_success 'unlabelled Pod event in runner namespace is remembered fail-closed' \
  env EXPECTED_KUBE_CONTEXT=fixture-context \
  STUB_MODE=runner-watch-runner-unlabeled bash -c '
    set -euo pipefail
    stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-unlabelled-stop.XXXXXX")"
    failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-unlabelled-failure.XXXXXX")"
    ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-unlabelled-ready.XXXXXX")"
    chmod 600 "$stop_path" "$failure_path" "$ready_path"
    trap '\''rm -f -- "$stop_path" "$failure_path" "$ready_path"'\'' EXIT
    if node "$1" --context fixture-context --namespace hcce \
      --runner-namespace hcce-bot-runners --stop "$stop_path" \
      --failure "$failure_path" --ready "$ready_path"; then
      exit 1
    fi
    [[ "$(<"$failure_path")" == runner_watch_failed ]]
  ' _ "$ROOT_DIR/deployment/watch-bot-runner-pods.mjs"

reset_stub
# shellcheck disable=SC2016
expect_success 'legacy component-only runner event is remembered fail-closed' \
  env EXPECTED_KUBE_CONTEXT=fixture-context \
  STUB_MODE=runner-watch-component-only bash -c '
    set -euo pipefail
    stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-component-stop.XXXXXX")"
    failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-component-failure.XXXXXX")"
    ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-component-ready.XXXXXX")"
    chmod 600 "$stop_path" "$failure_path" "$ready_path"
    trap '\''rm -f -- "$stop_path" "$failure_path" "$ready_path"'\'' EXIT
    if node "$1" --context fixture-context --namespace hcce \
      --runner-namespace hcce-bot-runners --stop "$stop_path" \
      --failure "$failure_path" --ready "$ready_path"; then
      exit 1
    fi
    [[ "$(<"$failure_path")" == runner_watch_failed ]]
  ' _ "$ROOT_DIR/deployment/watch-bot-runner-pods.mjs"

TAMPERED="$TMP_DIR/checkpoint-tampered-pair"; cp -R "$GOOD_CHECKPOINT" "$TAMPERED"; printf mutation >>"$TAMPERED/retdb-$STAMP.sql.gz"
reset_stub
expect_failure 'DB restore rejects checksum mismatch before Kubernetes' 'verification failed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-retdb.sh" "$TAMPERED/retdb-$STAMP.sql.gz"
assert_no_kube 'checksum rejection performs no kubectl call'

reset_stub
expect_success 'DB restore preflight validates the immutable pair read-only' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -Eq ' scale |dropdb| apply ' "$KUBECTL_LOG"; then fail 'DB preflight has no mutation' "$(cat "$KUBECTL_LOG")"; else pass 'DB preflight has no mutation'; fi

reset_stub
expect_failure 'DB preflight rejects a pgsql-labelled pod owned by an unrelated Deployment' \
  'Exactly one owned Ready PostgreSQL pod' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  RESTORE_PREFLIGHT=1 STUB_MODE=rogue-pgsql-owner \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -Eq ' exec |dropdb' "$KUBECTL_LOG"; then
  fail 'rogue PostgreSQL ownership performs no exec or drop' "$(cat "$KUBECTL_LOG")"
else
  pass 'rogue PostgreSQL ownership performs no exec or drop'
fi

reset_stub
expect_failure 'wrong context fails closed' 'context mismatch' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_PREFLIGHT=1 STUB_CURRENT_CONTEXT=wrong "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
reset_stub
expect_failure 'wrong namespace UID fails closed' 'Namespace UID mismatch' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_PREFLIGHT=1 STUB_NAMESPACE_UID=wrong "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
reset_stub
expect_failure 'generic DB confirmation is rejected' 'for this exact target' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE=retdb "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q ' scale ' "$KUBECTL_LOG"; then fail 'bad DB confirmation performs no scale' "$(cat "$KUBECTL_LOG")"; else pass 'bad DB confirmation performs no scale'; fi
reset_stub
seed_restore_lock
expect_failure 'consumer timeout blocks DB drop' 'Timed out waiting' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE="$CONFIRM_DB" STUB_MODE=timeout "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q dropdb "$KUBECTL_LOG"; then fail 'timeout performs no DB drop' "$(cat "$KUBECTL_LOG")"; else pass 'timeout performs no DB drop'; fi
reset_stub
seed_restore_lock
expect_failure 'residual managed bot-runner blocks DB restore before drop' \
  'Pods still remain for managed bot-runner' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 \
  CONFIRM_RESTORE="$CONFIRM_DB" STUB_MODE=runner-residual \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q dropdb "$KUBECTL_LOG"; then fail 'runner residual performs no DB drop' "$(cat "$KUBECTL_LOG")"; else pass 'runner residual performs no DB drop'; fi
reset_stub
seed_restore_lock
expect_failure 'managed bot-runner timeout blocks DB restore before drop' \
  'Timed out waiting for managed bot-runner pods' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 \
  CONFIRM_RESTORE="$CONFIRM_DB" STUB_MODE=runner-timeout \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q dropdb "$KUBECTL_LOG"; then fail 'runner timeout performs no DB drop' "$(cat "$KUBECTL_LOG")"; else pass 'runner timeout performs no DB drop'; fi
reset_stub
seed_restore_lock
expect_failure 'lock replacement after quiescence blocks before DB mutation' 'identity or operation binding changed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE="$CONFIRM_DB" STUB_MODE=restore-lock-replaced-after-quiesce "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q dropdb "$KUBECTL_LOG"; then fail 'post-quiesce lock replacement performs no DB drop' "$(cat "$KUBECTL_LOG")"; else pass 'post-quiesce lock replacement performs no DB drop'; fi
reset_stub
seed_restore_lock
expect_success 'exact DB confirmation restores and holds all consumers quiescent' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE="$CONFIRM_DB" "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q dropdb "$KUBECTL_LOG" && ! grep -q -- '--replicas=1' "$KUBECTL_LOG"; then pass 'DB child never resumes before storage validation'; else fail 'DB child never resumes before storage validation' "$(cat "$KUBECTL_LOG")"; fi
reset_stub
seed_restore_lock
expect_failure 'DB restore verifies exact active UUID set' 'does not exactly match' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE="$CONFIRM_DB" STUB_MODE=restored-uuid-mismatch "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
reset_stub
seed_restore_lock
expect_failure 'DB restore rejects same-count live relation drift after restore' 'does not exactly match the checksummed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE="$CONFIRM_DB" STUB_DB_CONTRACT="$DRIFTED_DATABASE_CONTRACT" "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"

reset_stub
expect_success 'storage preflight validates DB/archive/PVC without writes' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_STORAGE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -Eq ' scale | apply ' "$KUBECTL_LOG"; then fail 'storage preflight has no writes' "$(cat "$KUBECTL_LOG")"; else pass 'storage preflight has no writes'; fi
reset_stub
expect_failure 'storage preflight rejects wrong PVC UID' 'PVC UID mismatch' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=wrong RESTORE_STORAGE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
expect_failure 'storage preflight rejects empty DB active set' 'baseline is empty' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_STORAGE_PREFLIGHT=1 STUB_MODE=zero-db-active "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
expect_failure 'generic storage confirmation is rejected' 'for this exact target' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE=ret-pvc "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
seed_restore_lock
expect_failure 'extra PVC consumer blocks restore pod/write' 'Unexpected pods consume PVC' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=extra-consumer "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
seed_restore_lock
expect_failure 'PVC consumer monitor fails extraction on transient extra pod' 'Unexpected pods consume PVC' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=monitor-extra PVC_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
seed_restore_lock
expect_failure 'storage monitor catches managed bot-runner reappearance during PVC write' \
  'monitoring failed' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" \
  STUB_MODE=runner-reappears-during-storage PVC_MONITOR_INTERVAL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
seed_restore_lock
expect_failure 'restore pod creation is exclusive across concurrent runs' 'remain at zero' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=restore-pod-already-exists "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -q 'create -f -' "$KUBECTL_LOG" &&
   ! grep -q 'tar -C /storage -xf -' "$KUBECTL_LOG" &&
   ! grep -q 'delete pod ret-storage-restore' "$KUBECTL_LOG"; then
  pass 'failed create never adopts, extracts through or deletes a concurrent pod'
else
  fail 'failed create never adopts, extracts through or deletes a concurrent pod' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
seed_restore_lock
expect_failure 'restore rejects an admitted decoy mount before extraction' 'exact safe contract' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=restore-pod-decoy "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -q 'tar -C /storage -xf -' "$KUBECTL_LOG"; then fail 'admitted decoy mount is rejected before extraction' "$(cat "$KUBECTL_LOG")"; else pass 'admitted decoy mount is rejected before extraction'; fi
reset_stub
seed_restore_lock
expect_failure 'restore rejects an admitted extra volume before extraction' 'exact safe contract' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=restore-pod-extra-volume "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -q 'tar -C /storage -xf -' "$KUBECTL_LOG"; then fail 'admitted extra volume is rejected before extraction' "$(cat "$KUBECTL_LOG")"; else pass 'admitted extra volume is rejected before extraction'; fi
reset_stub
seed_restore_lock
expect_failure 'restore monitor rejects same-name pod replacement' 'monitoring failed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=restore-pod-replaced PVC_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -q 'delete pod ret-storage-restore' "$KUBECTL_LOG"; then fail 'restore never deletes a same-name replacement pod' "$(cat "$KUBECTL_LOG")"; else pass 'restore never deletes a same-name replacement pod'; fi
reset_stub
seed_restore_lock
expect_failure 'non-empty PVC destination is never merged' 'non-empty or unsafe' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=destination-nonempty "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
seed_restore_lock
expect_failure 'storage restore rejects quiesced same-count DB contract drift before PVC write' 'does not match the checksummed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_DB_CONTRACT="$DRIFTED_DATABASE_CONTRACT" "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -q 'create -f -' "$KUBECTL_LOG"; then fail 'quiesced DB drift creates no restore pod' "$(cat "$KUBECTL_LOG")"; else pass 'quiesced DB drift creates no restore pod'; fi
reset_stub
seed_restore_lock
expect_failure 'storage restore rejects same-count active UUID drift after quiescing' 'changed before storage extraction' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=active-drift-after "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -q 'create -f -' "$KUBECTL_LOG"; then fail 'active UUID drift creates no restore pod' "$(cat "$KUBECTL_LOG")"; else pass 'active UUID drift creates no restore pod'; fi
reset_stub
seed_restore_lock
expect_success 'exact storage confirmation restores exclusively and remains quiescent' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" PVC_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -q 'create -f -' "$KUBECTL_LOG" && ! grep -q -- '--replicas=1' "$KUBECTL_LOG"; then pass 'storage child never resumes before joint validation'; else fail 'storage child never resumes before joint validation' "$(cat "$KUBECTL_LOG")"; fi
storage_held_zero=true
for storage_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$storage_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$storage_consumer")" != 0 ]]; then
    storage_held_zero=false
  fi
done
if [[ "$storage_held_zero" == true ]]; then pass 'storage child independently holds every DB consumer at zero'; else fail 'storage child independently holds every DB consumer at zero' "$(cat "$KUBECTL_LOG")"; fi
if grep -q 'runAsNonRoot: true' "$STUB_STATE_DIR/applied.yaml" && grep -q 'runAsUser: 1000' "$STUB_STATE_DIR/applied.yaml" && grep -q 'runAsGroup: 1000' "$STUB_STATE_DIR/applied.yaml" && grep -q 'fsGroup: 1000' "$STUB_STATE_DIR/applied.yaml" && grep -q 'readOnlyRootFilesystem: true' "$STUB_STATE_DIR/applied.yaml" && grep -q 'automountServiceAccountToken: false' "$STUB_STATE_DIR/applied.yaml"; then pass 'restore pod has complete nonroot hardening'; else fail 'restore pod has complete nonroot hardening' "$(cat "$STUB_STATE_DIR/applied.yaml")"; fi
if grep -q '^kind: NetworkPolicy$' "$STUB_STATE_DIR/create-payload-1.yaml" &&
   grep -q '^kind: Pod$' "$STUB_STATE_DIR/create-payload-2.yaml" &&
   grep -q 'name: ret-storage-restore-deny-888888888888' "$STUB_STATE_DIR/create-payload-1.yaml" &&
   grep -q 'name: ret-storage-restore-888888888888' "$STUB_STATE_DIR/create-payload-2.yaml"; then
  pass 'operation-unique deny-all policy is admitted before the restore pod'
else
  fail 'operation-unique deny-all policy is admitted before the restore pod' "$(cat "$STUB_STATE_DIR"/create-payload-*.yaml)"
fi
if [[ "$(find "$STUB_STATE_DIR" -maxdepth 1 -name 'delete-options-*.json' | wc -l | tr -d ' ')" == 2 ]] &&
   jq -e '.apiVersion == "v1" and .kind == "DeleteOptions" and
     .propagationPolicy == "Foreground" and
     (.preconditions.uid == "restore-pod-uid" or .preconditions.uid == "network-policy-uid")' \
     "$STUB_STATE_DIR"/delete-options-*.json >/dev/null; then
  pass 'helper cleanup emits exact UID-preconditioned DeleteOptions only'
else
  fail 'helper cleanup emits exact UID-preconditioned DeleteOptions only' "$(cat "$STUB_STATE_DIR"/delete-options-*.json 2>/dev/null || :)"
fi

reset_stub
CHECKPOINT_INVENTORY_SHA="$(sha256_digest "$GOOD_CHECKPOINT/deployment-images.json")"
PREPARE_FENCE_CONFIRMATION="prepare-fence:fixture-context:hcce:fixture-uid:fixture-pvc-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:$CHECKPOINT_INVENTORY_SHA:$LIVE_RUNNER_EPOCH:33333333-3333-4333-8333-333333333333"
test_yaml_field() {
  local pattern="$1" file="$2"
  awk -v pattern="$pattern" '$0 ~ pattern {value=$0; sub(/^[^:]+:[[:space:]]*/, "", value); gsub(/^"|"$/, "", value); print value; exit}' "$file"
}
prepare_fence_fixture() {
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid     EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE"     RESTORE_CHECKPOINT_PREPARE_FENCE=1     CONFIRM_PREPARE_RESTORE_FENCE="$PREPARE_FENCE_CONFIRMATION"     "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
}
apply_restore_fence_fixture() {
  local deployment
  printf '%s' restore-fence >"$STUB_STATE_DIR/recovery-phase"
  printf '%s' 33333333-3333-4333-8333-333333333333 >"$STUB_STATE_DIR/recovery-epoch"
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    [[ -f "$STUB_STATE_DIR/replicas-$deployment" &&
       "$(cat "$STUB_STATE_DIR/replicas-$deployment")" == 0 ]] || return 1
    printf '%s' 3 >"$STUB_STATE_DIR/rv-$deployment"
  done
}
execute_fence_confirmation() {
  local operation_id
  operation_id="$(test_yaml_field 'yenhubs.org/operation-id:' "$STUB_STATE_DIR/restore-lock.yaml")"
  printf 'execute-fenced:fixture-context:hcce:fixture-uid:fixture-pvc-uid:%s:%s:%s:%s:%s:%s:restore-lock-uid:%s'     "$STAMP" "$DUMP_SHA" "$STORAGE_SHA" "$CHECKPOINT_INVENTORY_SHA"     "$LIVE_RUNNER_EPOCH" 33333333-3333-4333-8333-333333333333 "$operation_id"
}
execute_fenced_fixture() {
  local confirmation
  confirmation="$(execute_fence_confirmation)"
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid     EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE"     RESTORE_CHECKPOINT_EXECUTE_FENCED=1     CONFIRM_EXECUTE_RESTORE_FENCE="$confirmation"     PVC_MONITOR_INTERVAL_SECONDS=0.01     "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
}

apply_active_reactivation_fixture() {
  local deployment
  printf '%s' active >"$STUB_STATE_DIR/recovery-phase"
  printf '%s' 33333333-3333-4333-8333-333333333333 >"$STUB_STATE_DIR/recovery-epoch"
  printf '%s' runner-role-uid >"$STUB_STATE_DIR/runner-role-uid"
  printf '%s' active >"$STUB_STATE_DIR/runner-role-phase"
  printf '%s' '[{"apiGroups":[""],"resources":["pods"],"verbs":["create","delete","get","list"]}]' \
    >"$STUB_STATE_DIR/runner-role-rules.json"
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '%s' 1 >"$STUB_STATE_DIR/replicas-$deployment"
    printf '%s' 4 >"$STUB_STATE_DIR/rv-$deployment"
  done
}
finalize_fence_confirmation() {
  local operation_id
  operation_id="$(test_yaml_field 'yenhubs.org/operation-id:' \
    "$STUB_STATE_DIR/restore-lock.yaml")"
  printf 'finalize-reactivation:fixture-context:hcce:fixture-uid:fixture-pvc-uid:%s:%s:%s:%s:%s:%s:restore-lock-uid:%s' \
    "$STAMP" "$DUMP_SHA" "$STORAGE_SHA" "$CHECKPOINT_INVENTORY_SHA" \
    "$LIVE_RUNNER_EPOCH" 33333333-3333-4333-8333-333333333333 "$operation_id"
}

LIVE_IMAGE_DRIFT_JSON="$TMP_DIR/deployments-live-image-drift.json"
jq '(.items[] | select(.metadata.name == "reticulum") |
  .spec.template.spec.containers[] | select(.name == "reticulum") | .image) =
  ("ghcr.io/yengalvez/reticulum@sha256:" + ("9" * 64))' \
  "$STUB_DEPLOYMENTS_JSON" >"$LIVE_IMAGE_DRIFT_JSON"
expect_failure 'coordinated preflight rejects same-repository live digest drift' \
  'live workload image inventory' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_VALUES_FIXTURE" RESTORE_CHECKPOINT_PREFLIGHT=1 \
  STUB_DEPLOYMENTS_JSON="$LIVE_IMAGE_DRIFT_JSON" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if grep -Eq ' scale |dropdb|tar -C /storage -xf -' "$KUBECTL_LOG"; then
  fail 'live image drift preflight performs no mutation' "$(cat "$KUBECTL_LOG")"
else
  pass 'live image drift preflight performs no mutation'
fi
reset_stub

expect_failure 'prepare-fence rejects a generic confirmation before scaling'   'Refusing restore fence phase' env EXPECTED_KUBE_CONTEXT=fixture-context   EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid   VALUES_FILE="$RESTORE_VALUES_FIXTURE" RESTORE_CHECKPOINT_PREPARE_FENCE=1   CONFIRM_PREPARE_RESTORE_FENCE=prepare-fence   "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if grep -q ' scale ' "$KUBECTL_LOG"; then
  fail 'bad prepare-fence confirmation performs no scale' "$(cat "$KUBECTL_LOG")"
else
  pass 'bad prepare-fence confirmation performs no scale'
fi

reset_stub
expect_failure 'a second prepare-fence cannot cross an active global lock'   'Another recovery operation owns' env EXPECTED_KUBE_CONTEXT=fixture-context   EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid   VALUES_FILE="$RESTORE_VALUES_FIXTURE" RESTORE_CHECKPOINT_PREPARE_FENCE=1   CONFIRM_PREPARE_RESTORE_FENCE="$PREPARE_FENCE_CONFIRMATION"   STUB_MODE=restore-lock-exists   "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if grep -q 'create -f -' "$KUBECTL_LOG" &&
   ! grep -Eq ' scale |dropdb|delete --raw=.*/configmaps/' "$KUBECTL_LOG"; then
  pass 'prepare-fence lock contender never scales, restores or deletes owner state'
else
  fail 'prepare-fence lock contender never mutates owner state' "$(cat "$KUBECTL_LOG")"
fi

run_restore_role_retry_test

reset_stub
expect_success 'prepare-fence persistently quiesces all five consumers under the exact lock'   prepare_fence_fixture
prepared_zero=true
for prepared_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$prepared_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$prepared_consumer")" != 0 ]]; then
    prepared_zero=false
  fi
done
if [[ "$prepared_zero" == true && -f "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   grep -q 'yenhubs.org/recovery-state: "restore-fence-prepared"'      "$STUB_STATE_DIR/restore-lock.yaml" &&
   grep -q "yenhubs.org/deployment-inventory-sha256: \"$CHECKPOINT_INVENTORY_SHA\""      "$STUB_STATE_DIR/restore-lock.yaml" &&
   ! grep -Eq 'dropdb|tar -C /storage -xf -|--replicas=1' "$KUBECTL_LOG"; then
  pass 'prepare-fence retains its checkpoint-bound lock and performs no restore'
else
  fail 'prepare-fence exact persistent contract' "$(cat "$KUBECTL_LOG")"
fi

execute_before_manifest_confirmation="$(execute_fence_confirmation)"
: >"$KUBECTL_LOG"
expect_failure 'execute-fenced rejects the pre-fence live epoch before standard manifest apply'   'live restore-fence epoch is not the exact new candidate' env   EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid   EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE"   RESTORE_CHECKPOINT_EXECUTE_FENCED=1   CONFIRM_EXECUTE_RESTORE_FENCE="$execute_before_manifest_confirmation"   "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if grep -Eq 'dropdb|tar -C /storage -xf -' "$KUBECTL_LOG"; then
  fail 'pre-manifest execute performs no restore' "$(cat "$KUBECTL_LOG")"
else
  pass 'pre-manifest execute performs no restore'
fi

apply_restore_fence_fixture
: >"$KUBECTL_LOG"
# shellcheck disable=SC2016 # Expanded by the isolated fixture process.
expect_success 'live recovery phase reads the exact Deployment metadata annotation'   env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_require_live_runner_recovery_phase restore-fence
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

: >"$KUBECTL_LOG"
expect_failure 'execute-fenced rejects a generic confirmation after manifest apply'   'Refusing restore fence phase' env EXPECTED_KUBE_CONTEXT=fixture-context   EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid   VALUES_FILE="$RESTORE_VALUES_FIXTURE" RESTORE_CHECKPOINT_EXECUTE_FENCED=1   CONFIRM_EXECUTE_RESTORE_FENCE=execute-fenced   "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if grep -Eq 'dropdb|tar -C /storage -xf -' "$KUBECTL_LOG"; then
  fail 'bad execute-fenced confirmation performs no restore' "$(cat "$KUBECTL_LOG")"
else
  pass 'bad execute-fenced confirmation performs no restore'
fi

: >"$KUBECTL_LOG"
expect_success 'execute-fenced restores both checkpoint halves and remains persistently fenced'   execute_fenced_fixture
drop_line="$(grep -n 'dropdb' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
extract_line="$(grep -n 'tar -C /storage -xf -' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
replace_line="$(grep -n 'replace -f - -o json' "$KUBECTL_LOG" | tail -1 | cut -d: -f1 || :)"
executed_zero=true
for executed_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$executed_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$executed_consumer")" != 0 ]]; then
    executed_zero=false
  fi
done
if [[ "$drop_line" =~ ^[0-9]+$ && "$extract_line" =~ ^[0-9]+$ &&
      "$replace_line" =~ ^[0-9]+$ && "$drop_line" -lt "$extract_line" &&
      "$extract_line" -lt "$replace_line" && "$executed_zero" == true &&
      -f "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   grep -q 'restore-complete-awaiting-reactivation' "$STUB_STATE_DIR/restore-lock.yaml" &&
   ! grep -Eq -- '--replicas=1|delete --raw=.*/configmaps/yenhubs-recovery-operation-lock'      "$KUBECTL_LOG"; then
  pass 'execute-fenced CASes the retained lock only after DB, storage and joint validation'
else
  fail 'execute-fenced persistent post-restore fence contract' "$(cat "$KUBECTL_LOG")"
fi

apply_active_reactivation_fixture
finalize_confirmation="$(finalize_fence_confirmation)"
: >"$KUBECTL_LOG"
expect_failure 'finalizer fail-close fences through missing lock, Role replacement and Deployment replacement' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
  RESTORE_CHECKPOINT_FINALIZE_REACTIVATION=1 \
  CONFIRM_FINALIZE_RESTORE_REACTIVATION="$finalize_confirmation" \
  STUB_MODE=finalizer-failclose-drift STUB_RUNNER_NAMESPACE=present \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
finalizer_all_fences_attempted=true
for finalizer_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$finalizer_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$finalizer_consumer")" != 0 ]] ||
     ! grep -Eq "scale deployment $finalizer_consumer .*--replicas=0" \
       "$KUBECTL_LOG"; then
    finalizer_all_fences_attempted=false
  fi
done
if [[ "$finalizer_all_fences_attempted" == true &&
      ! -e "$STUB_STATE_DIR/restore-lock.yaml" &&
      "$(cat "$STUB_STATE_DIR/runner-role-uid")" == replacement-runner-role-uid &&
      "$(cat "$STUB_STATE_DIR/runner-role-phase")" == restore-fence ]] &&
   jq -e '. == []' "$STUB_STATE_DIR/runner-role-rules.json" >/dev/null &&
   grep -q 'delete --raw=/api/v1/namespaces/hcce-bot-runners/pods/bot-runner-fixture' \
     "$KUBECTL_LOG"; then
  pass 'fail-close aggregates drift only after Role, five zero fences and runner UID delete'
else
  fail 'fail-close skipped a reductive fence after drift' "$(cat "$KUBECTL_LOG")"
fi

reset_stub
expect_success 'failure fixture prepares a new persistent fence' prepare_fence_fixture
apply_restore_fence_fixture
failed_execute_confirmation="$(execute_fence_confirmation)"
: >"$KUBECTL_LOG"
expect_failure 'coordinated storage failure retains every consumer at zero and the exact lock'   'non-empty or unsafe' env EXPECTED_KUBE_CONTEXT=fixture-context   EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid   VALUES_FILE="$RESTORE_VALUES_FIXTURE" RESTORE_CHECKPOINT_EXECUTE_FENCED=1   CONFIRM_EXECUTE_RESTORE_FENCE="$failed_execute_confirmation"   STUB_MODE=destination-nonempty PVC_MONITOR_INTERVAL_SECONDS=0.01   "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
failure_held_zero=true
for failed_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$failed_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$failed_consumer")" != 0 ]]; then
    failure_held_zero=false
  fi
done
if [[ "$failure_held_zero" == true && -f "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   ! grep -Eq -- '--replicas=1|delete --raw=.*/configmaps/yenhubs-recovery-operation-lock'      "$KUBECTL_LOG"; then
  pass 'failed execute-fenced has no partial resume or lock release'
else
  fail 'failed execute-fenced remains fail-closed' "$(cat "$KUBECTL_LOG")"
fi

reset_stub
seed_restore_lock available
CONFIRM_CLEAR_LOCK="restore-lock:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:restore-lock-uid:fixture-pvc-uid"
: >"$KUBECTL_LOG"
expect_failure 'stale restore lock rejects generic clearance' 'for this exact target' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 CONFIRM_CLEAR_RESTORE_LOCK=restore-lock "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   ! grep -Eq ' scale |delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG"; then
  pass 'bad stale-lock confirmation neither resumes nor deletes'
else
  fail 'bad stale-lock confirmation neither resumes nor deletes' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
seed_restore_lock available
seed_stale_restore_helper
expect_failure 'bad stale-lock confirmation preserves the exact helper and policy' \
  'for this exact target' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 CONFIRM_CLEAR_RESTORE_LOCK=restore-lock \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if [[ -e "$STUB_STATE_DIR/pod-created" && -e "$STUB_STATE_DIR/network-policy.yaml" &&
      -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && ! grep -q 'delete --raw=' "$KUBECTL_LOG"; then
  pass 'bad stale-lock confirmation performs no helper, policy or lock deletion'
else
  fail 'bad stale-lock confirmation performs no helper, policy or lock deletion' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
seed_restore_lock available
for stale_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  printf 0 >"$STUB_STATE_DIR/replicas-$stale_consumer"
done
: >"$KUBECTL_LOG"
expect_success 'exact stale-lock clearance is a clear-only recovery action' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 CONFIRM_CLEAR_RESTORE_LOCK="$CONFIRM_CLEAR_LOCK" "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   grep -q 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG" &&
   ! grep -Eq ' scale |rollout status' "$KUBECTL_LOG"; then
  pass 'stale-lock clearance deletes only the pinned lock and resumes nothing'
else
  fail 'stale-lock clearance deletes only the pinned lock and resumes nothing' "$(cat "$KUBECTL_LOG")"
fi

run_stale_helper_cleanup_tests

reset_stub
DB_BACKUP="$TMP_DIR/backup/retdb-$STAMP.sql.gz"
expect_success 'DB backup validates complete SQL marker/COPY contract' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid "$ROOT_DIR/deployment/backup-retdb.sh" "$DB_BACKUP"
if [[ "$(file_mode "$DB_BACKUP")" == 600 ]]; then pass 'DB backup is mode 0600'; else fail 'DB backup is mode 0600' "mode=$(file_mode "$DB_BACKUP")"; fi
reset_stub
expect_failure 'DB backup rejects live contract drift during pg_dump' 'changed while the dump' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid STUB_MODE=contract-drift-after "$ROOT_DIR/deployment/backup-retdb.sh" "$TMP_DIR/drift-backup/retdb-$STAMP.sql.gz"
reset_stub
expect_failure 'DB backup rejects source/dump active mismatch' 'complete critical' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid STUB_SQL_PLAIN="$ZERO_ACTIVE_PLAIN" "$ROOT_DIR/deployment/backup-retdb.sh" "$TMP_DIR/bad-backup/retdb-$STAMP.sql.gz"

reset_stub
STORAGE_BACKUP="$TMP_DIR/backup/ret-storage-$STAMP.tar.gz"
expect_success 'storage backup validates complete pairs and pinned PVC/pod identity' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_OPERATION=storage-backup STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/backup-ret-storage.sh" "$STORAGE_BACKUP"
if [[ "$(file_mode "$STORAGE_BACKUP")" == 600 ]]; then pass 'storage backup is mode 0600'; else fail 'storage backup is mode 0600' "mode=$(file_mode "$STORAGE_BACKUP")"; fi
reset_stub
expect_failure 'storage backup rejects the wrong PVC UID before tar' 'PVC UID mismatch' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=wrong STUB_OPERATION=storage-backup "$ROOT_DIR/deployment/backup-ret-storage.sh" "$TMP_DIR/wrong-pvc/ret-storage-$STAMP.tar.gz"
reset_stub
expect_failure 'storage backup rejects any extra ret-pvc consumer before tar' 'Unexpected pods consume PVC' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_OPERATION=storage-backup STUB_MODE=backup-extra-consumer "$ROOT_DIR/deployment/backup-ret-storage.sh" "$TMP_DIR/extra-consumer/ret-storage-$STAMP.tar.gz"
reset_stub
expect_failure 'storage backup monitor catches a transient extra ret-pvc consumer' 'monitor failed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_OPERATION=storage-backup STUB_MODE=backup-monitor-extra STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/backup-ret-storage.sh" "$TMP_DIR/monitor-extra/ret-storage-$STAMP.tar.gz"
for mount_mutation in decoy-mount other-container other-claim subpath; do
  reset_stub
  expect_failure "storage backup rejects $mount_mutation PVC source mutation before tar" \
    'unique direct ret-pvc mount' env EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    STUB_OPERATION=storage-backup STUB_MODE="backup-$mount_mutation" \
    "$ROOT_DIR/deployment/backup-ret-storage.sh" \
    "$TMP_DIR/$mount_mutation/ret-storage-$STAMP.tar.gz"
  if grep -q 'tar -C /storage -cf - owned' "$KUBECTL_LOG"; then
    fail "storage backup rejects $mount_mutation before tar" "$(cat "$KUBECTL_LOG")"
  else
    pass "storage backup rejects $mount_mutation before tar"
  fi
done

reset_stub
CAPTURE_DIR="$TMP_DIR/captured-state"
expect_success 'legacy state capture does not require an unbuilt runner candidate digest' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  "$ROOT_DIR/deployment/capture-instance-state.sh" "$CAPTURE_DIR"
if grep -R -q SECRET_SENTINEL "$CAPTURE_DIR"; then fail 'capture excludes env/args/commands/annotations/values' 'secret sentinel leaked'; else pass 'capture excludes env/args/commands/annotations/values'; fi
if jq -e '.items[0].data_keys == ["credential"] and .items[0].binary_data_keys == ["certificate"]' "$CAPTURE_DIR/k8s-configmaps-redacted.json" >/dev/null && jq -e '
  .schema_version == 3 and .bot_runner_runtime == {
    mode:"process-local",image:null,control_plane:{state:"legacy-absent"},
    recovery_epoch:{state:"legacy-absent"}}
  and (.deployments | length) == 12
  and ([.deployments[] | select(.name == "pgsql") | .containers[].name] ==
    ["postgresql"])
' "$CAPTURE_DIR/deployment-images.json" >/dev/null; then pass 'capture preserves exact deployments and explicit legacy runner rollback mode'; else fail 'capture preserves exact deployments and explicit legacy runner rollback mode' 'invalid inventory'; fi
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$CAPTURE_DIR/deployment-images.json"; then
  pass 'checkpoint inventory accepts the explicit process-local runner rollback mode'
else
  fail 'checkpoint inventory accepts the explicit process-local runner rollback mode' 'valid rollback inventory rejected'
fi
PROCESS_LOCAL_WRONG_PGSQL_INVENTORY="$TMP_DIR/deployment-images-process-local-wrong-pgsql.json"
jq '(.deployments[] | select(.name == "pgsql") | .containers[0].name) = "pgsql"' \
  "$CAPTURE_DIR/deployment-images.json" >"$PROCESS_LOCAL_WRONG_PGSQL_INVENTORY"
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$PROCESS_LOCAL_WRONG_PGSQL_INVENTORY"; then
  fail 'process-local inventory rejects the AUD-075 pgsql/pgsql identity' \
    'mixed process-local inventory accepted'
else
  pass 'process-local inventory rejects the AUD-075 pgsql/pgsql identity'
fi
BOUND_PROCESS_LOCAL_INVENTORY="$TMP_DIR/deployment-images-process-local-bound-epoch.json"
jq --arg epoch "$CHECKPOINT_RUNNER_EPOCH" '
  .bot_runner_runtime.recovery_epoch = {state:"bound",value:$epoch}
' "$CAPTURE_DIR/deployment-images.json" >"$BOUND_PROCESS_LOCAL_INVENTORY"
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$BOUND_PROCESS_LOCAL_INVENTORY"; then
  fail 'checkpoint inventory rejects a recovery epoch bound to process-local mode' \
    'inconsistent process-local epoch accepted'
else
  pass 'checkpoint inventory rejects a recovery epoch bound to process-local mode'
fi
reset_stub
expect_failure 'Kubernetes runner capture rejects a missing private candidate digest' \
  'does not match the private candidate override' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  "$ROOT_DIR/deployment/capture-instance-state.sh" "$TMP_DIR/capture-k8s-no-candidate"
MISMATCHED_KUBERNETES_DEPLOYMENTS_JSON="$TMP_DIR/deployments-kubernetes-runner-mismatch.json"
jq --arg image "ghcr.io/yengalvez/bot-runner@sha256:${RUNNER_DIGEST_IMAGE##*@sha256:}" '
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
    .env[0].value) = ($image | sub("8$"; "9"))
' "$KUBERNETES_DEPLOYMENTS_JSON" >"$MISMATCHED_KUBERNETES_DEPLOYMENTS_JSON"
reset_stub
expect_failure 'Kubernetes runner capture rejects a live/private digest mismatch' \
  'does not match the private candidate override' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid \
  STUB_DEPLOYMENTS_JSON="$MISMATCHED_KUBERNETES_DEPLOYMENTS_JSON" \
  VALUES_FILE="$VALUES_FIXTURE" \
  "$ROOT_DIR/deployment/capture-instance-state.sh" "$TMP_DIR/capture-k8s-mismatch"
PARTIAL_KUBERNETES_DEPLOYMENTS_JSON="$TMP_DIR/deployments-partial-kubernetes-runner.json"
jq '
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
    .env) = [{name:"ORCHESTRATOR_POD_UID",value:"partial"}]
' "$STUB_DEPLOYMENTS_JSON" >"$PARTIAL_KUBERNETES_DEPLOYMENTS_JSON"
reset_stub
expect_failure 'process-local capture rejects partial Kubernetes runner bindings' \
  'partial Kubernetes runner bindings' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid \
  STUB_DEPLOYMENTS_JSON="$PARTIAL_KUBERNETES_DEPLOYMENTS_JSON" \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  "$ROOT_DIR/deployment/capture-instance-state.sh" "$TMP_DIR/capture-partial-k8s"
KUBERNETES_RUNNER_INVENTORY="$TMP_DIR/deployment-images-kubernetes-runner.json"
jq --arg image "$RUNNER_DIGEST_IMAGE" --arg epoch "$CHECKPOINT_RUNNER_EPOCH" '
  .bot_runner_runtime.mode = "kubernetes-pod" |
  .bot_runner_runtime.image = $image |
  (.deployments[] | select(.name == "pgsql") |
    .containers[0].name) = "pgsql" |
  .bot_runner_runtime.recovery_epoch = {
    state:"bound",value:$epoch
  } |
  .bot_runner_runtime.control_plane = {
    state:"kubernetes-active",
    namespaces:[
      {api_version:"v1",kind:"Namespace",name:"hcce",uid:"fixture-uid"},
      {api_version:"v1",kind:"Namespace",name:"hcce-bot-runners",uid:"fixture-runner-namespace-uid"}
    ],
    namespaced_resources:[
      {api_version:"v1",kind:"Secret",namespace:"hcce-bot-runners",name:"bot-images-pull",uid:"uid-bot-images-pull"},
      {api_version:"v1",kind:"ServiceAccount",namespace:"hcce-bot-runners",name:"bot-runner",uid:"uid-bot-runner"},
      {api_version:"v1",kind:"ResourceQuota",namespace:"hcce-bot-runners",name:"bot-runner-capacity",uid:"uid-bot-runner-capacity"},
      {api_version:"rbac.authorization.k8s.io/v1",kind:"Role",namespace:"hcce-bot-runners",name:"bot-orchestrator-runner-pods",uid:"uid-bot-orchestrator-runner-pods"},
      {api_version:"rbac.authorization.k8s.io/v1",kind:"RoleBinding",namespace:"hcce-bot-runners",name:"bot-orchestrator-runner-pods",uid:"uid-bot-orchestrator-runner-pods"},
      {api_version:"networking.k8s.io/v1",kind:"NetworkPolicy",namespace:"hcce-bot-runners",name:"bot-runner-default-deny",uid:"uid-bot-runner-default-deny"},
      {api_version:"networking.k8s.io/v1",kind:"NetworkPolicy",namespace:"hcce-bot-runners",name:"bot-runner-egress",uid:"uid-bot-runner-egress"}
    ],
    cluster_resources:[
      {api_version:"admissionregistration.k8s.io/v1",kind:"ValidatingAdmissionPolicy",name:"bot-runner-pods.yenhubs.org",uid:"uid-validatingadmissionpolicy"},
      {api_version:"admissionregistration.k8s.io/v1",kind:"ValidatingAdmissionPolicyBinding",name:"bot-runner-pods.yenhubs.org",uid:"uid-validatingadmissionpolicybinding"}
    ]
  }
' \
  "$CAPTURE_DIR/deployment-images.json" >"$KUBERNETES_RUNNER_INVENTORY"
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid "" "$3"' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$KUBERNETES_RUNNER_INVENTORY" \
  "$RUNNER_DIGEST_IMAGE"; then
  pass 'checkpoint inventory accepts one expected digest-pinned Kubernetes runner image'
else
  fail 'checkpoint inventory accepts one expected digest-pinned Kubernetes runner image' 'valid Kubernetes runner inventory rejected'
fi
KUBERNETES_WRONG_PGSQL_INVENTORY="$TMP_DIR/deployment-images-kubernetes-wrong-pgsql.json"
jq '(.deployments[] | select(.name == "pgsql") | .containers[0].name) = "postgresql"' \
  "$KUBERNETES_RUNNER_INVENTORY" >"$KUBERNETES_WRONG_PGSQL_INVENTORY"
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$KUBERNETES_WRONG_PGSQL_INVENTORY"; then
  fail 'Kubernetes runner inventory rejects historical pgsql/postgresql fallback' \
    'mixed Kubernetes inventory accepted'
else
  pass 'Kubernetes runner inventory rejects historical pgsql/postgresql fallback'
fi
MISSING_RUNNER_CONTROL_RESOURCE="$TMP_DIR/deployment-images-kubernetes-runner-missing-resource.json"
jq '.bot_runner_runtime.control_plane.namespaced_resources |= map(select(.name != "bot-runner-egress"))' \
  "$KUBERNETES_RUNNER_INVENTORY" >"$MISSING_RUNNER_CONTROL_RESOURCE"
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$MISSING_RUNNER_CONTROL_RESOURCE"; then
  fail 'checkpoint inventory rejects omitted runner control-plane resource' 'omission accepted'
else
  pass 'checkpoint inventory rejects omitted runner control-plane resource'
fi
reset_stub
# shellcheck disable=SC2016 # Expanded by the isolated fixture process.
if env EXPECTED_KUBE_CONTEXT=fixture-context STUB_RUNNER_NAMESPACE=present bash -c '
  set -euo pipefail
  NAMESPACE=hcce
  source "$1"
  recovery_require_live_runner_control_plane_matches_checkpoint "$2"
' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$KUBERNETES_RUNNER_INVENTORY"; then
  pass 'live runner control-plane identity matches every checksummed checkpoint UID'
else
  fail 'live runner control-plane identity matches every checksummed checkpoint UID' 'valid live inventory rejected'
fi
reset_stub
# shellcheck disable=SC2016 # Expanded by the isolated fixture process.
if env EXPECTED_KUBE_CONTEXT=fixture-context STUB_RUNNER_NAMESPACE=present \
  STUB_RUNNER_RESOURCE_DRIFT=bot-runner-egress bash -c '
  set -euo pipefail
  NAMESPACE=hcce
  source "$1"
  recovery_require_live_runner_control_plane_matches_checkpoint "$2"
' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$KUBERNETES_RUNNER_INVENTORY"; then
  fail 'live runner control-plane UID drift blocks restore' 'drift accepted'
else
  pass 'live runner control-plane UID drift blocks restore'
fi
for bad_runner_kind in tag repository; do
  BAD_RUNNER_INVENTORY="$TMP_DIR/deployment-images-bad-runner-$bad_runner_kind.json"
  if [[ "$bad_runner_kind" == tag ]]; then
    bad_runner_image='ghcr.io/yengalvez/bot-runner:latest'
  else
    bad_runner_image='evil.invalid/yengalvez/bot-runner@sha256:8888888888888888888888888888888888888888888888888888888888888888'
  fi
  jq --arg image "$bad_runner_image" \
    '.bot_runner_runtime.image = $image' \
    "$CAPTURE_DIR/deployment-images.json" >"$BAD_RUNNER_INVENTORY"
  if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
    "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$BAD_RUNNER_INVENTORY"; then
    fail "checkpoint inventory rejects malicious runner $bad_runner_kind" 'unsafe runner image accepted'
  else
    pass "checkpoint inventory rejects malicious runner $bad_runner_kind"
  fi
done
MISMATCHED_RUNNER_IMAGE='ghcr.io/yengalvez/bot-runner@sha256:9999999999999999999999999999999999999999999999999999999999999999'
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid "" "$3"' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$KUBERNETES_RUNNER_INVENTORY" \
  "$MISMATCHED_RUNNER_IMAGE"; then
  fail 'checkpoint inventory rejects runner digest mismatch against the expected override' 'mismatched runner accepted'
else
  pass 'checkpoint inventory rejects runner digest mismatch against the expected override'
fi
EXTRA_TOP_LEVEL_INVENTORY="$TMP_DIR/deployment-images-extra-top-level.json"
jq '.unexpected = true' "$CAPTURE_DIR/deployment-images.json" >"$EXTRA_TOP_LEVEL_INVENTORY"
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$EXTRA_TOP_LEVEL_INVENTORY"; then
  fail 'checkpoint inventory rejects unlisted top-level fields' 'extra top-level field accepted'
else
  pass 'checkpoint inventory rejects unlisted top-level fields'
fi
BOT2_INVENTORY="$TMP_DIR/deployment-images-bot2.json"
jq '(.deployments[] | select(.name == "bot-orchestrator") | .replicas) = 2' \
  "$CAPTURE_DIR/deployment-images.json" >"$BOT2_INVENTORY"
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$BOT2_INVENTORY"; then fail 'checkpoint inventory rejects two bot replicas' 'unsafe inventory accepted'; else pass 'checkpoint inventory rejects two bot replicas'; fi
EXPECTED_CAPTURE_IMAGES_JSON="$(jq -c '
  [.deployments[] as $deployment
   | $deployment.containers[]
   | {key:($deployment.name + "/" + .name), value:.image}]
  | from_entries
' "$CAPTURE_DIR/deployment-images.json")"
EVIL_NONCORE_INVENTORY="$TMP_DIR/deployment-images-evil-coturn.json"
jq '(.deployments[] | select(.name == "coturn") | .containers[] | select(.name == "coturn") | .image) =
      ("evil.invalid/coturn@sha256:" + ("8" * 64))' \
  "$CAPTURE_DIR/deployment-images.json" >"$EVIL_NONCORE_INVENTORY"
if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid "$3"' _ \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$EVIL_NONCORE_INVENTORY" "$EXPECTED_CAPTURE_IMAGES_JSON"; then
  fail 'checkpoint inventory rejects digest-pinned non-core image substitution' 'unsafe inventory accepted'
else
  pass 'checkpoint inventory rejects digest-pinned non-core image substitution'
fi
all_thirteen_repositories_rejected=true
inventory_pairs=()
while IFS= read -r inventory_pair; do
  inventory_pairs+=("$inventory_pair")
done < <(jq -r '
    .deployments[] as $deployment | $deployment.containers[] |
    ($deployment.name + "/" + .name)
  ' "$CAPTURE_DIR/deployment-images.json" | LC_ALL=C sort)
if [[ "${#inventory_pairs[@]}" != 13 ]] ||
   ! bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
     "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$CAPTURE_DIR/deployment-images.json"; then
  all_thirteen_repositories_rejected=false
else
  for inventory_pair in "${inventory_pairs[@]}"; do
    deployment_name="${inventory_pair%%/*}"
    container_name="${inventory_pair#*/}"
    pair_mutation="$TMP_DIR/inventory-evil-${deployment_name}-${container_name}.json"
    jq --arg deployment "$deployment_name" --arg container "$container_name" '
      (.deployments[] | select(.name == $deployment) | .containers[] |
        select(.name == $container) | .image) =
        ("evil.invalid/candidate@sha256:" + ("9" * 64))
    ' "$CAPTURE_DIR/deployment-images.json" >"$pair_mutation"
    if bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid' _ \
      "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$pair_mutation"; then
      all_thirteen_repositories_rejected=false
      break
    fi
  done
fi
if [[ "$all_thirteen_repositories_rejected" == true ]]; then
  pass 'checkpoint allowlist binds the trusted repository of all 13 image pairs'
else
  fail 'checkpoint allowlist binds the trusted repository of all 13 image pairs' "pair=${inventory_pair:-unknown}"
fi

CREATE_PARENT="$TMP_DIR/atomic-create"
CREATE_PROCESS_LOCAL="$CREATE_PARENT/process-local-checkpoint"
reset_stub
expect_success 'process-local checkpoint publishes and resumes the exact accepted legacy boundary' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_PROCESS_LOCAL"
if jq -e '.bot_runner_runtime.mode == "process-local" and
    .bot_runner_runtime.control_plane == {state:"legacy-absent"} and
    .bot_runner_runtime.recovery_epoch == {state:"legacy-absent"}' \
    "$CREATE_PROCESS_LOCAL/deployment-images.json" >/dev/null &&
   [[ ! -e "$STUB_STATE_DIR/runner-control-plane-verifier-count" ]] &&
   grep -q 'scale deployment bot-orchestrator .*--replicas=0' "$KUBECTL_LOG" &&
   grep -q 'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG"; then
  pass 'process-local checkpoint does not consult candidate manifest and restores its parent'
else
  fail 'process-local checkpoint mode binding and exact resume' "$(cat "$KUBECTL_LOG")"
fi
CREATE_PROCESS_LOCAL_DRIFT="$CREATE_PARENT/process-local-mode-drift"
reset_stub
expect_failure 'process-local mode drift during backup blocks every writer resume' \
  'Checkpoint runner mode changed while writers were fenced' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  STUB_MODE=checkpoint-process-local-mode-drift \
  STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_PROCESS_LOCAL_DRIFT"
if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
   ! grep -q 'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" &&
   [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
  pass 'process-local drift retains the lock with parent authority at zero'
else
  fail 'process-local drift resumed or released authority' "$(cat "$KUBECTL_LOG")"
fi
CHECKPOINT_PARTIAL_PROCESS_LOCAL="$TMP_DIR/checkpoint-partial-process-local.json"
jq '(.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[0].env) += [
      {name:"ORCHESTRATOR_POD_UID",value:"partial"}
    ]' "$LEGACY_DEPLOYMENTS_JSON" >"$CHECKPOINT_PARTIAL_PROCESS_LOCAL"
reset_stub
expect_failure 'partial isolated binding cannot fall back to process-local checkpoint' \
  'not bound to recovery phase active' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$CHECKPOINT_PARTIAL_PROCESS_LOCAL" \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_PARENT/process-local-partial"
if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
  fail 'partial isolated binding mutated writer scale' "$(cat "$KUBECTL_LOG")"
else
  pass 'partial isolated binding performs zero writer scale mutations'
fi
reset_stub
expect_failure 'residual runner Namespace cannot fall back to process-local checkpoint' \
  'not bound to recovery phase active' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  STUB_RUNNER_NAMESPACE=present \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_PARENT/process-local-namespace"
if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
  fail 'residual runner Namespace mutated writer scale' "$(cat "$KUBECTL_LOG")"
else
  pass 'residual runner Namespace performs zero writer scale mutations'
fi
reset_stub
expect_failure 'adjacent process-local drift blocks parent resume' \
  'Checkpoint runner mode changed while writers were fenced' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  STUB_MODE=checkpoint-process-local-adjacent-drift \
  STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$CREATE_PARENT/process-local-adjacent-drift"
if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
   ! grep -q 'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" &&
   [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
  pass 'adjacent process-local drift leaves parent zero under lock'
else
  fail 'adjacent process-local drift resumed parent' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
expect_failure 'pre-watcher quiesce failure safely reconstructs resume monitoring' \
  'Pods still remain for deployment/bot-orchestrator; refusing further mutation' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  STUB_MODE=checkpoint-parent-wait-failure \
  STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$CREATE_PARENT/process-local-parent-wait"
if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 1 ]] &&
   [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
  pass 'pre-watcher quiesce failure restores parent and releases its lock safely'
else
  fail 'pre-watcher quiesce failure strands parent or lock' "$(cat "$KUBECTL_LOG")"
fi
for residual_resource in role validatingadmissionpolicy; do
  reset_stub
  expect_failure "residual $residual_resource cannot fall back to process-local checkpoint" \
    'not bound to recovery phase active' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_RESIDUAL="$residual_resource" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$CREATE_PARENT/process-local-residual-$residual_resource"
  if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
    fail "residual $residual_resource mutated writer scale" "$(cat "$KUBECTL_LOG")"
  else
    pass "residual $residual_resource performs zero writer scale mutations"
  fi
done
ANNOTATED_PROCESS_LOCAL="$TMP_DIR/deployments-process-local-non-parent-annotation.json"
jq '(.items[] | select(.metadata.name == "pgbouncer") |
    .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"]) = "active"' \
  "$LEGACY_DEPLOYMENTS_JSON" >"$ANNOTATED_PROCESS_LOCAL"
reset_stub
expect_failure 'non-parent runner annotation cannot fall back to process-local checkpoint' \
  'not bound to recovery phase active' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$ANNOTATED_PROCESS_LOCAL" \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$CREATE_PARENT/process-local-non-parent-annotation"
if grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
  fail 'non-parent runner annotation mutated writer scale' "$(cat "$KUBECTL_LOG")"
else
  pass 'non-parent runner annotation performs zero writer scale mutations'
fi

# All remaining checkpoint cases exercise the post-rollout isolated path.
STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON"
STUB_RUNNER_NAMESPACE=present
export STUB_DEPLOYMENTS_JSON STUB_RUNNER_NAMESPACE
CREATE_FINAL="$CREATE_PARENT/published-checkpoint"
for checkpoint_preflight_case in \
  checkpoint-control-plane-preflight-failure \
  checkpoint-bootstrap-control-plane \
  checkpoint-tampered-manifest; do
  reset_stub
  checkpoint_preflight_output="$CREATE_PARENT/$checkpoint_preflight_case"
  if [[ "$checkpoint_preflight_case" == checkpoint-tampered-manifest ]]; then
    checkpoint_preflight_error='generated Cloud manifest is invalid'
  else
    checkpoint_preflight_error='active runner control plane is not exact'
  fi
  expect_failure "checkpoint preflight rejects $checkpoint_preflight_case before downtime" \
    "$checkpoint_preflight_error" \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_MODE="$checkpoint_preflight_case" \
    STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$checkpoint_preflight_output"
  if ! grep -Eq ' scale .*--replicas=(0|1)' "$KUBECTL_LOG"; then
    pass "$checkpoint_preflight_case performs zero writer scale mutations"
  else
    fail "$checkpoint_preflight_case mutated writer scale during preflight" \
      "$(cat "$KUBECTL_LOG")"
  fi
done
reset_stub
expect_success 'checkpoint creation publishes one fully verified directory atomically' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_FINAL"
checkpoint_dump_line="$(grep -n 'pg_dump -U' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
checkpoint_archive_line="$(grep -n 'tar -C /storage -cf - owned' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
checkpoint_resume_line="$(grep -n -- '--replicas=1' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
checkpoint_runner_before_dump="$(awk -v stop="$checkpoint_dump_line" '
  NR < stop && index($0, "get pod -n hcce -o json") {line=NR}
  END {print line}
' "$KUBECTL_LOG")"
checkpoint_runner_before_resume="$(awk -v start="$checkpoint_archive_line" -v stop="$checkpoint_resume_line" '
  NR > start && NR < stop && index($0, "get pod -n hcce -o json") {line=NR}
  END {print line}
' "$KUBECTL_LOG")"
if [[ "$checkpoint_runner_before_dump" =~ ^[0-9]+$ &&
      "$checkpoint_runner_before_resume" =~ ^[0-9]+$ ]]; then
  pass 'checkpoint keeps managed bot-runner zero from quiesce through pre-resume'
else
  fail 'checkpoint keeps managed bot-runner zero from quiesce through pre-resume' "$(cat "$KUBECTL_LOG")"
fi
checkpoint_parent_resume_line="$(grep -n -- \
  'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" |
  head -1 | cut -d: -f1 || :)"
checkpoint_final_watch_line="$(awk -v stop="$checkpoint_parent_resume_line" '
  NR < stop && index($0, "get --raw /api/v1/namespaces/") {line=NR}
  END {print line}
' "$KUBECTL_LOG")"
checkpoint_post_watch_list_line="$(awk -v start="$checkpoint_final_watch_line" \
  -v stop="$checkpoint_parent_resume_line" '
  NR > start && NR < stop && index($0, "get pod -n hcce -o json") {print NR; exit}
' "$KUBECTL_LOG")"
if [[ "$checkpoint_final_watch_line" =~ ^[0-9]+$ &&
      "$checkpoint_post_watch_list_line" =~ ^[0-9]+$ &&
      "$checkpoint_parent_resume_line" =~ ^[0-9]+$ &&
      "$checkpoint_final_watch_line" -lt "$checkpoint_post_watch_list_line" &&
      "$checkpoint_post_watch_list_line" -lt "$checkpoint_parent_resume_line" ]]; then
  pass 'checkpoint runs the post-watcher stable-absence gate before parent resume'
else
  fail 'checkpoint post-watcher stable-absence ordering' "$(cat "$KUBECTL_LOG")"
fi
run_checkpoint_input_snapshot_test "$CREATE_PARENT/local-input-mutation"
CREATE_ORPHAN_RUNNER="$CREATE_PARENT/orphan-runner-checkpoint"
reset_stub
expect_success 'checkpoint UID-deletes a dedicated-namespace orphan before backup and resumes only after the stable gate' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=checkpoint-orphan-runner \
  STUB_RUNNER_NAMESPACE=present STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_ORPHAN_RUNNER"
orphan_parent_zero_line="$(grep -n -- \
  'scale deployment bot-orchestrator .*--replicas=0' "$KUBECTL_LOG" |
  head -1 | cut -d: -f1 || :)"
orphan_delete_line="$(grep -n \
  'delete --raw=/api/v1/namespaces/hcce-bot-runners/pods/bot-runner-fixture' \
  "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
orphan_dump_line="$(grep -n 'pg_dump -U' "$KUBECTL_LOG" |
  head -1 | cut -d: -f1 || :)"
orphan_parent_resume_line="$(grep -n -- \
  'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" |
  head -1 | cut -d: -f1 || :)"
if [[ "$orphan_parent_zero_line" =~ ^[0-9]+$ &&
      "$orphan_delete_line" =~ ^[0-9]+$ &&
      "$orphan_dump_line" =~ ^[0-9]+$ &&
      "$orphan_parent_resume_line" =~ ^[0-9]+$ &&
      "$orphan_parent_zero_line" -lt "$orphan_delete_line" &&
      "$orphan_delete_line" -lt "$orphan_dump_line" &&
      "$orphan_dump_line" -lt "$orphan_parent_resume_line" ]]; then
  pass 'checkpoint orphan deletion is ordered parent-zero then UID-delete then backup then parent-resume'
else
  fail 'checkpoint orphan deletion ordering' "$(cat "$KUBECTL_LOG")"
fi
CREATE_CONTROL_PLANE_DRIFT="$CREATE_PARENT/control-plane-drift-checkpoint"
reset_stub
expect_failure 'checkpoint revalidates exact active Cloud control plane adjacent to parent resume' \
  'active runner control plane is not exact' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=checkpoint-active-control-plane-drift \
  STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_CONTROL_PLANE_DRIFT"
control_plane_parent_resume_count="$(grep -Ec -- \
  'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" || :)"
control_plane_verifier_count="$(cat \
  "$STUB_STATE_DIR/runner-control-plane-verifier-count" 2>/dev/null || :)"
if [[ "$control_plane_parent_resume_count" == 0 &&
      "$control_plane_verifier_count" =~ ^[2-9][0-9]*$ &&
      -f "$STUB_STATE_DIR/replicas-bot-orchestrator" &&
      "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator")" == 0 ]]; then
  pass 'Role, VAP or effective-RBAC drift keeps parent authority at zero'
else
  fail 'control-plane drift resumed token-bearing parent authority' \
    "verifier-count=$control_plane_verifier_count $(cat "$KUBECTL_LOG")"
fi
published_manifest_sha="$(sha256_digest "$CREATE_FINAL/SHA256SUMS")"
reset_stub
expect_failure 'checkpoint creation refuses an existing final directory without overwrite' 'Refusing same-second or existing' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_FINAL"
if [[ "$(sha256_digest "$CREATE_FINAL/SHA256SUMS")" == "$published_manifest_sha" ]]; then pass 'checkpoint collision preserves the existing published checkpoint'; else fail 'checkpoint collision preserves the existing published checkpoint' 'manifest changed'; fi
CREATE_FAILED="$CREATE_PARENT/failed-checkpoint"
reset_stub
expect_failure 'checkpoint creation never publishes a partial directory on backup failure' 'Unexpected pods consume PVC' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=backup-extra-consumer "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_FAILED"
if [[ ! -e "$CREATE_FAILED" && ! -e "$CREATE_FAILED.yenhubs-publish-lock" ]] && ! find "$CREATE_PARENT" -maxdepth 1 -type d -name '.yenhubs-checkpoint-*' | grep -q .; then pass 'failed checkpoint staging is owned, private and removed'; else fail 'failed checkpoint staging is owned, private and removed' "$(find "$CREATE_PARENT" -maxdepth 1 -print)"; fi
CREATE_EMPTY_ACTIVE="$CREATE_PARENT/empty-active-checkpoint"
reset_stub
expect_failure 'checkpoint creation rejects an empty active DB baseline before helper creation' 'Active owned-file DB baseline is empty or duplicated' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=zero-db-active "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_EMPTY_ACTIVE"
if [[ "$(grep -c 'create -f -$' "$KUBECTL_LOG")" == "1" ]]; then pass 'empty active DB baseline creates only the operation lock'; else fail 'empty active DB baseline creates only the operation lock' "$(cat "$KUBECTL_LOG")"; fi
CREATE_DUPLICATE_ACTIVE="$CREATE_PARENT/duplicate-active-checkpoint"
reset_stub
expect_failure 'checkpoint creation rejects duplicate active DB UUIDs before helper creation' 'Active owned-file DB baseline is empty or duplicated' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=duplicate-db-uuids "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_DUPLICATE_ACTIVE"
if [[ "$(grep -c 'create -f -$' "$KUBECTL_LOG")" == "1" ]]; then pass 'duplicate active DB UUIDs create only the operation lock'; else fail 'duplicate active DB UUIDs create only the operation lock' "$(cat "$KUBECTL_LOG")"; fi
CREATE_LOCKED="$CREATE_PARENT/locked-checkpoint"
mkdir "$CREATE_LOCKED.yenhubs-publish-lock"
printf 'other-owner\n' >"$CREATE_LOCKED.yenhubs-publish-lock/sentinel"
reset_stub
expect_failure 'checkpoint creation refuses a concurrently owned destination lock' 'Another checkpoint publication owns' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_LOCKED"
if [[ -f "$CREATE_LOCKED.yenhubs-publish-lock/sentinel" ]]; then pass 'checkpoint collision never removes another run owner lock'; else fail 'checkpoint collision never removes another run owner lock' 'foreign lock changed'; fi

if grep -En 'mktemp.*XXXXXX[^"[:space:]]' "$ROOT_DIR/deployment"/*.sh "$ROOT_DIR/deployment/lib"/*.sh >/dev/null; then fail 'BSD mktemp templates end in XXXXXX' 'suffix found after XXXXXX'; else pass 'BSD mktemp templates end in XXXXXX'; fi
missing_signal_trap=""
for recovery_script in \
  "$ROOT_DIR/deployment/backup-retdb.sh" \
  "$ROOT_DIR/deployment/backup-ret-storage.sh" \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$ROOT_DIR/deployment/restore-retdb.sh" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" \
  "$ROOT_DIR/deployment/validate-checkpoint.sh"; do
  if ! grep -Eq "trap .*INT" "$recovery_script"; then missing_signal_trap="$recovery_script"; fi
done
if [[ -n "$missing_signal_trap" ]]; then fail 'recovery scripts install INT traps' "$missing_signal_trap"; else pass 'recovery scripts install INT traps'; fi

if [[ "$FAIL_COUNT" -ne 0 ]]; then
  printf '%s recovery safety test(s) failed; %s passed.\n' "$FAIL_COUNT" "$PASS_COUNT" >&2
  exit 1
fi
printf 'All %s recovery safety tests passed using local fixtures only.\n' "$PASS_COUNT"

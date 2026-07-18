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
  jq -n '
    def item($name; $containers): {
      metadata: {name:$name, uid:("uid-"+$name)},
      spec: {replicas:1, selector:{matchLabels:{app:$name}}, template:{spec:{initContainers:[],containers:$containers}}},
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
      item("pgsql"; [{name:"pgsql",image:("ghcr.io/yengalvez/postgres@sha256:"+("4"*64))}]),
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
  jq --arg namespace hcce --arg uid fixture-uid '{schema_version:2,namespace:$namespace,namespace_uid:$uid,deployments:[.items[]|{name:.metadata.name,uid:.metadata.uid,replicas:.spec.replicas,init_containers:[],containers:[.spec.template.spec.containers[]|{name,image}]}]}' "$STUB_DEPLOYMENTS_JSON" >"$directory/deployment-images.json"
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
CONFIRM_CHECKPOINT="checkpoint:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:fixture-pvc-uid"

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
joined="$*"
yaml_field() {
  local pattern="$1" file="$2"
  awk -v pattern="$pattern" '$0 ~ pattern {value=$0; sub(/^[^:]+:[[:space:]]*/, "", value); gsub(/^"|"$/, "", value); print value; exit}' "$file"
}
if [[ "$joined" == "config current-context" ]]; then printf '%s' "${STUB_CURRENT_CONTEXT:-fixture-context}"; exit 0; fi
if [[ "$joined" == get\ namespace\ * ]]; then printf '%s' "${STUB_NAMESPACE_UID:-fixture-uid}"; exit 0; fi
if [[ "$joined" == get\ pvc\ ret-pvc*"jsonpath"* ]]; then printf '%s' "${STUB_PVC_UID:-fixture-pvc-uid}"; exit 0; fi
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
  jq -cn --arg uid "$lock_uid" --arg rv "$lock_rv" --arg owner "$lock_owner" \
    --arg operation_id "$lock_operation_id" --arg token "$lock_token" \
    --arg namespace_uid "$lock_namespace_uid" --arg pvc_uid "$lock_pvc_uid" \
    --arg stamp "$lock_stamp" --arg dump "$lock_dump" --arg storage "$lock_storage" \
    '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"yenhubs-recovery-operation-lock",namespace:"hcce",uid:$uid,resourceVersion:$rv,labels:{"yenhubs.org/recovery-owner":$owner},annotations:{"yenhubs.org/operation-id":$operation_id,"yenhubs.org/recovery-token":$token,"yenhubs.org/namespace-uid":$namespace_uid,"yenhubs.org/pvc-uid":$pvc_uid,"yenhubs.org/checkpoint-stamp":$stamp,"yenhubs.org/dump-sha256":$dump,"yenhubs.org/storage-sha256":$storage}},immutable:true}'
  exit 0
fi
if [[ "$joined" == get\ pod\ reticulum-0*metadata.uid* ]]; then printf 'reticulum-pod-uid'; exit 0; fi
if [[ "$joined" == get\ pod\ pgsql-0*metadata.uid* ]]; then printf 'pgsql-pod-uid'; exit 0; fi
if [[ "$joined" == rollout\ status\ * ]]; then
  if [[ "${STUB_MODE:-}" == "rollout-fail" && "$joined" == *"deployment/reticulum"* ]]; then exit 1; fi
  if [[ "${STUB_MODE:-}" == "resume-ret-fail" && "$joined" == *"deployment/reticulum"* &&
        -f "$STUB_STATE_DIR/replicas-reticulum" &&
        "$(cat "$STUB_STATE_DIR/replicas-reticulum")" == "1" ]]; then exit 1; fi
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
if [[ "$joined" == "get pod -n hcce -o json" ]]; then
  if [[ -e "$STUB_STATE_DIR/pod-created" ]]; then
    count_file="$STUB_STATE_DIR/consumer-count"; count=0; [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"; count=$((count + 1)); printf '%s' "$count" >"$count_file"
    pod_name="$(cat "$STUB_STATE_DIR/pod-name")"
    if [[ "${STUB_MODE:-}" == "extra-consumer" ||
          "${STUB_MODE:-}" == "backup-extra-consumer" ||
          ( "${STUB_MODE:-}" == "monitor-extra" && "$count" -ge 3 ) ||
          ( "${STUB_MODE:-}" == "backup-monitor-extra" && "$count" -ge 3 ) ]]; then
      jq -cn --arg pod "$pod_name" '{items:[{metadata:{name:$pod},spec:{volumes:[{persistentVolumeClaim:{claimName:"ret-pvc"}}]}},{metadata:{name:"rogue"},spec:{volumes:[{persistentVolumeClaim:{claimName:"ret-pvc"}}]}}]}'
    else
      jq -cn --arg pod "$pod_name" '{items:[{metadata:{name:$pod},spec:{volumes:[{persistentVolumeClaim:{claimName:"ret-pvc"}}]}}]}'
    fi
  else
    if [[ "${STUB_OPERATION:-}" == "storage-backup" ]]; then
      count_file="$STUB_STATE_DIR/consumer-count"; count=0; [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"; count=$((count + 1)); printf '%s' "$count" >"$count_file"
      if [[ "${STUB_MODE:-}" == "backup-extra-consumer" ||
            ( "${STUB_MODE:-}" == "backup-monitor-extra" && "$count" -ge 3 ) ]]; then
        printf '%s' '{"items":[{"metadata":{"name":"reticulum-0"},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}},{"metadata":{"name":"rogue"},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}}]}'
      else
        printf '%s' '{"items":[{"metadata":{"name":"reticulum-0"},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}}]}'
      fi
    else
      printf '%s' '{"items":[]}'
    fi
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
  jq -ce --arg name "$deployment" --arg rv "rv-$deployment-$rv_number" --argjson replicas "$replicas" '
    [.items[] | select(.metadata.name == $name)] | select(length == 1) | .[0] |
    .apiVersion = "apps/v1" | .kind = "Deployment" |
    .metadata.namespace = "hcce" | .metadata.resourceVersion = $rv |
    .spec.replicas = $replicas | .spec.strategy = {} |
    .spec.template.metadata = {labels:{app:$name}}
  ' "$STUB_DEPLOYMENTS_JSON"
  exit 0
fi
if [[ "$joined" == get\ pod\ *"-o name"* ]]; then
  if [[ "$joined" == *"-l app="* ]]; then
    if [[ ! -e "$STUB_STATE_DIR/waited" ]]; then printf 'pod/workload-0\n'; elif [[ "${STUB_MODE:-}" == residual ]]; then printf 'pod/workload-still-running\n'; fi
    exit 0
  fi
fi
if [[ "$joined" == wait\ --for=delete\ * ]]; then [[ "${STUB_MODE:-}" != timeout ]] || exit 1; : >"$STUB_STATE_DIR/waited"; exit 0; fi
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
  exit 0
fi
if [[ "$joined" == create\ -f\ - ]]; then
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
  elif [[ "$joined" == *pg_dump* ]]; then cat "$STUB_SQL_PLAIN"
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
    if [[ "${STUB_MODE:-}" == monitor-extra || "${STUB_MODE:-}" == restore-pod-replaced ]]; then sleep 0.08; fi
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
export PATH="$TMP_DIR/bin:$PATH"

reset_stub() {
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
    "$STUB_STATE_DIR/lock-replaced-after-quiesce"
  find "$STUB_STATE_DIR" -maxdepth 1 -type f \
    \( -name 'replicas-*' -o -name 'rv-*' -o -name 'create-payload-*' \
       -o -name 'delete-options-*' \) -delete
}
seed_restore_lock() {
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
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    fingerprint="$(jq -er --arg name "$deployment" '
      [.items[] | select(.metadata.name == $name)] | select(length == 1) | .[0] |
      .spec.strategy = {} | .spec.template.metadata = {labels:{app:$name}} |
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

TAMPERED="$TMP_DIR/checkpoint-tampered-pair"; cp -R "$GOOD_CHECKPOINT" "$TAMPERED"; printf mutation >>"$TAMPERED/retdb-$STAMP.sql.gz"
reset_stub
expect_failure 'DB restore rejects checksum mismatch before Kubernetes' 'verification failed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-retdb.sh" "$TAMPERED/retdb-$STAMP.sql.gz"
assert_no_kube 'checksum rejection performs no kubectl call'

reset_stub
expect_success 'DB restore preflight validates the immutable pair read-only' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -Eq ' scale |dropdb| apply ' "$KUBECTL_LOG"; then fail 'DB preflight has no mutation' "$(cat "$KUBECTL_LOG")"; else pass 'DB preflight has no mutation'; fi

reset_stub
expect_failure 'DB preflight rejects a pgsql-labelled pod owned by an unrelated Deployment' \
  'Exactly one owned Ready PostgreSQL pod' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_PREFLIGHT=1 STUB_MODE=rogue-pgsql-owner \
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
expect_failure 'generic DB confirmation is rejected' 'for this exact target' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE=retdb "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q ' scale ' "$KUBECTL_LOG"; then fail 'bad DB confirmation performs no scale' "$(cat "$KUBECTL_LOG")"; else pass 'bad DB confirmation performs no scale'; fi
reset_stub
seed_restore_lock
expect_failure 'consumer timeout blocks DB drop' 'Timed out waiting' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE="$CONFIRM_DB" STUB_MODE=timeout "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q dropdb "$KUBECTL_LOG"; then fail 'timeout performs no DB drop' "$(cat "$KUBECTL_LOG")"; else pass 'timeout performs no DB drop'; fi
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
expect_failure 'PVC consumer monitor fails extraction on transient extra pod' 'monitoring failed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" STUB_MODE=monitor-extra PVC_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
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
expect_failure 'coordinated driver rejects a generic confirmation before scaling' 'for this exact target' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid CONFIRM_RESTORE_CHECKPOINT=checkpoint "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if grep -q ' scale ' "$KUBECTL_LOG"; then fail 'bad coordinated confirmation performs no scale' "$(cat "$KUBECTL_LOG")"; else pass 'bad coordinated confirmation performs no scale'; fi
reset_stub
expect_failure 'a second coordinated restore cannot cross an active global lock' 'Another recovery operation owns' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid CONFIRM_RESTORE_CHECKPOINT="$CONFIRM_CHECKPOINT" STUB_MODE=restore-lock-exists "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if grep -q 'create -f -' "$KUBECTL_LOG" &&
   ! grep -Eq ' scale |dropdb|delete --raw=.*/configmaps/' "$KUBECTL_LOG"; then
  pass 'global lock contender never scales, drops or deletes owner state'
else
  fail 'global lock contender never scales, drops or deletes owner state' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
expect_success 'coordinated driver validates DB and storage before any consumer resumes' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid CONFIRM_RESTORE_CHECKPOINT="$CONFIRM_CHECKPOINT" PVC_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
lock_create_line="$(grep -n 'create -f -' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
first_deployment_line="$(grep -n 'get deployment .* -n hcce -o json' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
drop_line="$(grep -n 'dropdb' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
extract_line="$(grep -n 'tar -C /storage -xf -' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
resume_line="$(grep -n -- '--replicas=1' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
last_resume_line="$(grep -n -- '--replicas=1' "$KUBECTL_LOG" | tail -1 | cut -d: -f1 || :)"
lock_delete_line="$(grep -n 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG" | tail -1 | cut -d: -f1 || :)"
resume_count="$(grep -c -- '--replicas=1' "$KUBECTL_LOG" || :)"
if [[ "$lock_create_line" =~ ^[0-9]+$ && "$first_deployment_line" =~ ^[0-9]+$ && "$drop_line" =~ ^[0-9]+$ &&
      "$extract_line" =~ ^[0-9]+$ && "$resume_line" =~ ^[0-9]+$ &&
      "$last_resume_line" =~ ^[0-9]+$ && "$lock_delete_line" =~ ^[0-9]+$ &&
      "$lock_create_line" -lt "$first_deployment_line" && "$lock_create_line" -lt "$drop_line" && "$drop_line" -lt "$extract_line" &&
      "$extract_line" -lt "$resume_line" && "$last_resume_line" -lt "$lock_delete_line" &&
      "$resume_count" == 5 && ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
  pass 'coordinated resume occurs only after DB drop, PVC extraction and joint validation'
else
  fail 'coordinated resume occurs only after DB drop, PVC extraction and joint validation' "$(cat "$KUBECTL_LOG")"
fi
resume_order="$(grep -- '--replicas=1' "$KUBECTL_LOG" | sed -E 's/.*scale deployment ([^ ]+).*/\1/' | paste -sd, -)"
if [[ "$resume_order" == 'pgbouncer,pgbouncer-t,reticulum,coturn,bot-orchestrator' ]]; then
  pass 'coordinated resume makes Reticulum Ready before bot-orchestrator'
else
  fail 'coordinated resume makes Reticulum Ready before bot-orchestrator' "$resume_order"
fi
ret_resume_line="$(grep -n 'scale deployment reticulum .*--replicas=1' "$KUBECTL_LOG" | tail -1 | cut -d: -f1 || :)"
ret_ready_line="$(awk -v start="$ret_resume_line" 'NR > start && /rollout status deployment\/reticulum / {print NR; exit}' "$KUBECTL_LOG")"
coturn_resume_line="$(grep -n 'scale deployment coturn .*--replicas=1' "$KUBECTL_LOG" | tail -1 | cut -d: -f1 || :)"
bot_resume_line="$(grep -n 'scale deployment bot-orchestrator .*--replicas=1' "$KUBECTL_LOG" | tail -1 | cut -d: -f1 || :)"
if [[ "$ret_resume_line" =~ ^[0-9]+$ && "$ret_ready_line" =~ ^[0-9]+$ &&
      "$coturn_resume_line" =~ ^[0-9]+$ && "$bot_resume_line" =~ ^[0-9]+$ &&
      "$ret_resume_line" -lt "$ret_ready_line" &&
      "$ret_ready_line" -lt "$coturn_resume_line" &&
      "$ret_ready_line" -lt "$bot_resume_line" ]]; then
  pass 'Reticulum rollout reaches Ready before Coturn or bot scaling'
else
  fail 'Reticulum rollout reaches Ready before Coturn or bot scaling' "$(cat "$KUBECTL_LOG")"
fi

reset_stub
expect_failure 'Reticulum resume failure requiesces every consumer' 'forced back to zero' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid CONFIRM_RESTORE_CHECKPOINT="$CONFIRM_CHECKPOINT" STUB_MODE=resume-ret-fail PVC_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
resume_failure_held_zero=true
for held_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$held_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$held_consumer")" != 0 ]]; then
    resume_failure_held_zero=false
  fi
done
if [[ "$resume_failure_held_zero" == true ]]; then
  pass 'resume failure leaves no partially resumed consumer'
else
  fail 'resume failure leaves no partially resumed consumer' "$(cat "$KUBECTL_LOG")"
fi
if [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   ! grep -q 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG"; then
  pass 'resume failure retains the global restore lock'
else
  fail 'resume failure retains the global restore lock' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
expect_failure 'restore-lock replacement at release stops under foreign ownership' 'consumer state requires manual inspection' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid CONFIRM_RESTORE_CHECKPOINT="$CONFIRM_CHECKPOINT" STUB_MODE=restore-lock-replaced-on-release PVC_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
replacement_failure_left_state=true
for held_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$held_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$held_consumer")" != 1 ]]; then
    replacement_failure_left_state=false
  fi
done
lock_release_line="$(grep -n 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG" | tail -1 | cut -d: -f1 || :)"
post_replacement_scale_count="$(awk -v release="$lock_release_line" \
  'release ~ /^[0-9]+$/ && NR > release && / scale deployment / {count++} END {print count+0}' \
  "$KUBECTL_LOG")"
if [[ "$replacement_failure_left_state" == true &&
      -f "$STUB_STATE_DIR/restore-lock.yaml" &&
      "$(cat "$STUB_STATE_DIR/restore-lock-uid")" == replacement-lock-uid &&
      "$post_replacement_scale_count" == 0 ]] &&
   grep -q 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG" &&
   ! jq -se 'any(.[]; .preconditions.uid == "replacement-lock-uid")' \
     "$STUB_STATE_DIR"/delete-options-*.json >/dev/null 2>&1; then
  pass 'lock replacement is never deleted or followed by a foreign-state mutation'
else
  fail 'lock replacement is never deleted or followed by a foreign-state mutation' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
expect_failure 'coordinated storage failure holds every DB consumer at zero' 'non-empty or unsafe' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid CONFIRM_RESTORE_CHECKPOINT="$CONFIRM_CHECKPOINT" STUB_MODE=destination-nonempty PVC_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
held_zero=true
for held_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$held_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$held_consumer")" != 0 ]]; then
    held_zero=false
  fi
done
if [[ "$held_zero" == true ]] && ! grep -q -- '--replicas=1' "$KUBECTL_LOG"; then
  pass 'coordinated failure is fail-closed with no partial resume'
else
  fail 'coordinated failure is fail-closed with no partial resume' "$(cat "$KUBECTL_LOG")"
fi
if [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   ! grep -q 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG"; then
  pass 'failed coordinated mutation retains its exact global lock'
else
  fail 'failed coordinated mutation retains its exact global lock' "$(cat "$KUBECTL_LOG")"
fi

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
seed_restore_lock
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
seed_restore_lock
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

reset_stub
seed_restore_lock
seed_stale_restore_helper
expect_success 'stale-lock recovery removes its exact operation-bound helper before the lock' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 CONFIRM_CLEAR_RESTORE_LOCK="$CONFIRM_CLEAR_LOCK" "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if [[ ! -e "$STUB_STATE_DIR/pod-created" &&
      ! -e "$STUB_STATE_DIR/network-policy.yaml" &&
      ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   [[ "$(grep -c 'delete --raw=' "$KUBECTL_LOG" || :)" == 3 ]]; then
  pass 'stale helper cleanup is exact, complete and clear-only'
else
  fail 'stale helper cleanup is exact, complete and clear-only' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
seed_restore_lock
seed_stale_restore_helper
expect_failure 'stale helper same-name replacement is never adopted or deleted' 'identity/spec changed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 CONFIRM_CLEAR_RESTORE_LOCK="$CONFIRM_CLEAR_LOCK" STUB_MODE=stale-helper-replaced "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if [[ -e "$STUB_STATE_DIR/pod-created" &&
      -e "$STUB_STATE_DIR/network-policy.yaml" &&
      -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   ! grep -q 'delete --raw=.*/pods/' "$KUBECTL_LOG"; then
  pass 'replacement helper, deny policy and retained lock remain untouched'
else
  fail 'replacement helper, deny policy and retained lock remain untouched' "$(cat "$KUBECTL_LOG")"
fi

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
expect_success 'state capture emits strict structural inventory' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid VALUES_FILE="$VALUES_FIXTURE" "$ROOT_DIR/deployment/capture-instance-state.sh" "$CAPTURE_DIR"
if grep -R -q SECRET_SENTINEL "$CAPTURE_DIR"; then fail 'capture excludes env/args/commands/annotations/values' 'secret sentinel leaked'; else pass 'capture excludes env/args/commands/annotations/values'; fi
if jq -e '.items[0].data_keys == ["credential"] and .items[0].binary_data_keys == ["certificate"]' "$CAPTURE_DIR/k8s-configmaps-redacted.json" >/dev/null && jq -e '.deployments | length == 12' "$CAPTURE_DIR/deployment-images.json" >/dev/null; then pass 'capture preserves only structural keys and exact deployments'; else fail 'capture preserves only structural keys and exact deployments' 'invalid inventory'; fi
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
CREATE_FINAL="$CREATE_PARENT/published-checkpoint"
reset_stub
expect_success 'checkpoint creation publishes one fully verified directory atomically' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS=0.01 "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_FINAL"
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
if [[ "$(grep -c 'create -f -' "$KUBECTL_LOG")" == "1" ]]; then pass 'empty active DB baseline creates only the operation lock'; else fail 'empty active DB baseline creates only the operation lock' "$(cat "$KUBECTL_LOG")"; fi
CREATE_DUPLICATE_ACTIVE="$CREATE_PARENT/duplicate-active-checkpoint"
reset_stub
expect_failure 'checkpoint creation rejects duplicate active DB UUIDs before helper creation' 'Active owned-file DB baseline is empty or duplicated' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=duplicate-db-uuids "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_DUPLICATE_ACTIVE"
if [[ "$(grep -c 'create -f -' "$KUBECTL_LOG")" == "1" ]]; then pass 'duplicate active DB UUIDs create only the operation lock'; else fail 'duplicate active DB UUIDs create only the operation lock' "$(cat "$KUBECTL_LOG")"; fi
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

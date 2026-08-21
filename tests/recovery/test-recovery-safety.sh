#!/usr/bin/env bash

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-recovery-tests.XXXXXX")"
TMP_DIR="$(cd "$TMP_DIR" && pwd -P)"
cleanup_tmp() {
  if [[ "${YENHUBS_RECOVERY_TEST_KEEP_TMP:-0}" == 1 ]]; then
    printf 'Retained recovery test fixtures: %s\n' "$TMP_DIR" >&2
  else
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup_tmp EXIT INT TERM
PASS_COUNT=0
FAIL_COUNT=0
LAST_OUTPUT=""
STAMP="20260717-010203"
H5_FINAL_RECOVERY_FOCUS=false
if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == h5-final ]]; then
  H5_FINAL_RECOVERY_FOCUS=true
fi

recovery_focus_selected() {
  [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == "$1" ||
     "$H5_FINAL_RECOVERY_FOCUS" == true ]]
}

recovery_finish_focus() {
  local label="$1"
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s %s test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$label" "$PASS_COUNT" >&2
    exit 1
  fi
  printf '%s tests passed: %s.\n' "$label" "$PASS_COUNT"
  [[ "$H5_FINAL_RECOVERY_FOCUS" == true ]] || exit 0
}

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
expect_failure_status() {
  local name="$1" expected="$2" expected_status="$3" status=0
  shift 3
  if LAST_OUTPUT="$("$@" 2>&1)"; then status=0; else status=$?; fi
  if [[ "$status" != "$expected_status" ]]; then
    fail "$name" "expected status $expected_status, got $status: $LAST_OUTPUT"
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
TARGET_RUNNER_EPOCH='33333333-3333-4333-8333-333333333333'
export LIVE_RUNNER_EPOCH TARGET_RUNNER_EPOCH

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
HARDENED_DUMP_TOKEN='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
HARDENED_SQL_PLAIN="$TMP_DIR/retdb-hardened.sql"
HARDENED_MISMATCH_SQL_PLAIN="$TMP_DIR/retdb-hardened-mismatch.sql"
HARDENED_DANGLING_SQL_PLAIN="$TMP_DIR/retdb-hardened-dangling.sql"
HARDENED_TRAILING_SQL_PLAIN="$TMP_DIR/retdb-hardened-trailing.sql"
CANONICAL_FOOTER_SQL_PLAIN="$TMP_DIR/retdb-canonical-footer.sql"
DUPLICATE_FOOTER_SQL_PLAIN="$TMP_DIR/retdb-duplicate-footer.sql"
awk -v token="$HARDENED_DUMP_TOKEN" '
  NR == 1 { print "\\restrict " token }
  { print }
  END { print "\\unrestrict " token }
' "$SQL_PLAIN" >"$HARDENED_SQL_PLAIN"
awk -v token="$HARDENED_DUMP_TOKEN" '
  NR == 1 { print "\\restrict " token }
  { print }
  END { print "\\unrestrict " token "Z" }
' "$SQL_PLAIN" >"$HARDENED_MISMATCH_SQL_PLAIN"
awk -v token="$HARDENED_DUMP_TOKEN" '
  NR == 1 { print "\\restrict " token }
  { print }
' "$SQL_PLAIN" >"$HARDENED_DANGLING_SQL_PLAIN"
awk '{ print } END { print "SELECT 1;" }' \
  "$HARDENED_SQL_PLAIN" >"$HARDENED_TRAILING_SQL_PLAIN"
awk '{ print } END { print "--" }' \
  "$SQL_PLAIN" >"$CANONICAL_FOOTER_SQL_PLAIN"
awk '{ print } END { print "--"; print "--" }' \
  "$SQL_PLAIN" >"$DUPLICATE_FOOTER_SQL_PLAIN"

if recovery_focus_selected sql-dump-envelope; then
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_success 'legacy pg_dump completion envelope remains accepted' bash -c '
    source "$1"
    recovery_sql_dump_has_complete_marker "$2"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$SQL_PLAIN"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_success 'PostgreSQL 12 canonical empty footer remains accepted' bash -c '
    source "$1"
    recovery_sql_dump_has_complete_marker "$2"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$CANONICAL_FOOTER_SQL_PLAIN"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_success 'PostgreSQL hardened restrict/unrestrict envelope is accepted' bash -c '
    source "$1"
    recovery_sql_dump_has_complete_marker "$2"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$HARDENED_SQL_PLAIN"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_failure 'hardened pg_dump rejects mismatched envelope tokens' '' bash -c '
    source "$1"
    recovery_sql_dump_has_complete_marker "$2"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$HARDENED_MISMATCH_SQL_PLAIN"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_failure 'hardened pg_dump rejects a dangling restrict token' '' bash -c '
    source "$1"
    recovery_sql_dump_has_complete_marker "$2"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$HARDENED_DANGLING_SQL_PLAIN"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_failure 'hardened pg_dump rejects SQL after the terminal unrestrict' '' bash -c '
    source "$1"
    recovery_sql_dump_has_complete_marker "$2"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$HARDENED_TRAILING_SQL_PLAIN"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_failure 'pg_dump rejects duplicate canonical empty footers' '' bash -c '
    source "$1"
    recovery_sql_dump_has_complete_marker "$2"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$DUPLICATE_FOOTER_SQL_PLAIN"
  recovery_finish_focus 'Focused SQL dump envelope'
fi
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
Namespace: hcce
OVERRIDE_BOT_ORCHESTRATOR_IMAGE: ghcr.io/yengalvez/bot-orchestrator@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OVERRIDE_BOT_RUNNER_IMAGE: ghcr.io/yengalvez/bot-runner@sha256:8888888888888888888888888888888888888888888888888888888888888888
BOT_ORCHESTRATOR_ACCESS_KEY: fixture-rotated-orchestrator-key-at-least-32-chars
BOT_RUNNER_ACTIVATION_PHASE: active
BOT_RUNNER_RECOVERY_PHASE: active
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
  del(.items[].metadata.annotations) |
  del(.items[].spec.template.metadata.annotations) |
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
LEGACY_ROLLING_DEPLOYMENTS_JSON="$TMP_DIR/deployments-legacy-process-local-rolling.json"
jq '
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.strategy) = {type:"RollingUpdate",rollingUpdate:{
      maxSurge:"25%",maxUnavailable:"25%"}} |
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .metadata.annotations["deployment.kubernetes.io/revision"]) = "13"
' "$LEGACY_DEPLOYMENTS_JSON" >"$LEGACY_ROLLING_DEPLOYMENTS_JSON"
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
COLD_REBIND_RET_CONFIG_JSON="$TMP_DIR/ret-config-cold-rebind.json"
jq -cn '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"ret-config",
  namespace:"hcce",uid:"ret-config-uid",resourceVersion:"ret-config-rv"},
  data:{"config.toml.template":("legacy = \"<BOT_ACCESS_KEY>\"\n\n" +
    "[ret.\"Elixir.Ret.BotOrchestrator\"]\n" +
    "endpoint = \"http://bot-orchestrator.<POD_NS>:5001\"\n" +
    "access_key = \"<BOT_ACCESS_KEY>\"\n")}}' \
  >"$COLD_REBIND_RET_CONFIG_JSON"
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
DURABLE_RESTORE_CHILD_DEPLOYMENTS_JSON="$TMP_DIR/deployments-durable-restore-child.json"
jq --arg epoch "$TARGET_RUNNER_EPOCH" '
  (.items[] | .spec.template.metadata.annotations) =
    ((. // {}) + {"yenhubs.org/bot-runner-recovery-epoch":$epoch})
' "$KUBERNETES_DEPLOYMENTS_JSON" >"$DURABLE_RESTORE_CHILD_DEPLOYMENTS_JSON"
RESTORE_VALUES_FIXTURE="$TMP_DIR/input-values.restore-fence.fixture.yaml"
sed \
  "s|^BOT_RUNNER_RECOVERY_EPOCH:.*$|BOT_RUNNER_RECOVERY_EPOCH: $TARGET_RUNNER_EPOCH|" \
  "$VALUES_FIXTURE" >"$RESTORE_VALUES_FIXTURE"
chmod 600 "$RESTORE_VALUES_FIXTURE"
RESTORE_FENCE_VALUES_FIXTURE="$TMP_DIR/input-values.restore-fence-phase.fixture.yaml"
sed \
  -e 's|^BOT_RUNNER_RECOVERY_PHASE:.*$|BOT_RUNNER_RECOVERY_PHASE: restore-fence|' \
  "$RESTORE_VALUES_FIXTURE" >"$RESTORE_FENCE_VALUES_FIXTURE"
chmod 600 "$RESTORE_FENCE_VALUES_FIXTURE"
export VALUES_FILE="$RESTORE_VALUES_FIXTURE"

RUNNER_POD_FIXTURE_DIR="$TMP_DIR/runner-pod-fixtures"
RUNNER_FIXTURE_NAME="bot-runner-aaaaaaaaaaaaaaaa-11111111"
RUNNER_INTENT_FIXTURE_NAME="bot-intent-$RUNNER_FIXTURE_NAME"
mkdir -p "$RUNNER_POD_FIXTURE_DIR"
export RUNNER_POD_FIXTURE_DIR
node - "$ROOT_DIR/hubs-cloud/community-edition/services/bot-orchestrator/kubernetes-runner-manager.js" \
  "$RUNNER_POD_FIXTURE_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const {
  GENERATION_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  INTENT_STATE_ANNOTATION,
  RUNNER_PROTOCOL_LABEL,
  RUNNER_PROTOCOL_VALUE,
  ROOM_KEY_LABEL,
  guardPodDocumentForIdentity
} = require(process.argv[2]);

const outputDirectory = process.argv[3];
const generation = "11111111-1111-4111-8111-111111111111";
const roomKey = "aaaaaaaaaaaaaaaaaaaa";
const name = "bot-runner-aaaaaaaaaaaaaaaa-11111111";
const identity = { name, roomKey, processGeneration: generation };
const activeGeneration = "22222222-2222-4222-8222-222222222222";
const activeRoomKey = "bbbbbbbbbbbbbbbbbbbb";
const activeName = "bot-runner-bbbbbbbbbbbbbbbb-22222222";
const activeIdentity = {
  name: activeName,
  roomKey: activeRoomKey,
  processGeneration: activeGeneration
};

function live(document, uid, resourceVersion) {
  return {
    ...document,
    metadata: { ...document.metadata, uid, resourceVersion },
    status: { phase: "Pending" }
  };
}

const fence = live(guardPodDocumentForIdentity(identity, "fence"), "fence-uid-1", "pod-rv-10");
const intent = live(guardPodDocumentForIdentity(identity, "intent"), "intent-uid-1", "pod-rv-11");
const runner = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name,
    namespace: "hcce-bot-runners",
    uid: "runner-uid-1",
    resourceVersion: "pod-rv-12",
    labels: {
      app: "bot-runner",
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [RUNNER_PROTOCOL_LABEL]: RUNNER_PROTOCOL_VALUE,
      [ROOM_KEY_LABEL]: roomKey,
      [GENERATION_LABEL]: generation
    }
  },
  spec: { serviceAccountName: "bot-runner" },
  status: { phase: "Running" }
};
const activeIntent = live(
  guardPodDocumentForIdentity(activeIdentity, "intent"),
  "active-intent-uid-1",
  "pod-rv-31"
);
activeIntent.metadata.annotations[INTENT_STATE_ANNOTATION] = "armed";
const activeRunner = {
  ...runner,
  metadata: {
    ...runner.metadata,
    name: activeName,
    uid: "active-runner-uid-1",
    resourceVersion: "pod-rv-32",
    labels: {
      ...runner.metadata.labels,
      [ROOM_KEY_LABEL]: activeRoomKey,
      [GENERATION_LABEL]: activeGeneration
    }
  }
};
const unknown = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "unrecognized-pod",
    namespace: "hcce-bot-runners",
    uid: "unknown-uid-1",
    resourceVersion: "pod-rv-13",
    labels: { app: "not-a-runner" }
  },
  spec: { serviceAccountName: "default" },
  status: { phase: "Running" }
};
const malformed = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "malformed-runner-pod",
    namespace: "hcce-bot-runners",
    uid: "malformed-runner-uid"
  },
  spec: { serviceAccountName: "bot-runner" },
  status: { phase: "Running" }
};

const lists = {
  empty: [],
  fence: [fence],
  "fence-replaced": [{
    ...fence,
    metadata: { ...fence.metadata, uid: "fence-replacement-uid", resourceVersion: "pod-rv-20" }
  }],
  "fence-terminating": [{
    ...fence,
    metadata: { ...fence.metadata, deletionTimestamp: "2026-07-20T00:00:00Z" }
  }],
  runner: [runner],
  intent: [intent],
  unknown: [unknown],
  "active-valid": [fence, activeRunner, activeIntent],
  "active-unknown": [fence, unknown],
  "active-malformed": [fence, malformed],
  "historical-fence-replaced": [{
    ...fence,
    metadata: {
      ...fence.metadata,
      uid: "fence-replacement-uid",
      resourceVersion: "pod-rv-20"
    }
  }],
  ambiguous: [fence, {
    ...fence,
    metadata: { ...fence.metadata, uid: "fence-duplicate-uid", resourceVersion: "pod-rv-21" }
  }]
};
for (const [fixture, items] of Object.entries(lists)) {
  const value = {
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion: fixture === "fence" ? "list-rv-10" : `list-rv-${fixture}` },
    items
  };
  fs.writeFileSync(path.join(outputDirectory, `${fixture}.json`), `${JSON.stringify(value)}\n`, {
    mode: 0o600
  });
}
NODE

DURABLE_FENCE_BASELINE_FIXTURE="$TMP_DIR/durable-fence-baseline.json"
jq -cer --arg name "$RUNNER_FIXTURE_NAME" '
  [.items[] | {
    name:.metadata.name,
    uid:.metadata.uid,
    room_key:.metadata.labels["yenhubs.org/room-key"],
    process_generation:.metadata.labels["yenhubs.org/generation"],
    state:"fenced"
  }] | sort_by(.name) |
  map({name,uid,room_key,process_generation,state})
' "$RUNNER_POD_FIXTURE_DIR/fence.json" | tr -d '\n' \
  >"$DURABLE_FENCE_BASELINE_FIXTURE"
chmod 600 "$DURABLE_FENCE_BASELINE_FIXTURE"
DURABLE_FENCE_BASELINE_SHA="$(sha256_digest \
  "$DURABLE_FENCE_BASELINE_FIXTURE")"

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

make_freeze_bundle() {
  local directory="$1" dump_digest storage_digest dump_size storage_size artifact
  mkdir -p "$directory"
  cp "$SQL_GZIP" "$directory/retdb-$STAMP.sql.gz"
  cp "$VALID_STORAGE" "$directory/ret-storage-$STAMP.tar.gz"
  cp "$DATABASE_CONTRACT" "$directory/database-contract.json"
  jq --arg namespace hcce --arg uid source-namespace-uid '
    {schema_version:4,namespace:$namespace,namespace_uid:$uid,
      bot_runner_runtime:{generation:"legacy-absent",mode:"process-local",image:null,
        control_plane:{state:"legacy-absent"},recovery_epoch:{state:"legacy-absent"}},
      deployments:[.items[]|{name:.metadata.name,uid:.metadata.uid,
        replicas:.spec.replicas,init_containers:[],
        containers:[.spec.template.spec.containers[]|{name,image}]}]}
  ' "$LEGACY_DEPLOYMENTS_JSON" >"$directory/deployment-images.json"
  jq -n '{
    schema:"freeze-git-state-v1",captured_at_utc:"2026-08-09T12:00:00Z",
    repositories:{root:{commit:("a"*40)},hubs:{commit:("b"*40)},
      hubs_cloud:{commit:("c"*40)}},
    gitlinks:{hubs:("b"*40),hubs_cloud:("c"*40)},
    accepted_releases:{hubs:"prod-2026-03-11",hubs_ce:"2.1.0"}
  }' >"$directory/git-state.json"
  jq -n '{
    schema:"freeze-external-config-v1",
    dns:{domain:"hubs.fixture.invalid",provider:"fixture-dns",
      records:["hubs.fixture.invalid","stream.hubs.fixture.invalid",
        "assets.hubs.fixture.invalid","cors.hubs.fixture.invalid"]},
    smtp:{provider:"fixture-smtp",host_configured:true,port_configured:true,
      user_configured:true,password_configured:true},
    functional_ids:{room:"VJopCY3",scene:"f6VKtim",spoke_project:"qa3U3Ke"},
    images:{repositories:["ghcr.io/yengalvez/bot-orchestrator",
      "ghcr.io/yengalvez/coturn","ghcr.io/yengalvez/dialog",
      "ghcr.io/yengalvez/haproxy","ghcr.io/yengalvez/hubs",
      "ghcr.io/yengalvez/nearspark","ghcr.io/yengalvez/pgbouncer",
      "ghcr.io/yengalvez/photomnemonic","ghcr.io/yengalvez/postgres",
      "ghcr.io/yengalvez/postgrest","ghcr.io/yengalvez/reticulum",
      "ghcr.io/yengalvez/spoke"]},
    configured_presence:{ADM_EMAIL:true,DB_PASS:true,HUB_DOMAIN:true,
      OPENAI_API_KEY:true,SMTP_PASS:true},
    responsibility:{dns:"fixture-owner",operations:"fixture-owner",
      registry:"fixture-owner",smtp:"fixture-owner"}
  }' >"$directory/external-config-redacted.json"
  jq -n '{
    schema:"freeze-infrastructure-recipe-v1",provider:"digitalocean",region:"ams3",
    cluster:{name:"hubs-ce",ha_control_plane:false,
      node_pools:[{size:"s-4vcpu-8gb",count:1}]},
    storage:{class:"do-block-storage",persistent_volume_claims:[
      {name:"pgsql-pvc",size:"10Gi"},{name:"ret-pvc",size:"10Gi"}]},
    load_balancer:{count:1,type:"REGIONAL_NETWORK"},namespace:"hcce",
    ingress:"haproxytech-kubernetes-ingress-3.2",cert_manager:"cert-manager",
    topology:"single-region-low-cost",
    apply_order:["infrastructure","cert-manager","ingress",
      "generated-manifest","restore","live-verification"],
    cost_gate:{checked_at_utc:"2026-08-09T12:00:00Z",estimated_monthly_usd:65,
      result:"approval-required-before-create"}
  }' >"$directory/infrastructure-recipe.json"
  dump_digest="$(sha256_digest "$directory/retdb-$STAMP.sql.gz")"
  storage_digest="$(sha256_digest "$directory/ret-storage-$STAMP.tar.gz")"
  dump_size="$(wc -c <"$directory/retdb-$STAMP.sql.gz" | tr -d '[:space:]')"
  storage_size="$(wc -c <"$directory/ret-storage-$STAMP.tar.gz" | tr -d '[:space:]')"
  jq -n --arg stamp "$STAMP" --arg dump_digest "$dump_digest" \
    --arg storage_digest "$storage_digest" --argjson dump_size "$dump_size" \
    --argjson storage_size "$storage_size" '{
      schema:"freeze-bundle-v1",client_instance_id:"fixture-client-001",
      freeze_id:("9"*32),stamp:$stamp,created_at_utc:"2026-08-09T12:00:00Z",
      source:{kube_context:"fixture-context",
        cluster:{name:"hubs-ce",uid:"source-cluster-uid"},
        namespace:{name:"hcce",uid:"source-namespace-uid"},
        pvc:{name:"ret-pvc",uid:"source-pvc-uid"}},
      operation:{id:("9"*32),quiescence:{started_at_utc:"2026-08-09T12:00:00Z",
        completed_at_utc:"2026-08-09T12:00:01Z"}},
      payloads:{database:{filename:("retdb-"+$stamp+".sql.gz"),
        size_bytes:$dump_size,sha256:$dump_digest},
        storage:{filename:("ret-storage-"+$stamp+".tar.gz"),
        size_bytes:$storage_size,sha256:$storage_digest}},
      runtime_generation:"legacy-absent",runner_mode:"process-local",
      provenance:{generator:"yenhubs-freeze-bundle-v1",external_import:false},
      minimum_restore_version:1,publication_state:"complete"
    }' >"$directory/checkpoint-metadata.json"
  : >"$directory/SHA256SUMS"
  while IFS= read -r artifact; do
    printf '%s  %s\n' "$(sha256_digest "$directory/$artifact")" "$artifact" \
      >>"$directory/SHA256SUMS"
  done < <(
    source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
    recovery_freeze_bundle_artifacts "$STAMP"
  )
  chmod 600 "$directory"/*
}

refresh_freeze_manifest() {
  local directory="$1" artifact
  : >"$directory/SHA256SUMS"
  while IFS= read -r artifact; do
    printf '%s  %s\n' "$(sha256_digest "$directory/$artifact")" "$artifact" \
      >>"$directory/SHA256SUMS"
  done < <(
    source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
    recovery_freeze_bundle_artifacts "$STAMP"
  )
  chmod 600 "$directory/SHA256SUMS"
}

make_freeze_receipt() {
  local bundle="$1" destination="$2" manifest_digest
  manifest_digest="$(sha256_digest "$bundle/SHA256SUMS")"
  jq -n --arg manifest_digest "$manifest_digest" \
    --slurpfile metadata "$bundle/checkpoint-metadata.json" \
    --slurpfile inventory "$bundle/deployment-images.json" '
    ($metadata[0]) as $meta | ($inventory[0]) as $images |
    {
      schema:"freeze-bundle-receipt-v1",
      client_instance_id:$meta.client_instance_id,freeze_id:$meta.freeze_id,
      sha256sums_sha256:$manifest_digest,
      copies:[
        {reference:"copy:primary",decrypt_rehash:"passed",
          verified_at_utc:"2026-08-09T12:05:00Z"},
        {reference:"copy:secondary",decrypt_rehash:"passed",
          verified_at_utc:"2026-08-09T12:06:00Z"}],
      key_escrow_reference:"escrow:key-fixture",
      credential_set_reference:"escrow:credentials-fixture",
      image_custody:[$images.deployments[] as $deployment |
        $deployment.containers[] | {
          pair:($deployment.name+"/"+.name),image:.image,
          reference:("custody:"+$deployment.name+"/"+.name),
          restore_probe:"passed",verified_at_utc:"2026-08-09T12:07:00Z"}]
        | sort_by(.pair),
      responsible:"fixture-owner",verified_at_utc:"2026-08-09T12:08:00Z"
    }
  ' >"$destination"
  chmod 600 "$destination"
}

make_cold_rebind_target_deployments() {
  local destination="$1"
  jq -c '
    .apiVersion = "apps/v1" | .kind = "DeploymentList" |
    .items |= map(
      .metadata.namespace = "hcce" |
      .metadata.resourceVersion = ("target-rv-" + .metadata.name) |
      .metadata.uid = ("target-uid-" + .metadata.name) |
      if .metadata.name == "bot-orchestrator" then
        .spec.template.spec.imagePullSecrets = [{name:"bot-images-pull"}]
      else . end |
      if (.metadata.name == "reticulum" or .metadata.name == "pgbouncer" or
          .metadata.name == "pgbouncer-t" or
          .metadata.name == "bot-orchestrator" or .metadata.name == "coturn")
      then .spec.replicas = 0 |
        .status = {observedGeneration:.metadata.generation,replicas:0,
          readyReplicas:0,availableReplicas:0,updatedReplicas:0,
          unavailableReplicas:0}
      elif .metadata.name == "pgsql" then .spec.replicas = 1
      else . end)
  ' "$LEGACY_DEPLOYMENTS_JSON" >"$destination"
  chmod 600 "$destination"
}

refresh_manifest() {
  local directory="$1" artifact digest metadata_schema
  metadata_schema="$(jq -er '.schema_version | select(type == "number")' \
    "$directory/checkpoint-metadata.json")"
  # Schema 1 is an intentionally invalid fixture that still uses the
  # historical schema-2 artifact layout so validation reaches the metadata
  # contract instead of aborting while the test manifest is assembled.
  [[ "$metadata_schema" != 1 ]] || metadata_schema=2
  : >"$directory/SHA256SUMS"
  while IFS= read -r artifact; do
    digest="$(sha256_digest "$directory/$artifact")"
    printf '%s  %s\n' "$digest" "$artifact" >>"$directory/SHA256SUMS"
  done < <(
    source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
    recovery_checkpoint_artifacts "$STAMP" "$metadata_schema"
  )
}

GOOD_CHECKPOINT="$TMP_DIR/checkpoint-good"
make_checkpoint "$GOOD_CHECKPOINT"
DUMP_SHA="$(sha256_digest "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz")"
STORAGE_SHA="$(sha256_digest "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz")"
GOOD_CHECKPOINT_RUNNER_EVIDENCE_SHA="$(
  sha256_digest "$GOOD_CHECKPOINT/deployment-images.json"
)"
CONFIRM_DB="retdb:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:$GOOD_CHECKPOINT_RUNNER_EVIDENCE_SHA:legacy-absent"
CONFIRM_STORAGE="ret-pvc:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:fixture-pvc-uid:$GOOD_CHECKPOINT_RUNNER_EVIDENCE_SHA:legacy-absent"

if recovery_focus_selected freeze-bundle; then
  FREEZE_BUNDLE="$TMP_DIR/freeze-bundle-good"
  make_freeze_bundle "$FREEZE_BUNDLE"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_success 'freeze-bundle-v1 accepts exactly nine verified files' bash -c '
    set -euo pipefail
    source "$1"
    recovery_verify_freeze_bundle_directory "$2" "$3"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_BUNDLE" "$STAMP"

  FREEZE_EXTRA="$TMP_DIR/freeze-bundle-extra"
  cp -R "$FREEZE_BUNDLE" "$FREEZE_EXTRA"
  printf 'unexpected\n' >"$FREEZE_EXTRA/untracked.txt"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_failure 'freeze bundle rejects every tenth file' \
    'exact nine-file artifact set' bash -c '
      source "$1"
      recovery_verify_freeze_bundle_directory "$2" "$3"
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_EXTRA" "$STAMP"

  FREEZE_MUTATED="$TMP_DIR/freeze-bundle-mutated"
  cp -R "$FREEZE_BUNDLE" "$FREEZE_MUTATED"
  printf 'mutation\n' >>"$FREEZE_MUTATED/ret-storage-$STAMP.tar.gz"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_failure 'freeze bundle rejects payload mutation' \
    'SHA256 verification failed' bash -c '
      source "$1"
      recovery_verify_freeze_bundle_directory "$2" "$3"
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_MUTATED" "$STAMP"

  FREEZE_WRONG_SOURCE="$TMP_DIR/freeze-bundle-wrong-source"
  cp -R "$FREEZE_BUNDLE" "$FREEZE_WRONG_SOURCE"
  jq '.source.namespace.uid = "different-source"' \
    "$FREEZE_WRONG_SOURCE/checkpoint-metadata.json" >"$FREEZE_WRONG_SOURCE/new"
  mv "$FREEZE_WRONG_SOURCE/new" "$FREEZE_WRONG_SOURCE/checkpoint-metadata.json"
  : >"$FREEZE_WRONG_SOURCE/SHA256SUMS"
  while IFS= read -r artifact; do
    printf '%s  %s\n' "$(sha256_digest "$FREEZE_WRONG_SOURCE/$artifact")" "$artifact" \
      >>"$FREEZE_WRONG_SOURCE/SHA256SUMS"
  done < <(
    source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
    recovery_freeze_bundle_artifacts "$STAMP"
  )
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_failure 'freeze bundle binds inventory to source Namespace identity' '' bash -c '
    source "$1"
    recovery_verify_freeze_bundle_directory "$2" "$3"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_WRONG_SOURCE" "$STAMP"

  if grep -R -Fq 'fixture-secret-sentinel' "$FREEZE_BUNDLE"; then
    fail 'freeze bundle contains no secret-value sentinel' 'sentinel leaked'
  else
    pass 'freeze bundle contains no secret-value sentinel'
  fi
  recovery_finish_focus 'Focused freeze-bundle'
fi

if recovery_focus_selected preflight-greenfield; then
  GREENFIELD_BUNDLE="$TMP_DIR/greenfield-bundle"
  GREENFIELD_RECEIPT="$TMP_DIR/greenfield-receipt.json"
  GREENFIELD_VALUES="$TMP_DIR/greenfield-values.yaml"
  make_freeze_bundle "$GREENFIELD_BUNDLE"
  jq --arg root "$(git -C "$ROOT_DIR" rev-parse HEAD)" \
    --arg hubs "$(git -C "$ROOT_DIR/hubs" rev-parse HEAD)" \
    --arg cloud "$(git -C "$ROOT_DIR/hubs-cloud" rev-parse HEAD)" '
    .repositories.root.commit=$root | .repositories.hubs.commit=$hubs |
    .repositories.hubs_cloud.commit=$cloud | .gitlinks.hubs=$hubs |
    .gitlinks.hubs_cloud=$cloud
  ' "$GREENFIELD_BUNDLE/git-state.json" >"$GREENFIELD_BUNDLE/new"
  mv "$GREENFIELD_BUNDLE/new" "$GREENFIELD_BUNDLE/git-state.json"
  chmod 600 "$GREENFIELD_BUNDLE/git-state.json"
  refresh_freeze_manifest "$GREENFIELD_BUNDLE"
  make_freeze_receipt "$GREENFIELD_BUNDLE" "$GREENFIELD_RECEIPT"
  cp "$VALUES_PROCESS_LOCAL_FIXTURE" "$GREENFIELD_VALUES"
  cat >>"$GREENFIELD_VALUES" <<'YAML'
HUB_DOMAIN: hubs.fixture.invalid
ADM_EMAIL: fixture@example.invalid
DB_USER: fixture-db-user
DB_PASS: fixture-secret-sentinel
SMTP_SERVER: smtp.fixture.invalid
SMTP_PORT: 2525
SMTP_USER: fixture-smtp-user
SMTP_PASS: fixture-secret-sentinel
NODE_COOKIE: fixture-secret-sentinel
GUARDIAN_KEY: fixture-secret-sentinel
PHX_KEY: fixture-secret-sentinel
PERMS_KEY: fixture-secret-sentinel
BOT_ACCESS_KEY: fixture-secret-sentinel
OPENAI_API_KEY: fixture-secret-sentinel
YAML
  chmod 600 "$GREENFIELD_VALUES"
  expect_success 'greenfield preflight validates bundle and dossier without a cluster' \
    env VALUES_FILE="$GREENFIELD_VALUES" \
    "$ROOT_DIR/deployment/preflight-greenfield.sh" \
    "$GREENFIELD_BUNDLE" "$GREENFIELD_RECEIPT"
  if [[ "$LAST_OUTPUT" == *'PASS offline'* &&
        "$LAST_OUTPUT" == *'no autoriza crear recursos'* ]]; then
    pass 'greenfield preflight remains offline and preserves the cost gate'
  else
    fail 'greenfield preflight result is explicit' "$LAST_OUTPUT"
  fi

  GREENFIELD_BAD_RECEIPT="$TMP_DIR/greenfield-receipt-wrong.json"
  jq '.copies[1].reference=.copies[0].reference' "$GREENFIELD_RECEIPT" \
    >"$GREENFIELD_BAD_RECEIPT"
  chmod 600 "$GREENFIELD_BAD_RECEIPT"
  expect_failure 'greenfield preflight rejects two references to the same copy' \
    'recibo externo no liga exactamente' env VALUES_FILE="$GREENFIELD_VALUES" \
    "$ROOT_DIR/deployment/preflight-greenfield.sh" \
    "$GREENFIELD_BUNDLE" "$GREENFIELD_BAD_RECEIPT"

  GREENFIELD_MISSING_VALUES="$TMP_DIR/greenfield-values-missing.yaml"
  sed '/^OPENAI_API_KEY:/d' "$GREENFIELD_VALUES" >"$GREENFIELD_MISSING_VALUES"
  chmod 600 "$GREENFIELD_MISSING_VALUES"
  expect_failure 'greenfield preflight rejects a missing declared credential key' \
    'Faltan claves privadas declaradas' env VALUES_FILE="$GREENFIELD_MISSING_VALUES" \
    "$ROOT_DIR/deployment/preflight-greenfield.sh" \
    "$GREENFIELD_BUNDLE" "$GREENFIELD_RECEIPT"
  recovery_finish_focus 'Focused greenfield preflight'
fi

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

run_schema3_evidence_layout_tests() {
  local checkpoint="$1" test_root absent extra linked hash_drift metadata_drift evidence_digest
  test_root="$TMP_DIR/schema3-evidence-layout"
  rm -rf -- "$test_root"
  mkdir -p "$test_root"

  expect_success 'schema 3 checkpoint accepts its exact checksummed cutover evidence' \
    verify_checkpoint "$checkpoint"

  absent="$test_root/absent"
  cp -R "$checkpoint" "$absent"
  rm "$absent/runner-cutover-evidence.json"
  expect_failure 'schema 3 checkpoint rejects absent cutover evidence' \
    'exact allowlisted artifact set' verify_checkpoint "$absent"

  extra="$test_root/extra"
  cp -R "$checkpoint" "$extra"
  jq '.unexpected_evidence_field = true' "$extra/runner-cutover-evidence.json" \
    >"$extra/evidence.next"
  mv "$extra/evidence.next" "$extra/runner-cutover-evidence.json"
  refresh_manifest "$extra"
  expect_failure 'schema 3 checkpoint rejects rechecksummed extra evidence metadata' '' \
    verify_checkpoint "$extra"

  linked="$test_root/linked"
  cp -R "$checkpoint" "$linked"
  rm "$linked/runner-cutover-evidence.json"
  ln -s "$checkpoint/runner-cutover-evidence.json" \
    "$linked/runner-cutover-evidence.json"
  refresh_manifest "$linked"
  expect_failure 'schema 3 checkpoint rejects symlinked cutover evidence' \
    'linked or non-regular' verify_checkpoint "$linked"

  hash_drift="$test_root/hash-drift"
  cp -R "$checkpoint" "$hash_drift"
  printf '\n' >>"$hash_drift/runner-cutover-evidence.json"
  expect_failure 'schema 3 checkpoint rejects evidence hash drift' \
    'verification failed' verify_checkpoint "$hash_drift"

  metadata_drift="$test_root/metadata-drift"
  cp -R "$checkpoint" "$metadata_drift"
  jq '.cluster.kube_context = "different-context"' \
    "$metadata_drift/runner-cutover-evidence.json" >"$metadata_drift/evidence.next"
  mv "$metadata_drift/evidence.next" "$metadata_drift/runner-cutover-evidence.json"
  evidence_digest="$(sha256_digest "$metadata_drift/runner-cutover-evidence.json")"
  jq --arg digest "$evidence_digest" \
    '.runner_cutover_evidence_sha256 = $digest' \
    "$metadata_drift/checkpoint-metadata.json" >"$metadata_drift/metadata.next"
  mv "$metadata_drift/metadata.next" "$metadata_drift/checkpoint-metadata.json"
  refresh_manifest "$metadata_drift"
  expect_failure 'schema 3 checkpoint rejects rechecksummed evidence binding drift' '' \
    verify_checkpoint "$metadata_drift"
}

run_schema3_evidence_materialization_test() {
  local checkpoint="$1" working="$TMP_DIR/schema3-materialization"
  rm -rf -- "$working"
  cp -R "$checkpoint" "$working"
  # shellcheck disable=SC2016 # Expanded by the isolated Bash process.
  expect_success 'materialization privately copies and rehashes schema 3 cutover evidence' \
    bash -c '
      set -euo pipefail
      source "$1"
      recovery_materialize_checkpoint "$2" "$3"
      [[ -n "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY" &&
         -f "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY" &&
         ! -L "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY" ]]
      original="$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256"
      [[ "$original" =~ ^[a-f0-9]{64}$ &&
         "$(recovery_sha256_digest "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY")" == "$original" ]]
      printf mutation >>"$(dirname "$2")/runner-cutover-evidence.json"
      [[ "$(recovery_sha256_digest "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY")" == "$original" ]]
      mode="$(stat -c %a -- "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY" 2>/dev/null ||
        stat -f %Lp -- "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY")"
      [[ "$mode" == 600 ]]
      recovery_cleanup_materialized_checkpoint
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
    "$working/retdb-$STAMP.sql.gz" "$ROOT_DIR/deployment/validate-checkpoint.sh"
}

capture_private_directory_token() {
  local directory="$1"
  bash -c 'set -euo pipefail; source "$1"; recovery_capture_private_directory_token "$2"' \
    _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$directory"
}

cleanup_private_directory_token() {
  local token="$1"
  shift
  bash -c '
    set -euo pipefail
    source "$1"
    token="$2"
    shift 2
    recovery_cleanup_private_directory "$token" "$@"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$token" "$@"
}

cleanup_marked_private_directory_token() {
  local token="$1" marker="$2" value="$3"
  shift 3
  bash -c '
    set -euo pipefail
    source "$1"
    token="$2"
    marker="$3"
    value="$4"
    shift 4
    recovery_cleanup_marked_private_directory "$token" "$marker" "$value" "$@"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$token" "$marker" \
    "$value" "$@"
}

initialize_setup_signal_mktemp_fixture() {
  [[ -x "${SETUP_SIGNAL_MKTEMP_FIXTURE:-}" &&
     -x "${SETUP_SIGNAL_MKDIR_FIXTURE:-}" ]] && return 0
  SETUP_SIGNAL_MKTEMP_FIXTURE="$TMP_DIR/private-setup-signal-bin/mktemp"
  SETUP_SIGNAL_MKDIR_FIXTURE="$TMP_DIR/private-setup-signal-bin/mkdir"
  mkdir -m 700 "$(dirname "$SETUP_SIGNAL_MKTEMP_FIXTURE")"
  cat >"$SETUP_SIGNAL_MKTEMP_FIXTURE" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
created="$($STUB_SIGNAL_REAL_MKTEMP "$@")"
if [[ "$*" == *"$STUB_SIGNAL_MKTEMP_MATCH"* &&
      ! -e "$STUB_SIGNAL_MKTEMP_FIRED" ]]; then
  : >"$STUB_SIGNAL_MKTEMP_FIRED"
  chmod 600 "$STUB_SIGNAL_MKTEMP_FIRED"
  printf '%s\n' "$created" >"$STUB_SIGNAL_MKTEMP_CREATED_PATH"
  chmod 600 "$STUB_SIGNAL_MKTEMP_CREATED_PATH"
  for _ in {1..500}; do
    [[ -s "$STUB_SIGNAL_TARGET_PID_PATH" ]] && break
    sleep 0.01
  done
  [[ -s "$STUB_SIGNAL_TARGET_PID_PATH" ]] || exit 1
  target_pid="$(cat "$STUB_SIGNAL_TARGET_PID_PATH")"
  [[ "$target_pid" =~ ^[1-9][0-9]*$ ]] || exit 1
  kill -TERM "$target_pid"
fi
printf '%s\n' "$created"
STUB
  chmod 700 "$SETUP_SIGNAL_MKTEMP_FIXTURE"
  cat >"$SETUP_SIGNAL_MKDIR_FIXTURE" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
real_mkdir="${STUB_SIGNAL_REAL_MKDIR:-/bin/mkdir}"
"$real_mkdir" "$@"
if [[ -n "${STUB_SIGNAL_MKDIR_MATCH:-}" && "$#" == 1 &&
      "$1" == "$STUB_SIGNAL_MKDIR_MATCH" &&
      ! -e "$STUB_SIGNAL_MKDIR_FIRED" ]]; then
  : >"$STUB_SIGNAL_MKDIR_FIRED"
  chmod 600 "$STUB_SIGNAL_MKDIR_FIRED"
  for _ in {1..500}; do
    [[ -s "$STUB_SIGNAL_TARGET_PID_PATH" ]] && break
    sleep 0.01
  done
  [[ -s "$STUB_SIGNAL_TARGET_PID_PATH" ]] || exit 1
  target_pid="$(cat "$STUB_SIGNAL_TARGET_PID_PATH")"
  [[ "$target_pid" =~ ^[1-9][0-9]*$ ]] || exit 1
  kill -TERM "$target_pid"
  # Replace the just-created 0700 claim before the caller can bind its token.
  # A non-private replacement must make capture fail closed, and the
  # initialization latch must preserve both names rather than deleting either.
  mv -- "$1" "$1.original"
  "$real_mkdir" -m 755 "$1"
fi
STUB
  chmod 700 "$SETUP_SIGNAL_MKDIR_FIXTURE"
}

run_setup_signal_command() {
  local label="$1" match="$2" forbidden_success="$3"
  shift 3
  local state_dir="$TMP_DIR/private-setup-signal-$label"
  local target_pid_path="$state_dir/target-pid"
  local fired_path="$state_dir/fired"
  local created_path_file="$state_dir/created-path"
  local output_path="$state_dir/output"
  local target_pid command_status=0 created_path=""
  initialize_setup_signal_mktemp_fixture || return 1
  rm -rf -- "$state_dir"
  mkdir -m 700 "$state_dir"
  env PATH="$(dirname "$SETUP_SIGNAL_MKTEMP_FIXTURE"):$PATH" \
    STUB_SIGNAL_REAL_MKTEMP="$(type -P mktemp)" \
    STUB_SIGNAL_MKTEMP_MATCH="$match" \
    STUB_SIGNAL_MKTEMP_FIRED="$fired_path" \
    STUB_SIGNAL_MKTEMP_CREATED_PATH="$created_path_file" \
    STUB_SIGNAL_TARGET_PID_PATH="$target_pid_path" \
    "$@" >"$output_path" 2>&1 &
  target_pid=$!
  printf '%s\n' "$target_pid" >"$target_pid_path"
  chmod 600 "$target_pid_path"
  if wait "$target_pid"; then
    command_status=0
  else
    command_status=$?
  fi
  [[ ! -s "$created_path_file" ]] || created_path="$(cat "$created_path_file")"
  if [[ "$command_status" != 143 || ! -e "$fired_path" ||
        -z "$created_path" || -e "$created_path" || -L "$created_path" ]]; then
    printf 'status=%s fired=%s created=%s\n%s\n' \
      "$command_status" "$([[ -e "$fired_path" ]] && printf yes || printf no)" \
      "${created_path:-missing}" "$(cat "$output_path" 2>/dev/null || :)" >&2
    return 1
  fi
  if [[ -n "$forbidden_success" ]] &&
     grep -Fq -- "$forbidden_success" "$output_path"; then
    printf 'interrupted setup emitted forbidden success text: %s\n' \
      "$forbidden_success" >&2
    return 1
  fi
}

run_storage_setup_signal_test() {
  local output_root="$TMP_DIR/private-setup-signal-storage-output"
  local output_path="$output_root/ret-storage-$STAMP.tar.gz"
  local signal_status=0
  reset_stub
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    seed_checkpoint_backup_guard || return 1
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
    start_checkpoint_backup_writer_guard healthy legacy-absent '' '' || return 1
  if run_setup_signal_command storage yenhubs-quiesced-storage \
      'Quiesced Reticulum storage backup completed' \
      env EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        RECOVERY_CHECKPOINT_STAMP="$STAMP" RECOVERY_DUMP_SHA256="$DUMP_SHA" \
        RECOVERY_STORAGE_SHA256="$STORAGE_SHA" \
        RECOVERY_NAMESPACE_UID=fixture-uid RECOVERY_PVC_UID=fixture-pvc-uid \
        CHECKPOINT_RUNNER_GENERATION=legacy-absent \
        CHECKPOINT_DURABLE_FENCE_BASELINE_PATH= \
        CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256= \
        RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
        STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
        RECOVERY_STREAM_POLL_SECONDS=0.01 \
        "$ROOT_DIR/deployment/backup-ret-storage-quiesced.sh" \
        "$output_path" "$GOOD_CHECKPOINT/deployment-images.json"; then
    signal_status=0
  else
    signal_status=$?
  fi
  stop_checkpoint_backup_writer_guard
  [[ "$signal_status" == 0 && ! -e "$output_path" && ! -L "$output_path" &&
     -z "$(find "$output_root" -maxdepth 1 -name '*.partial.*' -print -quit \
       2>/dev/null)" ]]
}

run_final_claim_setup_signal_test() {
  local create_output="$TMP_DIR/private-setup-signal-final-claim/checkpoint"
  local state_dir="$TMP_DIR/private-setup-signal-final-claim-state"
  local target_pid_path="$state_dir/target-pid"
  local fired_path="$state_dir/fired"
  local output_path="$state_dir/output"
  local target_pid command_status=0 deployment all_resumed=true
  initialize_setup_signal_mktemp_fixture || return 1
  reset_stub
  rm -rf -- "$(dirname "$create_output")" "$create_output.original" \
    "$state_dir"
  mkdir -m 700 "$state_dir"
  env PATH="$(dirname "$SETUP_SIGNAL_MKTEMP_FIXTURE"):$PATH" \
    STUB_SIGNAL_REAL_MKTEMP="$(type -P mktemp)" \
    STUB_SIGNAL_MKTEMP_MATCH='fixture-never-matches-mktemp' \
    STUB_SIGNAL_MKTEMP_FIRED="$state_dir/mktemp-fired" \
    STUB_SIGNAL_MKTEMP_CREATED_PATH="$state_dir/mktemp-created" \
    STUB_SIGNAL_REAL_MKDIR="$(type -P mkdir)" \
    STUB_SIGNAL_MKDIR_MATCH="$create_output" \
    STUB_SIGNAL_MKDIR_FIRED="$fired_path" \
    STUB_SIGNAL_TARGET_PID_PATH="$target_pid_path" \
    ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$create_output" \
    >"$output_path" 2>&1 &
  target_pid=$!
  printf '%s\n' "$target_pid" >"$target_pid_path"
  chmod 600 "$target_pid_path"
  if wait "$target_pid"; then
    command_status=0
  else
    command_status=$?
  fi
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    [[ "$(cat "$STUB_STATE_DIR/replicas-$deployment" 2>/dev/null || :)" == 1 ]] ||
      all_resumed=false
  done
  if [[ "$command_status" == 143 && -e "$fired_path" &&
        -d "$create_output" && ! -L "$create_output" &&
        "$(file_mode "$create_output")" == 755 &&
        -d "$create_output.original" && ! -L "$create_output.original" &&
        ! -e "$create_output/.yenhubs-incomplete" &&
        ! -e "$create_output.original/.yenhubs-incomplete" &&
        ! -e "$create_output.yenhubs-publish-lock" &&
        ! -e "$STUB_STATE_DIR/restore-lock.yaml" &&
        "$all_resumed" == true ]] &&
     ! grep -Fq 'Complete quiescent YenHubs checkpoint published' \
       "$output_path"; then
    return 0
  fi
  printf 'status=%s fired=%s resumed=%s mode=%s\n%s\n' \
    "$command_status" "$([[ -e "$fired_path" ]] && printf yes || printf no)" \
    "$all_resumed" "$(file_mode "$create_output" 2>/dev/null || printf missing)" \
    "$(cat "$output_path" 2>/dev/null || :)" >&2
  return 1
}

run_private_directory_setup_signal_tests() {
  local create_output="$TMP_DIR/private-setup-signal-create-final"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_success 'materialization setup defers TERM until its marked private directory is cleanable' \
    run_setup_signal_command materialize "yenhubs-restore-$STAMP" '' \
      bash -c '
        set -euo pipefail
        source "$1"
        cleanup_materialized_on_exit() {
          status=$?
          trap - EXIT
          trap "" INT TERM
          recovery_cleanup_materialized_checkpoint >/dev/null 2>&1 ||
            [[ "$status" != 0 ]] || status=1
          exit "$status"
        }
        trap cleanup_materialized_on_exit EXIT
        recovery_materialize_checkpoint "$2" "$3"
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
      "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" \
      "$ROOT_DIR/deployment/validate-checkpoint.sh"

  expect_success 'validation setup defers TERM until its private directory is cleaned' \
    run_setup_signal_command validation yenhubs-checkpoint-validation \
      'Checkpoint content validation passed' \
      "$ROOT_DIR/deployment/validate-checkpoint.sh" \
      "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" \
      "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"

  expect_success 'storage setup defers TERM, removes its private work tree and emits no success' \
    run_storage_setup_signal_test

  reset_stub
  expect_success 'checkpoint staging setup defers TERM and removes its marked private tree' \
    run_setup_signal_command create ".yenhubs-checkpoint-$STAMP" \
      'Complete quiescent YenHubs checkpoint published' \
      env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
        STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
        RECOVERY_STREAM_POLL_SECONDS=0.01 \
        "$ROOT_DIR/deployment/create-checkpoint.sh" "$create_output"
  if [[ ! -e "$create_output" && ! -L "$create_output" &&
        ! -e "$create_output.yenhubs-publish-lock" ]]; then
    pass 'interrupted checkpoint staging publishes no final directory or lock orphan'
  else
    fail 'interrupted checkpoint staging leaked a publication claim' \
      "output=$create_output"
  fi

  expect_success 'final claim setup defers TERM and preserves a same-name unsafe replacement' \
    run_final_claim_setup_signal_test
}

run_private_directory_helper_tests() {
  local root token external case_name original replacement
  local shared_tmp private_tmp expected_private_tmp
  local owner_tested=false current_uid current_gid

  shared_tmp="$TMP_DIR/shared-temp-root"
  mkdir -m 755 "$shared_tmp"
  expected_private_tmp="$shared_tmp/.yenhubs-recovery-private-$(id -u)"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_success 'shared temporary root yields one stable private per-user child' \
    bash -c '
      set -euo pipefail
      source "$1"
      first="$(TMPDIR="$2" recovery_canonical_private_tmp_root)"
      second="$(TMPDIR="$2" recovery_canonical_private_tmp_root)"
      [[ "$first" == "$3" && "$second" == "$first" ]]
      recovery_capture_private_directory_token "$first" >/dev/null
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$shared_tmp" \
    "$expected_private_tmp"
  private_tmp="$expected_private_tmp"
  chmod 755 "$private_tmp"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'shared temporary child rejects weakened private mode' '' \
    bash -c '
      set -euo pipefail
      source "$1"
      TMPDIR="$2" recovery_canonical_private_tmp_root
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$shared_tmp"
  chmod 700 "$private_tmp"
  rmdir "$private_tmp"
  mkdir -m 700 "$shared_tmp/external"
  ln -s "$shared_tmp/external" "$private_tmp"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'shared temporary child rejects a symlink collision' '' \
    bash -c '
      set -euo pipefail
      source "$1"
      TMPDIR="$2" recovery_canonical_private_tmp_root
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$shared_tmp"
  rm "$private_tmp"

  root="$TMP_DIR/private-helper-happy"
  mkdir -m 700 "$root" "$root/one" "$root/one/two"
  printf 'owner\n' >"$root/.owner"
  printf 'payload\n' >"$root/one/data"
  printf 'nested\n' >"$root/one/two/nested"
  chmod 600 "$root/.owner" "$root/one/data" "$root/one/two/nested"
  token="$(capture_private_directory_token "$root")"
  expect_success 'private helper recursively removes one exact marked 0700/0600 tree' \
    cleanup_marked_private_directory_token "$token" .owner owner \
    f:.owner d:one f:one/data d:one/two f:one/two/nested
  if [[ ! -e "$root" && ! -L "$root" ]]; then
    pass 'recursive helper removes the exact root only after its children'
  else
    fail 'recursive helper left its exact happy-path root' "$root"
  fi

  root="$TMP_DIR/private-helper-root-mode"
  mkdir -m 755 "$root"
  expect_failure 'private helper capture rejects a non-0700 root' \
    'directory_not_private' capture_private_directory_token "$root"

  for case_name in extra symlink hardlink type file-mode directory-mode marker; do
    root="$TMP_DIR/private-helper-$case_name"
    rm -rf -- "$root"
    mkdir -m 700 "$root"
    printf 'owner\n' >"$root/.owner"
    printf 'payload\n' >"$root/item"
    chmod 600 "$root/.owner" "$root/item"
    token="$(capture_private_directory_token "$root")"
    external="$TMP_DIR/private-helper-$case_name-external"
    rm -f -- "$external"
    case "$case_name" in
      extra)
        printf 'rogue\n' >"$root/rogue"
        chmod 600 "$root/rogue"
        ;;
      symlink)
        printf 'external\n' >"$external"
        rm "$root/item"
        ln -s "$external" "$root/item"
        ;;
      hardlink)
        ln "$root/item" "$external"
        ;;
      type)
        rm "$root/item"
        mkfifo "$root/item"
        chmod 600 "$root/item"
        ;;
      file-mode) chmod 640 "$root/item" ;;
      directory-mode)
        rm "$root/item"
        mkdir -m 755 "$root/item"
        ;;
      marker) printf 'wrong\n' >"$root/.owner" ;;
    esac
    if [[ "$case_name" == directory-mode ]]; then
      expect_failure "private helper rejects $case_name without deleting the root" \
        'failed closed' cleanup_marked_private_directory_token "$token" \
        .owner owner f:.owner d:item
    else
      expect_failure "private helper rejects $case_name without deleting the root" \
        'failed closed' cleanup_marked_private_directory_token "$token" \
        .owner owner f:.owner f:item
    fi
    if [[ -e "$root" || -L "$root" ]] &&
       [[ "$case_name" != symlink || -e "$external" ]] &&
       [[ "$case_name" != hardlink || -e "$external" ]]; then
      pass "$case_name conflict preserves the private tree and external target"
    else
      fail "$case_name conflict removed untrusted state" "$LAST_OUTPUT"
    fi
  done

  root="$TMP_DIR/private-helper-root-swap"
  original="$root.original"
  replacement="$root.replacement"
  mkdir -m 700 "$root"
  printf 'payload\n' >"$root/item"
  chmod 600 "$root/item"
  token="$(capture_private_directory_token "$root")"
  mv "$root" "$original"
  mkdir -m 700 "$root"
  printf 'replacement\n' >"$root/item"
  chmod 600 "$root/item"
  expect_failure 'private helper rejects a same-name root replacement' \
    'root_identity_changed' cleanup_private_directory_token "$token" f:item
  if [[ -e "$root/item" && -e "$original/item" ]]; then
    pass 'root replacement and captured original are both preserved'
  else
    fail 'root identity swap deleted one side' "$LAST_OUTPUT"
  fi
  mv "$root" "$replacement"
  mv "$original" "$root"
  expect_success 'captured root remains cleanable after replacement is removed' \
    cleanup_private_directory_token "$token" f:item

  root="$TMP_DIR/private-helper-child-swap"
  original="$root/child.original"
  mkdir -m 700 "$root" "$root/child"
  printf 'nested\n' >"$root/child/item"
  chmod 600 "$root/child/item"
  token="$(capture_private_directory_token "$root")"
  mv "$root/child" "$original"
  ln -s child.original "$root/child"
  expect_failure 'private helper rejects a child-name swap to a link' \
    'unsafe_private_subdirectory' cleanup_private_directory_token "$token" \
    d:child f:child/item d:child.original f:child.original/item
  if [[ -L "$root/child" && -e "$original/item" ]]; then
    pass 'child-name replacement and original subtree are both preserved'
  else
    fail 'child-name swap deleted trusted or replacement state' "$LAST_OUTPUT"
  fi

  current_uid="$(id -u)"
  current_gid="$(id -g)"
  root="$TMP_DIR/private-helper-owner"
  mkdir -m 700 "$root"
  printf 'payload\n' >"$root/item"
  chmod 600 "$root/item"
  token="$(capture_private_directory_token "$root")"
  if [[ "$current_uid" == 0 ]] && chown 1:1 "$root/item" 2>/dev/null; then
    owner_tested=true
    expect_failure 'private helper rejects a file owned by another uid' \
      'unsafe_private_file' cleanup_private_directory_token "$token" f:item
    if [[ -e "$root/item" ]]; then
      pass 'foreign-owned allowlisted file is preserved'
    else
      fail 'foreign-owned file was deleted' "$LAST_OUTPUT"
    fi
    chown "$current_uid:$current_gid" "$root/item"
  fi
  if [[ "$owner_tested" == false ]]; then
    pass 'foreign-owner mutation is not simulable without chown privilege'
  fi

  # shellcheck disable=SC2016 # State is intentionally isolated in one process.
  expect_success 'failed materialized cleanup latches ownership and blocks reentry' \
    bash -c '
      set -euo pipefail
      source "$1"
      root="$2"
      mkdir -m 700 "$root"
      printf "%s\n" wrong >"$root/.yenhubs-recovery-owner"
      chmod 600 "$root/.yenhubs-recovery-owner"
      RECOVERY_MATERIALIZED_DIR="$root"
      RECOVERY_MATERIALIZED_PARENT="$(dirname "$root")"
      RECOVERY_MATERIALIZED_MARKER="$root/.yenhubs-recovery-owner"
      RECOVERY_MATERIALIZED_PRIVATE_TOKEN="$(
        recovery_capture_private_directory_token "$root"
      )"
      RECOVERY_MATERIALIZED_ALLOWED_PATHS=(f:.yenhubs-recovery-owner)
      RECOVERY_MATERIALIZED_OWNED=1
      RECOVERY_MATERIALIZED_RETIRED=0
      RECOVERY_MATERIALIZED_CLEANUP_ATTEMPTED=0
      recovery_cleanup_materialized_checkpoint >/dev/null 2>&1 && exit 1
      [[ "$RECOVERY_MATERIALIZED_OWNED" == 1 &&
         "$RECOVERY_MATERIALIZED_CLEANUP_ATTEMPTED" == 1 && -e "$root" ]]
      printf "%s\n" yenhubs-recovery-materialized-v1 \
        >"$root/.yenhubs-recovery-owner"
      recovery_cleanup_materialized_checkpoint >/dev/null 2>&1 && exit 1
      [[ "$RECOVERY_MATERIALIZED_OWNED" == 1 &&
         "$RECOVERY_MATERIALIZED_CLEANUP_ATTEMPTED" == 1 && -e "$root" ]]
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
      "$TMP_DIR/private-helper-latched-materialized"
}

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
RECOVERY_OPERATION_FENCE_POLICY_FIXTURE="$ROOT_DIR/tests/recovery/fixtures/recovery-operation-pod-fence-policy.json"
RECOVERY_OPERATION_FENCE_BINDING_FIXTURE="$ROOT_DIR/tests/recovery/fixtures/recovery-operation-pod-fence-binding.json"
export KUBECTL_LOG STUB_STATE_DIR="$TMP_DIR/stub-state" STUB_SQL_PLAIN="$SQL_PLAIN" \
  STUB_TAR_STREAM="$TMP_DIR/valid.tar" RECOVERY_OPERATION_FENCE_POLICY_FIXTURE \
  RECOVERY_OPERATION_FENCE_BINDING_FIXTURE

cat >"$TMP_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$KUBECTL_LOG"
if [[ -n "${STUB_LOCAL_INPUT_BINDING_LOG:-}" ]]; then
  printf '%s\t%s\n' "${HCCE_MANIFEST_PATH:-}" \
    "${PROCESS_LOCAL_CUTOVER_KEY_PATH:-}" >>"$STUB_LOCAL_INPUT_BINDING_LOG"
fi
if [[ "${1:-}" == "--context" ]]; then shift 2; fi
request_timeout="${1:-}"
if [[ "${1:-}" == "--request-timeout=45s" ||
      "${1:-}" == "--request-timeout=75s" ||
      "${1:-}" == "--request-timeout=35s" ||
      "${1:-}" == "--request-timeout=30s" ||
      "${1:-}" == "--request-timeout=1s" ||
      "${1:-}" == "--request-timeout=2s" ||
      "${1:-}" == "--request-timeout=3s" ||
      "${1:-}" == "--request-timeout=4s" ||
      "${1:-}" == "--request-timeout=5s" ||
      "${1:-}" == "--request-timeout=3600s" ]]; then shift; else exit 89; fi
joined="$*"
LEASE_FIXTURE_LOCK_DIR="$STUB_STATE_DIR/serialization-lease-fixture-lock"
LEASE_FIXTURE_HANDOFF_DIR="$STUB_STATE_DIR/serialization-lease-watch-handoff.$PPID"
lease_fixture_lock_try_acquire() {
  mkdir "$LEASE_FIXTURE_LOCK_DIR" 2>/dev/null
}
lease_fixture_lock_acquire() {
  for _ in {1..300}; do
    lease_fixture_lock_try_acquire && return 0
    sleep 0.01
  done
  return 1
}
lease_fixture_lock_release() {
  rmdir "$LEASE_FIXTURE_LOCK_DIR"
}
lease_fixture_handoff_pending() {
  compgen -G "$STUB_STATE_DIR/serialization-lease-watch-handoff.*" >/dev/null
}
if [[ "${STUB_MONITOR_WATCH_PACE:-0}" == 1 &&
      "$joined" == *"watch=true"* &&
      "$joined" == *"timeoutSeconds=2"* &&
      "$joined" != *"sendInitialEvents=true"* ]]; then
  # The local kubectl stub closes ordinary WATCH requests immediately. Pace
  # only the durable parent-guard fixture so its two long-lived monitors do not
  # spin thousands of synthetic rounds and starve the child's first complete
  # quiescence sweep. Production still uses the real API watch duration.
  sleep 1
fi
# The checkpoint-evidence helper uses kubectl's namespace prefix and the
# plural Pods resource. Normalize those read-only forms to the long-standing
# fixture branches below, while retaining the 30-second timeout as provenance
# for the helper's full parent Deployment read.
case "$joined" in
  "-n hcce-bot-runners get pods -o json")
    set -- get pod -n hcce-bot-runners -o json
    joined="$*"
    ;;
  "get pods -n hcce -o json")
    set -- get pod -n hcce -o json
    joined="$*"
    ;;
  "-n hcce get configmap yenhubs-runner-cutover-v2 --ignore-not-found -o json")
    set -- get configmap yenhubs-runner-cutover-v2 -n hcce --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce get serviceaccount bot-orchestrator --ignore-not-found -o json")
    set -- get serviceaccount bot-orchestrator -n hcce --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce get role bot-orchestrator-runner-pods --ignore-not-found -o json")
    set -- get role bot-orchestrator-runner-pods -n hcce --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce get rolebinding bot-orchestrator-runner-pods --ignore-not-found -o json")
    set -- get rolebinding bot-orchestrator-runner-pods -n hcce --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get role bot-orchestrator-runner-pods --ignore-not-found -o json")
    set -- get role bot-orchestrator-runner-pods -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get rolebinding bot-orchestrator-runner-pods --ignore-not-found -o json")
    set -- get rolebinding bot-orchestrator-runner-pods -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get secret bot-images-pull --ignore-not-found -o json")
    set -- get secret bot-images-pull -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get serviceaccount bot-runner --ignore-not-found -o json")
    set -- get serviceaccount bot-runner -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get serviceaccount bot-runner-guard --ignore-not-found -o json")
    set -- get serviceaccount bot-runner-guard -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get resourcequota bot-runner-capacity --ignore-not-found -o json")
    set -- get resourcequota bot-runner-capacity -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get resourcequota bot-runner-guard-capacity --ignore-not-found -o json")
    set -- get resourcequota bot-runner-guard-capacity -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get networkpolicy bot-runner-default-deny --ignore-not-found -o json")
    set -- get networkpolicy bot-runner-default-deny -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
  "-n hcce-bot-runners get networkpolicy bot-runner-egress --ignore-not-found -o json")
    set -- get networkpolicy bot-runner-egress -n hcce-bot-runners --ignore-not-found -o json
    joined="$*"
    ;;
esac
write_monotonic_ns_marker() {
  python3 -I -c 'import time; print(time.time_ns())' >"$1"
}
run_restore_stream_fixture() {
  local marker_prefix="$1" stream_group_id
  stream_group_id="$(ps -o pgid= -p "$$" | awk '{$1=$1; print}')"
  [[ "$$" =~ ^[1-9][0-9]*$ && "$stream_group_id" =~ ^[1-9][0-9]*$ ]] ||
    exit 92
  printf '%s' "$$" >"$STUB_STATE_DIR/$marker_prefix-pid"
  printf '%s' "$stream_group_id" >"$STUB_STATE_DIR/$marker_prefix-pgid"
  trap 'write_monotonic_ns_marker "$STUB_STATE_DIR/'"$marker_prefix"'-terminated"; exit 143' \
    TERM INT
  (
    trap '' TERM INT
    while :; do sleep 1; done
  ) &
  printf '%s' "$!" >"$STUB_STATE_DIR/$marker_prefix-grandchild-pid"
  write_monotonic_ns_marker "$STUB_STATE_DIR/$marker_prefix-started"
  if [[ "${STUB_MODE:-}" == checkpoint-parent-writer-guard-stale ]]; then
    write_monotonic_ns_marker \
      "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-started"
  fi
  wait
  : >"$STUB_STATE_DIR/$marker_prefix-completed"
}
emit_recovery_fence_namespace_fixture() {
  jq '.metadata.labels = ((.metadata.labels // {}) +
    {"kubernetes.io/metadata.name": .metadata.name})' "$1"
}
if [[ "$joined" == "get namespace hcce-bot-runners -o json" ]]; then
  : >"$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-queried"
  fence_count_file="$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-count-${STUB_MODE:-default}"
  fence_count=0
  [[ ! -f "$fence_count_file" ]] || fence_count="$(cat "$fence_count_file")"
  fence_count=$((fence_count + 1))
  printf '%s' "$fence_count" >"$fence_count_file"
  case "${STUB_MODE:-}" in
    checkpoint-writer-fence-runner-namespace-missing) exit 1 ;;
    checkpoint-writer-fence-runner-namespace-timeout) exec sleep 12 ;;
    checkpoint-writer-fence-global-deadline)
      sleep 2
      emit_recovery_fence_namespace_fixture \
        "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json"
      ;;
    checkpoint-writer-fence-runner-namespace-terminating)
      emit_recovery_fence_namespace_fixture \
        "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json" |
        jq '.metadata.deletionTimestamp = "2026-07-21T00:00:00Z"'
      ;;
    checkpoint-writer-fence-runner-namespace-inactive)
      emit_recovery_fence_namespace_fixture \
        "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json" |
        jq '.status.phase = "Terminating"'
      ;;
    checkpoint-writer-fence-runner-namespace-label-drift)
      emit_recovery_fence_namespace_fixture \
        "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json" |
        jq '.metadata.labels["kubernetes.io/metadata.name"] = "wrong"'
      ;;
    checkpoint-writer-fence-runner-namespace-replaced-after-ready)
      if ((fence_count >= 5)); then
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json" |
          jq '.metadata.uid = "replacement-runner-namespace-uid" |
            .metadata.resourceVersion = "namespace-rv-runner-2"'
      else
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json"
      fi
      ;;
    checkpoint-writer-fence-runner-namespace-rv-drift-after-ready)
      if ((fence_count >= 5)); then
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json" |
          jq '.metadata.resourceVersion = "namespace-rv-runner-2"'
      else
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json"
      fi
      ;;
    *)
      emit_recovery_fence_namespace_fixture \
        "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json"
      ;;
  esac
  exit 0
fi
if [[ "$joined" == \
      "get validatingadmissionpolicy recovery-operation-pod-fence.yenhubs.org -o json" ]]; then
  : >"$STUB_STATE_DIR/recovery-operation-fence-policy-queried"
  fence_count_file="$STUB_STATE_DIR/recovery-operation-fence-policy-count-${STUB_MODE:-default}"
  fence_count=0
  [[ ! -f "$fence_count_file" ]] || fence_count="$(cat "$fence_count_file")"
  fence_count=$((fence_count + 1))
  printf '%s' "$fence_count" >"$fence_count_file"
  case "${STUB_MODE:-}" in
    checkpoint-writer-fence-policy-missing) exit 1 ;;
    checkpoint-writer-fence-policy-timeout) exec sleep 12 ;;
    checkpoint-writer-fence-global-deadline)
      sleep 2
      cat "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-warning)
      jq '.status.typeChecking.expressionWarnings = [{fieldRef:"spec.validations[0].expression",warning:"fixture warning"}]' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-unobserved)
      jq '.status.observedGeneration = 6' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-param-kind)
      jq '.spec.paramKind = {apiVersion:"fixture/v1",kind:"Forbidden"}' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-terminating)
      jq '.metadata.deletionTimestamp = "2026-07-21T00:00:00Z"' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-uid-drift)
      jq '.metadata.uid = "replacement-policy-uid"' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-rv-drift)
      jq '.metadata.resourceVersion = "recovery-operation-fence-policy-rv-2"' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-spec-drift)
      jq '.spec.failurePolicy = "Ignore"' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-rule-drift)
      jq '.spec.matchConstraints.resourceRules[0].operations += ["CONNECT"]' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-variable-drift)
      jq '.spec.variables[0].expression = "true"' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-message-drift)
      jq '.spec.validations[0].message = "different message"' \
        "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      ;;
    checkpoint-writer-fence-policy-drift-after-ready)
      if ((fence_count >= 5)); then
        jq '.metadata.resourceVersion = "recovery-operation-fence-policy-rv-2"' \
          "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      else
        cat "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      fi
      ;;
    checkpoint-writer-fence-policy-aba-after-ready)
      if ((fence_count >= 5)); then
        jq '.metadata.resourceVersion = "recovery-operation-fence-policy-rv-3"' \
          "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      else
        cat "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      fi
      ;;
    checkpoint-writer-fence-policy-drift-second-boundary-read)
      if ((fence_count >= 2)); then
        jq '.metadata.resourceVersion = "recovery-operation-fence-policy-rv-2"' \
          "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      else
        cat "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
      fi
      ;;
    *) cat "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE" ;;
  esac
  exit 0
fi
if [[ "$joined" == \
      "get validatingadmissionpolicybinding recovery-operation-pod-fence.yenhubs.org -o json" ]]; then
  : >"$STUB_STATE_DIR/recovery-operation-fence-binding-queried"
  fence_count_file="$STUB_STATE_DIR/recovery-operation-fence-binding-count-${STUB_MODE:-default}"
  fence_count=0
  [[ ! -f "$fence_count_file" ]] || fence_count="$(cat "$fence_count_file")"
  fence_count=$((fence_count + 1))
  printf '%s' "$fence_count" >"$fence_count_file"
  case "${STUB_MODE:-}" in
    checkpoint-writer-fence-binding-missing) exit 1 ;;
    checkpoint-writer-fence-binding-timeout) exec sleep 12 ;;
    checkpoint-writer-fence-global-deadline) exec sleep 12 ;;
    checkpoint-writer-fence-binding-dormant)
      jq '.spec.matchResources.namespaceSelector.matchExpressions = [{key:"kubernetes.io/metadata.name",operator:"DoesNotExist"}]' \
        "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      ;;
    checkpoint-writer-fence-binding-param-ref)
      jq '.spec.paramRef = {name:"forbidden"}' \
        "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      ;;
    checkpoint-writer-fence-binding-params)
      jq '.spec.params = {forbidden:true}' \
        "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      ;;
    checkpoint-writer-fence-binding-terminating)
      jq '.metadata.deletionTimestamp = "2026-07-21T00:00:00Z"' \
        "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      ;;
    checkpoint-writer-fence-binding-uid-drift)
      jq '.metadata.uid = "replacement-binding-uid"' \
        "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      ;;
    checkpoint-writer-fence-binding-rv-drift)
      jq '.metadata.resourceVersion = "recovery-operation-fence-binding-rv-2"' \
        "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      ;;
    checkpoint-writer-fence-binding-drift-after-ready)
      if ((fence_count >= 5)); then
        jq '.metadata.resourceVersion = "recovery-operation-fence-binding-rv-2"' \
          "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      else
        cat "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      fi
      ;;
    *)
      if [[ "${STUB_MODE:-}" == checkpoint-dormant-fence-aba-before-lock-release &&
            -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" &&
            -f "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" &&
            "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")" == dormant &&
            "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")" == \
              recovery-operation-fence-binding-rv-3 ]]; then
        all_writers_resumed=true
        for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
          if [[ "$(cat "$STUB_STATE_DIR/replicas-$writer" 2>/dev/null || :)" != 1 ]]; then
            all_writers_resumed=false
          fi
        done
        if [[ "$all_writers_resumed" == true &&
              -z "$(find "$STUB_STATE_DIR" -maxdepth 1 -type f \
                -name 'checkpoint-resume-receipt-*' -print -quit)" ]]; then
          dormant_post_resume_count_file="$STUB_STATE_DIR/checkpoint-dormant-fence-post-resume-read-count"
          dormant_post_resume_read=0
          [[ ! -f "$dormant_post_resume_count_file" ]] ||
            dormant_post_resume_read="$(cat "$dormant_post_resume_count_file")"
          dormant_post_resume_read=$((dormant_post_resume_read + 1))
          printf '%s' "$dormant_post_resume_read" \
            >"$dormant_post_resume_count_file"
          if [[ "$dormant_post_resume_read" -ge 2 &&
                ! -e "$STUB_STATE_DIR/checkpoint-dormant-fence-aba-before-lock-release-observed" ]]; then
            # Model an external dormant(rv3) -> active(rv4) -> dormant(rv5)
            # excursion. The final state has the same semantics but a new RV.
            printf '%s' recovery-operation-fence-binding-rv-5 \
              >"$STUB_STATE_DIR/recovery-operation-fence-binding-rv"
            : >"$STUB_STATE_DIR/checkpoint-dormant-fence-aba-before-lock-release-observed"
          fi
        fi
      fi
      if [[ -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" ]]; then
        fence_state="$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")"
        fence_rv="$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")"
        if [[ "$fence_state" == dormant ]]; then
          jq --arg rv "$fence_rv" '
            .metadata.resourceVersion = $rv |
            .spec.matchResources.namespaceSelector.matchExpressions = [{
              key:"kubernetes.io/metadata.name",operator:"DoesNotExist"}]
          ' "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
        elif [[ "$fence_state" == active ]]; then
          jq --arg rv "$fence_rv" '.metadata.resourceVersion = $rv' \
            "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
        else
          exit 1
        fi
      else
        cat "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
      fi
      ;;
  esac
  exit 0
fi
if [[ ( "${STUB_MODE:-}" == parent-death-stream ||
        "${STUB_MODE:-}" == guard-failure-stream ) &&
      "$joined" == "exec -n hcce parent-death-probe -- destructive-stream" ]]; then
  stream_marker_prefix="${STUB_MODE%-stream}"
  stream_monotonic_milliseconds() {
    python3 -I -c 'import time; print(time.monotonic_ns() // 1_000_000)'
  }
  stream_publish_monotonic_marker() {
    local marker_path="$1" next_path="${1}.next.$$"
    [[ ! -e "$next_path" && ! -L "$next_path" ]] || return 1
    stream_monotonic_milliseconds >"$next_path" || {
      rm -f -- "$next_path"
      return 1
    }
    chmod 600 "$next_path" || {
      rm -f -- "$next_path"
      return 1
    }
    mv -f -- "$next_path" "$marker_path"
  }
  stream_group_id="$(ps -o pgid= -p "$$" | awk '{$1=$1; print}')"
  [[ "$$" =~ ^[1-9][0-9]*$ && "$stream_group_id" =~ ^[1-9][0-9]*$ ]] || exit 92
  printf '%s' "$$" >"$STUB_STATE_DIR/$stream_marker_prefix-stream-pid"
  printf '%s' "$stream_group_id" \
    >"$STUB_STATE_DIR/$stream_marker_prefix-stream-pgid"
  trap 'stream_publish_monotonic_marker "$STUB_STATE_DIR/$stream_marker_prefix-stream-terminated"; exit 143' TERM INT
  (
    trap '' TERM INT
    while :; do sleep 1; done
  ) &
  printf '%s' "$!" >"$STUB_STATE_DIR/$stream_marker_prefix-grandchild-pid"
  stream_publish_monotonic_marker \
    "$STUB_STATE_DIR/$stream_marker_prefix-stream-started" || exit 93
  wait
  printf completed >"$STUB_STATE_DIR/$stream_marker_prefix-stream-completed"
  exit 0
fi
if [[ "${STUB_MODE:-}" == multi-guard-stream &&
      "$joined" == "exec -n hcce parent-death-probe -- destructive-stream" ]]; then
  printf started >"$STUB_STATE_DIR/multi-guard-stream-started"
  sleep 0.2
  printf completed >"$STUB_STATE_DIR/multi-guard-stream-completed"
  exit 0
fi
yaml_field() {
  local pattern="$1" file="$2"
  awk -v pattern="$pattern" '$0 ~ pattern {value=$0; sub(/^[^:]+:[[:space:]]*/, "", value); gsub(/^"|"$/, "", value); print value; exit}' "$file"
}
emit_created_storage_network_policy() {
  local policy_yaml="$STUB_STATE_DIR/network-policy.yaml"
  local policy_name policy_uid policy_rv owner_role operation_id lock_uid owner_token
  [[ -f "$policy_yaml" ]] || return 1
  policy_name="$(cat "$STUB_STATE_DIR/network-policy-name")"
  policy_uid="${1:-$(cat "$STUB_STATE_DIR/network-policy-uid")}"
  policy_rv="$(cat "$STUB_STATE_DIR/network-policy-rv")"
  owner_role="$(yaml_field 'yenhubs.org/recovery-owner:' "$policy_yaml")"
  operation_id="$(yaml_field 'yenhubs.org/operation-id:' "$policy_yaml")"
  lock_uid="$(yaml_field 'yenhubs.org/operation-lock-uid:' "$policy_yaml")"
  owner_token="$(yaml_field 'yenhubs.org/operation-token:' "$policy_yaml")"
  jq -cn --arg name "$policy_name" --arg uid "$policy_uid" --arg rv "$policy_rv" \
    --arg role "$owner_role" --arg operation_id "$operation_id" \
    --arg lock_uid "$lock_uid" --arg token "$owner_token" '
    {apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",
      metadata:{name:$name,uid:$uid,resourceVersion:$rv,namespace:"hcce",
        labels:{"yenhubs.org/recovery-owner":$role,
          "yenhubs.org/operation-id":$operation_id},
        annotations:{"yenhubs.org/operation-lock-uid":$lock_uid,
          "yenhubs.org/operation-token":$token}},
      spec:{podSelector:{matchLabels:{"yenhubs.org/operation-id":$operation_id}},
        policyTypes:["Ingress","Egress"],ingress:[],egress:[]}}
  '
}
emit_created_storage_helper_pod() {
  local pod_yaml="$STUB_STATE_DIR/applied.yaml"
  local pod_name pod_uid pod_rv owner_role operation_id lock_uid owner_token
  local helper_image read_only helper_json
  [[ -f "$pod_yaml" ]] || return 1
  pod_name="$(cat "$STUB_STATE_DIR/pod-name")"
  pod_uid="${1:-$(cat "$STUB_STATE_DIR/pod-uid")}"
  pod_rv="$(cat "$STUB_STATE_DIR/pod-rv")"
  owner_role="$(yaml_field 'yenhubs.org/recovery-owner:' "$pod_yaml")"
  operation_id="$(yaml_field 'yenhubs.org/operation-id:' "$pod_yaml")"
  lock_uid="$(yaml_field 'yenhubs.org/operation-lock-uid:' "$pod_yaml")"
  owner_token="$(yaml_field 'yenhubs.org/operation-token:' "$pod_yaml")"
  helper_image="$(yaml_field '^[[:space:]]+image:' "$pod_yaml")"
  read_only="$(yaml_field '^[[:space:]]+readOnly:' "$pod_yaml")"
  helper_json="$(jq -cn --arg name "$pod_name" --arg uid "$pod_uid" \
    --arg rv "$pod_rv" --arg role "$owner_role" --arg operation_id "$operation_id" \
    --arg lock_uid "$lock_uid" --arg token "$owner_token" --arg image "$helper_image" \
    --argjson read_only "$read_only" '
    {apiVersion:"v1",kind:"Pod",metadata:{name:$name,uid:$uid,
      resourceVersion:$rv,namespace:"hcce",
      labels:{"yenhubs.org/recovery-owner":$role,
        "yenhubs.org/operation-id":$operation_id},
      annotations:({"yenhubs.org/operation-lock-uid":$lock_uid} +
        if $token == "" then {"yenhubs.org/operation-id":$operation_id}
        else {"yenhubs.org/operation-token":$token} end)},
      spec:{automountServiceAccountToken:false,enableServiceLinks:false,
        restartPolicy:"Never",terminationGracePeriodSeconds:1,
        activeDeadlineSeconds:3600,
        securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,
          fsGroup:1000,fsGroupChangePolicy:"OnRootMismatch",
          seccompProfile:{type:"RuntimeDefault"}},
        volumes:[{name:"storage",persistentVolumeClaim:
          {claimName:"ret-pvc",readOnly:$read_only}}],
        containers:[{name:"helper",image:$image,
          command:["sh","-c","sleep 3600"],
          securityContext:{allowPrivilegeEscalation:false,
            readOnlyRootFilesystem:true,capabilities:{drop:["ALL"]}},
          volumeMounts:[{name:"storage",mountPath:"/storage",
            readOnly:$read_only}]}]}}
  ')"
  if [[ "${STUB_MODE:-}" == "restore-pod-decoy" ]]; then
    jq -c '.spec.volumes += [{name:"decoy",emptyDir:{}}] |
      .spec.containers[0].volumeMounts = [
        {name:"storage",mountPath:"/other"},
        {name:"decoy",mountPath:"/storage"}]' <<<"$helper_json"
  elif [[ "${STUB_MODE:-}" == "restore-pod-extra-volume" ]]; then
    jq -c '.spec.volumes += [{name:"decoy",emptyDir:{}}] |
      .spec.containers[0].volumeMounts += [
        {name:"decoy",mountPath:"/tmp/decoy"}]' <<<"$helper_json"
  else
    printf '%s' "$helper_json"
  fi
}
publish_created_storage_helper_pod_snapshot() {
  local snapshot="$STUB_STATE_DIR/storage-helper-pod-live.json"
  local snapshot_next="$snapshot.next.$$"
  emit_created_storage_helper_pod >"$snapshot_next" || {
    rm -f -- "$snapshot_next"
    return 1
  }
  chmod 600 "$snapshot_next" || {
    rm -f -- "$snapshot_next"
    return 1
  }
  mv "$snapshot_next" "$snapshot"
}
read_created_storage_helper_pod_snapshot() {
  local snapshot="$STUB_STATE_DIR/storage-helper-pod-live.json"
  local purpose="${1:-read}"
  if [[ "$purpose" == list-open-missing-race ]]; then
    rm -f -- "$snapshot"
  fi
  # A concurrent UID-delete may win after LIST observed the path but before
  # open(2). Kubernetes semantics for the next LIST are simply an empty list;
  # suppress the shell's redirection diagnostic and let the caller emit that.
  { exec 9<"$snapshot"; } 2>/dev/null || return 1
  if [[ "$purpose" == list &&
        "${STUB_MODE:-}" == helper-pod-list-delete-race ]]; then
    : >"$STUB_STATE_DIR/helper-pod-list-snapshot-opened"
    for _ in {1..500}; do
      [[ -e "$STUB_STATE_DIR/helper-pod-delete-finished" ]] && break
      sleep 0.01
    done
    [[ -e "$STUB_STATE_DIR/helper-pod-delete-finished" ]] || {
      exec 9<&-
      return 91
    }
  fi
  cat <&9
  exec 9<&-
}
atomic_stub_counter() {
  local prefix="$1" value=1
  while ! mkdir "$STUB_STATE_DIR/$prefix.$value" 2>/dev/null; do
    value=$((value + 1))
    [[ "$value" -le 10000 ]] || return 1
  done
  printf '%s' "$value"
}
checkpoint_receipt_trace() {
  local phase="$1"
  [[ -z "${STUB_CHECKPOINT_RECEIPT_TRACE:-}" ]] ||
    printf '%s\n' "$phase" >>"$STUB_CHECKPOINT_RECEIPT_TRACE"
}
checkpoint_receipt_record_once() {
  local marker="$1" phase="$2"
  if mkdir "$STUB_STATE_DIR/checkpoint-receipt-phase-$marker" 2>/dev/null; then
    checkpoint_receipt_trace "$phase"
    return 0
  fi
  return 1
}
checkpoint_receipt_monitor_path() {
  local leaf="$1" candidate=""
  if [[ -n "${STUB_CHECKPOINT_WRITER_MONITOR_DIR:-}" ]]; then
    candidate="$STUB_CHECKPOINT_WRITER_MONITOR_DIR/$leaf"
    [[ -f "$candidate" ]] || return 1
    printf '%s\n' "$candidate"
    return 0
  fi
  [[ "${STUB_CHECKPOINT_WRITER_DISCOVER_MONITOR:-0}" == 1 ]] || return 1
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] || {
      printf '%s\n' "$candidate/$leaf"
      return 0
    }
  done < <(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d \
    -name 'yenhubs-restore-writer-monitor.*' -print 2>/dev/null | sort)
  return 1
}
checkpoint_receipt_observe_handoff_marker() {
  local stop_path handoff
  stop_path="$(checkpoint_receipt_monitor_path stop 2>/dev/null || :)"
  [[ -n "$stop_path" && -s "$stop_path" ]] || return 0
  handoff="$(jq -r '.handoff // empty' "$stop_path" 2>/dev/null || :)"
  case "$handoff" in
    receipt-arm)
      checkpoint_receipt_record_once arm 'ARM' || :
      ;;
    receipt-commit)
      checkpoint_receipt_record_once commit 'COMMIT' || :
      ;;
  esac
}
emit_checkpoint_writer_deployments() {
  local reticulum_replicas=1 pgbouncer_replicas=1 pgbouncer_t_replicas=1
  local orchestrator_replicas=1 coturn_replicas=1
  local reticulum_rv=1 pgbouncer_rv=1 pgbouncer_t_rv=1 orchestrator_rv=1 coturn_rv=1
  local deployment receipt_file deployments_json generation
  local recovery_phase=active recovery_phase_override=false
  local recovery_epoch="$LIVE_RUNNER_EPOCH" recovery_epoch_override=false
  [[ ! -f "$STUB_STATE_DIR/replicas-reticulum" ]] ||
    reticulum_replicas="$(cat "$STUB_STATE_DIR/replicas-reticulum")"
  [[ ! -f "$STUB_STATE_DIR/replicas-pgbouncer" ]] ||
    pgbouncer_replicas="$(cat "$STUB_STATE_DIR/replicas-pgbouncer")"
  [[ ! -f "$STUB_STATE_DIR/replicas-pgbouncer-t" ]] ||
    pgbouncer_t_replicas="$(cat "$STUB_STATE_DIR/replicas-pgbouncer-t")"
  [[ ! -f "$STUB_STATE_DIR/replicas-bot-orchestrator" ]] ||
    orchestrator_replicas="$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator")"
  [[ ! -f "$STUB_STATE_DIR/replicas-coturn" ]] ||
    coturn_replicas="$(cat "$STUB_STATE_DIR/replicas-coturn")"
  [[ ! -f "$STUB_STATE_DIR/rv-reticulum" ]] ||
    reticulum_rv="$(cat "$STUB_STATE_DIR/rv-reticulum")"
  [[ ! -f "$STUB_STATE_DIR/rv-pgbouncer" ]] ||
    pgbouncer_rv="$(cat "$STUB_STATE_DIR/rv-pgbouncer")"
  [[ ! -f "$STUB_STATE_DIR/rv-pgbouncer-t" ]] ||
    pgbouncer_t_rv="$(cat "$STUB_STATE_DIR/rv-pgbouncer-t")"
  [[ ! -f "$STUB_STATE_DIR/rv-bot-orchestrator" ]] ||
    orchestrator_rv="$(cat "$STUB_STATE_DIR/rv-bot-orchestrator")"
  [[ ! -f "$STUB_STATE_DIR/rv-coturn" ]] ||
    coturn_rv="$(cat "$STUB_STATE_DIR/rv-coturn")"
  if [[ -f "$STUB_STATE_DIR/recovery-phase" ]]; then
    recovery_phase="$(cat "$STUB_STATE_DIR/recovery-phase")"
    recovery_phase_override=true
  fi
  if [[ -f "$STUB_STATE_DIR/recovery-epoch" ]]; then
    recovery_epoch="$(cat "$STUB_STATE_DIR/recovery-epoch")"
    recovery_epoch_override=true
  fi
  deployments_json="$(jq -c \
    --argjson reticulum_replicas "$reticulum_replicas" \
    --argjson pgbouncer_replicas "$pgbouncer_replicas" \
    --argjson pgbouncer_t_replicas "$pgbouncer_t_replicas" \
    --argjson orchestrator_replicas "$orchestrator_replicas" \
    --argjson coturn_replicas "$coturn_replicas" \
    --arg reticulum_rv "rv-reticulum-$reticulum_rv" \
    --arg pgbouncer_rv "rv-pgbouncer-$pgbouncer_rv" \
    --arg pgbouncer_t_rv "rv-pgbouncer-t-$pgbouncer_t_rv" \
    --arg orchestrator_rv "rv-bot-orchestrator-$orchestrator_rv" \
    --arg coturn_rv "rv-coturn-$coturn_rv" \
    --arg recovery_phase "$recovery_phase" \
    --argjson recovery_phase_override "$recovery_phase_override" \
    --arg recovery_epoch "$recovery_epoch" \
    --argjson recovery_epoch_override "$recovery_epoch_override" '
    def state($name):
      if $name == "reticulum" then [$reticulum_replicas,$reticulum_rv]
      elif $name == "pgbouncer" then [$pgbouncer_replicas,$pgbouncer_rv]
      elif $name == "pgbouncer-t" then [$pgbouncer_t_replicas,$pgbouncer_t_rv]
      elif $name == "bot-orchestrator" then [$orchestrator_replicas,$orchestrator_rv]
      elif $name == "coturn" then [$coturn_replicas,$coturn_rv]
      else [1,("rv-"+$name+"-1")] end;
    {apiVersion:"apps/v1",kind:"DeploymentList",
      metadata:{resourceVersion:"writer-deployments-list-rv"},
      items:[.items[] |
        select(.metadata.name as $name |
          ["bot-orchestrator","coturn","dialog","haproxy","hubs","nearspark",
           "pgbouncer","pgbouncer-t","photomnemonic","pgsql","reticulum","spoke"] |
          index($name)) |
        .metadata.name as $name | state($name) as $state |
        .apiVersion = "apps/v1" | .kind = "Deployment" |
        .metadata.namespace = "hcce" | .metadata.resourceVersion = $state[1] |
        .metadata.generation = 1 |
        if $recovery_phase_override then
          .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] =
            $recovery_phase
        else . end |
        .spec.replicas = $state[0] |
        .spec.strategy = (.spec.strategy // {}) |
        .spec.template.metadata = ((.spec.template.metadata // {}) +
          {labels:{app:$name}}) |
        if $recovery_epoch_override then
          .spec.template.metadata.annotations["yenhubs.org/bot-runner-recovery-epoch"] =
            $recovery_epoch
        else . end]}
  ' "$STUB_DEPLOYMENTS_JSON")" || return 1
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    receipt_file="$STUB_STATE_DIR/checkpoint-resume-receipt-$deployment"
    generation=1
    [[ ! -f "$STUB_STATE_DIR/generation-$deployment" ]] ||
      generation="$(cat "$STUB_STATE_DIR/generation-$deployment")"
    deployments_json="$(jq -c --arg name "$deployment" \
      --argjson generation "$generation" \
      --arg receipt "$([[ -f "$receipt_file" ]] && cat "$receipt_file" || :)" '
      (.items[] | select(.metadata.name == $name) | .metadata.generation) = $generation |
      if $receipt == "" then . else
        (.items[] | select(.metadata.name == $name) |
          .metadata.annotations["yenhubs.org/checkpoint-resume-operation"]) = $receipt
      end
    ' <<<"$deployments_json")" || return 1
  done
  if [[ -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]]; then
    deployments_json="$(jq -c '
      .metadata.resourceVersion = "receipt-final-deployments-list-rv"
    ' <<<"$deployments_json")" || return 1
  fi
  printf '%s' "$deployments_json"
}
emit_checkpoint_writer_replicasets() {
  local list_rv=writer-replicasets-list-rv
  local deployment replicas
  local replica_state='{}'
  if [[ "${STUB_MODE:-}" == legacy-receipt-w1-replicaset &&
        -d "$STUB_STATE_DIR/checkpoint-receipt-phase-arm" &&
        ! -d "$STUB_STATE_DIR/checkpoint-receipt-phase-rs-list-boundary" ]]; then
    for _ in {1..500}; do
      [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-rs-w1-closed" ]] && break
      sleep 0.01
    done
    [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-rs-w1-closed" ]] || return 91
    checkpoint_receipt_record_once rs-excursion 'RS_EXCURSION' || :
    list_rv=receipt-race-replicasets-list-rv
    checkpoint_receipt_record_once rs-list-boundary 'RS_LIST_BOUNDARY' || :
  fi
  [[ ! -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] ||
    list_rv=receipt-final-replicasets-list-rv
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    replicas=1
    [[ ! -f "$STUB_STATE_DIR/replicas-$deployment" ]] ||
      replicas="$(cat "$STUB_STATE_DIR/replicas-$deployment")"
    replica_state="$(jq -cn --argjson state "$replica_state" \
      --arg name "$deployment" --argjson replicas "$replicas" \
      '$state + {($name):$replicas}')"
  done
  jq -c --arg list_rv "$list_rv" --arg pod_template_hash fixture-hash-13 \
    --argjson replica_state "$replica_state" \
    --argjson historical_active \
      "$([[ "${STUB_MODE:-}" == rolling-preflight-historical-active ]] && \
        printf true || printf false)" '
    . as $root |
    {apiVersion:"apps/v1",kind:"ReplicaSetList",
      metadata:{resourceVersion:$list_rv},
      items:([$root.items[] |
        .metadata.name as $name |
        .metadata.uid as $deployment_uid |
        (.metadata.annotations["deployment.kubernetes.io/revision"] // "") as $revision |
        {apiVersion:"apps/v1",kind:"ReplicaSet",metadata:{
        name:($name+"-rs"),namespace:"hcce",uid:($name+"-rs-uid"),
        resourceVersion:("rv-"+$name+"-rs-1"),generation:1,
        labels:{app:$name},annotations:(if $name == "bot-orchestrator" then
          {"deployment.kubernetes.io/revision":$revision} else {} end),
        ownerReferences:[{apiVersion:"apps/v1",kind:"Deployment",
          name:$name,uid:$deployment_uid,controller:true}]},
        spec:{replicas:($replica_state[$name] // 1),
          selector:{matchLabels:({app:$name} +
            if $name == "bot-orchestrator" then
              {"pod-template-hash":$pod_template_hash} else {} end)},
          template:(.spec.template |
            .metadata = ((.metadata // {}) + {labels:({app:$name} +
              if $name == "bot-orchestrator" then
                {"pod-template-hash":$pod_template_hash} else {} end)}))},
        status:{replicas:($replica_state[$name] // 1),
          readyReplicas:($replica_state[$name] // 1),
          availableReplicas:($replica_state[$name] // 1)}}] +
        [$root.items[] | select(.metadata.name == "bot-orchestrator") |
          .metadata.uid as $deployment_uid |
          {apiVersion:"apps/v1",kind:"ReplicaSet",metadata:{
            name:"bot-orchestrator-rs-historical",
            namespace:"hcce",uid:"bot-orchestrator-rs-historical-uid",
            resourceVersion:"rv-bot-orchestrator-rs-historical-1",generation:1,
            labels:{app:"bot-orchestrator"},ownerReferences:[{
              apiVersion:"apps/v1",kind:"Deployment",name:"bot-orchestrator",
              uid:$deployment_uid,controller:true}]},
           spec:{replicas:(if $historical_active then 1 else 0 end),
             selector:{matchLabels:{app:"bot-orchestrator"}},
             template:(.spec.template |
               .metadata = ((.metadata // {}) + {
                 labels:{app:"bot-orchestrator"},
                 annotations:{"fixture.invalid/historical":"true"}}))},
           status:{replicas:(if $historical_active then 1 else 0 end),
             readyReplicas:(if $historical_active then 1 else 0 end),
             availableReplicas:(if $historical_active then 1 else 0 end)}}])}
  ' "$STUB_DEPLOYMENTS_JSON"
}
emit_checkpoint_writer_pods() {
  local list_rv=writer-pods-list-rv
  if [[ "${STUB_MODE:-}" == legacy-receipt-w1-pod &&
        -d "$STUB_STATE_DIR/checkpoint-receipt-phase-arm" &&
        ! -d "$STUB_STATE_DIR/checkpoint-receipt-phase-pod-list-boundary" ]]; then
    for _ in {1..500}; do
      [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-pod-w1-closed" ]] && break
      sleep 0.01
    done
    [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-pod-w1-closed" ]] || return 91
    checkpoint_receipt_record_once pod-excursion 'POD_EXCURSION' || :
    list_rv=receipt-race-pods-list-rv
    checkpoint_receipt_record_once pod-list-boundary 'POD_LIST_BOUNDARY' || :
  fi
  [[ ! -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] ||
    list_rv=receipt-final-pods-list-rv
  jq -c --arg list_rv "$list_rv" '
    {apiVersion:"v1",kind:"PodList",
      metadata:{resourceVersion:$list_rv},
      items:[.items[] |
        .metadata.name as $name |
        select(["bot-orchestrator","coturn","pgbouncer","pgbouncer-t","reticulum"] |
          index($name) | not) |
        {apiVersion:"v1",kind:"Pod",metadata:((.spec.template.metadata // {}) + {
          name:($name+"-0"),namespace:"hcce",uid:($name+"-pod-uid"),
          resourceVersion:("rv-"+$name+"-pod-1"),
          labels:((.spec.template.metadata.labels // {}) + {app:$name}),
          ownerReferences:[{apiVersion:"apps/v1",kind:"ReplicaSet",
            name:($name+"-rs"),uid:($name+"-rs-uid"),controller:true}]}),
          spec:.spec.template.spec,
          status:{phase:"Running",conditions:[{type:"Ready",status:"True"}]}}]}
  ' "$STUB_DEPLOYMENTS_JSON"
}
emit_process_local_parent_pods() {
  local replicas=1
  [[ ! -f "$STUB_STATE_DIR/replicas-bot-orchestrator" ]] ||
    replicas="$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator")"
  if [[ "$replicas" == 0 ]]; then
    jq -cn '{apiVersion:"v1",kind:"PodList",
      metadata:{resourceVersion:"rolling-parent-pods-rv-0"},items:[]}'
    return
  fi
  jq -cn --argjson replicas "$replicas" '
    {apiVersion:"v1",kind:"PodList",
     metadata:{resourceVersion:"rolling-parent-pods-rv-1"},
     items:[range(0;$replicas) | {apiVersion:"v1",kind:"Pod",metadata:{
       name:("bot-orchestrator-"+(.|tostring)),
       namespace:"hcce",uid:("bot-orchestrator-pod-uid-"+(.|tostring)),
       resourceVersion:("bot-orchestrator-pod-rv-"+(.|tostring)),
       labels:{app:"bot-orchestrator"},ownerReferences:[{
         apiVersion:"apps/v1",kind:"ReplicaSet",name:"bot-orchestrator-rs",
         uid:"bot-orchestrator-rs-uid",controller:true}]},
       status:{phase:"Running",conditions:[{type:"Ready",status:"True"}]}}]}
  '
}
emit_checkpoint_storage_helper_pod() {
  local resource_version="$1" phase="$2" deletion_timestamp="${3:-}"
  local operation_owner="${STUB_CHECKPOINT_WRITER_OPERATION_OWNER:-}"
  local helper_role helper_read_only
  case "$operation_owner" in
    checkpoint-backup) helper_role=ret-storage-backup; helper_read_only=true ;;
    checkpoint-restore) helper_role=ret-storage-restore; helper_read_only=false ;;
    *) return 2 ;;
  esac
  if [[ "${STUB_MODE:-}" == checkpoint-writer-helper-cross-owner ]]; then
    if [[ "$operation_owner" == checkpoint-backup ]]; then
      helper_role=ret-storage-restore
    else
      helper_role=ret-storage-backup
    fi
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-helper-cross-mode ]]; then
    if [[ "$helper_read_only" == true ]]; then
      helper_read_only=false
    else
      helper_read_only=true
    fi
  fi
  jq -cn --arg rv "$resource_version" --arg phase "$phase" \
    --arg deletion_timestamp "$deletion_timestamp" --arg role "$helper_role" \
    --argjson read_only "$helper_read_only" '
    {apiVersion:"v1",kind:"Pod",metadata:({
      name:($role+"-888888888888"),namespace:"hcce",
      uid:($role+"-helper-uid"),resourceVersion:$rv,
      labels:{"yenhubs.org/recovery-owner":$role,
        "yenhubs.org/operation-id":("8"*32)},
      annotations:{"yenhubs.org/operation-lock-uid":"restore-lock-uid",
        "yenhubs.org/operation-token":("7"*32)}} +
      if $deletion_timestamp == "" then {} else
        {deletionTimestamp:$deletion_timestamp} end),
      spec:{automountServiceAccountToken:false,enableServiceLinks:false,
        restartPolicy:"Never",activeDeadlineSeconds:3600,
        securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,
          fsGroup:1000,fsGroupChangePolicy:"OnRootMismatch",
          seccompProfile:{type:"RuntimeDefault"}},
        containers:[{name:"helper",
          image:("ghcr.io/yengalvez/reticulum@sha256:"+("6"*64)),
          command:["sh","-c","sleep 3600"],
          securityContext:{allowPrivilegeEscalation:false,
            readOnlyRootFilesystem:true,capabilities:{drop:["ALL"]}},
          volumeMounts:[{name:"storage",mountPath:"/storage",readOnly:$read_only}]}],
        volumes:[{name:"storage",persistentVolumeClaim:{
          claimName:"ret-pvc",readOnly:$read_only}}]},
      status:({phase:$phase} + if $phase == "Running" then
        {conditions:[{type:"Ready",status:"True"}]} else {} end)}
  '
}
emit_stub_deployment_json() {
  local deployment="$1" replicas=1 rv_number=1 recovery_phase=active
  local recovery_phase_override=false recovery_epoch="$LIVE_RUNNER_EPOCH"
  local recovery_epoch_override=false receipt_file deployment_json generation=1
  [[ ! -f "$STUB_STATE_DIR/replicas-$deployment" ]] ||
    replicas="$(cat "$STUB_STATE_DIR/replicas-$deployment")"
  [[ ! -f "$STUB_STATE_DIR/rv-$deployment" ]] ||
    rv_number="$(cat "$STUB_STATE_DIR/rv-$deployment")"
  [[ ! -f "$STUB_STATE_DIR/generation-$deployment" ]] ||
    generation="$(cat "$STUB_STATE_DIR/generation-$deployment")"
  if [[ -f "$STUB_STATE_DIR/recovery-phase" ]]; then
    recovery_phase="$(cat "$STUB_STATE_DIR/recovery-phase")"
    recovery_phase_override=true
  fi
  if [[ -f "$STUB_STATE_DIR/recovery-epoch" ]]; then
    recovery_epoch="$(cat "$STUB_STATE_DIR/recovery-epoch")"
    recovery_epoch_override=true
  fi
  deployment_json="$(jq -ce --arg name "$deployment" \
    --arg rv "rv-$deployment-$rv_number" --argjson replicas "$replicas" \
    --argjson generation "$generation" \
    --arg recovery_phase "$recovery_phase" \
    --argjson recovery_phase_override "$recovery_phase_override" \
    --arg recovery_epoch "$recovery_epoch" \
    --argjson recovery_epoch_override "$recovery_epoch_override" '
    [.items[] | select(.metadata.name == $name)] | select(length == 1) | .[0] |
    .apiVersion = "apps/v1" | .kind = "Deployment" |
    .metadata.namespace = "hcce" | .metadata.resourceVersion = $rv |
    .metadata.generation = $generation |
    if $recovery_phase_override then
      .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] = $recovery_phase
    else . end |
    .spec.replicas = $replicas | .spec.strategy = (.spec.strategy // {}) |
    .spec.template.metadata = ((.spec.template.metadata // {}) + {labels:{app:$name}}) |
    if $recovery_epoch_override then
      .spec.template.metadata.annotations["yenhubs.org/bot-runner-recovery-epoch"] =
        $recovery_epoch
    else . end |
    .status = {observedGeneration:$generation,replicas:$replicas,readyReplicas:$replicas,
      availableReplicas:$replicas,updatedReplicas:$replicas,unavailableReplicas:0}
  ' "$STUB_DEPLOYMENTS_JSON")" || return 1
  receipt_file="$STUB_STATE_DIR/checkpoint-resume-receipt-$deployment"
  if [[ -f "$receipt_file" ]]; then
    deployment_json="$(jq -c --arg receipt "$(cat "$receipt_file")" '
      .metadata.annotations["yenhubs.org/checkpoint-resume-operation"] = $receipt
    ' <<<"$deployment_json")" || return 1
  fi
  printf '%s' "$deployment_json"
}
checkpoint_receipt_all_held_watches_live() {
  [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-h-live-deployments" &&
     -d "$STUB_STATE_DIR/checkpoint-receipt-phase-h-live-replicasets" &&
     -d "$STUB_STATE_DIR/checkpoint-receipt-phase-h-live-pods" ]]
}
checkpoint_receipt_watch_handoff() {
  local resource="$1" raw_path="$2" watch_count target_count
  local final_path="" receipt_mode=false
  checkpoint_receipt_observe_handoff_marker

  case "${STUB_MODE:-}" in
    legacy-receipt-w1-replicaset)
      if [[ "$resource" == replicasets &&
            -d "$STUB_STATE_DIR/checkpoint-receipt-phase-arm" &&
            ! -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]]; then
        watch_count="$(atomic_stub_counter checkpoint-receipt-race-rs-watch)"
        if [[ "$watch_count" == 2 ]]; then
          checkpoint_receipt_record_once rs-w1-closed 'RS_W1_CLOSE' || :
          jq -cn '{type:"BOOKMARK",object:{metadata:{resourceVersion:
            "receipt-race-rs-w1-rv"}}}'
          exit 0
        elif [[ "$watch_count" -ge 3 &&
                ! -d "$STUB_STATE_DIR/checkpoint-receipt-phase-rs-replay" ]]; then
          for _ in {1..500}; do
            [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-rs-list-boundary" ]] && break
            sleep 0.01
          done
          [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-rs-list-boundary" ]] || exit 91
          checkpoint_receipt_record_once rs-replay 'RS_SUCCESSOR_REPLAY' || :
          emit_checkpoint_writer_replicasets | jq -c '
            .items[] | select(.metadata.name == "reticulum-rs") |
            .spec.replicas = 1 |
            .metadata.resourceVersion = "receipt-race-rs-transient-rv" |
            {type:"MODIFIED",object:.}
          '
          exit 0
        fi
      fi
      ;;
    legacy-receipt-w1-pod)
      if [[ "$resource" == pods &&
            -d "$STUB_STATE_DIR/checkpoint-receipt-phase-arm" &&
            ! -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]]; then
        watch_count="$(atomic_stub_counter checkpoint-receipt-race-pod-watch)"
        if [[ "$watch_count" == 2 ]]; then
          checkpoint_receipt_record_once pod-w1-closed 'POD_W1_CLOSE' || :
          jq -cn '{type:"BOOKMARK",object:{metadata:{resourceVersion:
            "receipt-race-pod-w1-rv"}}}'
          exit 0
        elif [[ "$watch_count" -ge 3 &&
                ! -d "$STUB_STATE_DIR/checkpoint-receipt-phase-pod-replay" ]]; then
          for _ in {1..500}; do
            [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-pod-list-boundary" ]] && break
            sleep 0.01
          done
          [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-pod-list-boundary" ]] || exit 91
          checkpoint_receipt_record_once pod-replay 'POD_SUCCESSOR_REPLAY' || :
          jq -cn '{type:"ADDED",object:{apiVersion:"v1",kind:"Pod",metadata:{
            name:"reticulum-receipt-transient",namespace:"hcce",
            uid:"reticulum-receipt-transient-uid",
            resourceVersion:"receipt-race-pod-transient-rv",
            labels:{app:"reticulum"}},spec:{containers:[]}}}'
          exit 0
        fi
      fi
      ;;
  esac

  if [[ "$resource" == deployments &&
        -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] &&
     mkdir "$STUB_STATE_DIR/checkpoint-receipt-event-owner" 2>/dev/null; then
    checkpoint_receipt_trace 'RECEIPT_EVENT'
    emit_stub_deployment_json reticulum | jq -c \
      '. as $deployment |
       {type:"MODIFIED",object:$deployment},
       {type:"BOOKMARK",object:{metadata:{
         resourceVersion:$deployment.metadata.resourceVersion}}}'
    exit 0
  fi

  if [[ "${STUB_MODE:-}" == legacy-receipt-status-only &&
        "$resource" == deployments &&
        -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" &&
        ! -d "$STUB_STATE_DIR/checkpoint-receipt-phase-status-event" ]] &&
     mkdir "$STUB_STATE_DIR/checkpoint-receipt-status-watch-owner" \
       2>/dev/null; then
    jq -cn '{type:"BOOKMARK",object:{metadata:{
      resourceVersion:"receipt-status-wait-rv"}}}'
    for _ in {1..500}; do
      [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-status-final-get" ]] && break
      sleep 0.01
    done
    [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-status-final-get" ]] || exit 91
    printf '%s' 4 >"$STUB_STATE_DIR/rv-reticulum"
    checkpoint_receipt_record_once status-event 'STATUS_ONLY_EVENT' || :
    emit_stub_deployment_json reticulum | jq -c '
      .status.observedGeneration = .metadata.generation |
      {type:"MODIFIED",object:.}
    '
    exit 0
  fi

  if [[ -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" &&
        "$raw_path" == *"timeoutSeconds=65"* ]]; then
    checkpoint_receipt_record_once "h-live-$resource" "H_LIVE_$resource" || :
    if checkpoint_receipt_all_held_watches_live; then
      checkpoint_receipt_record_once h-live-all 'H_LIVE_ALL' || :
    fi
    trap '
      final_path="$(checkpoint_receipt_monitor_path final 2>/dev/null || :)"
      if [[ -n "$final_path" ]] && jq -e '\''
          .handoff == "receipt-ack"'\'' "$final_path" >/dev/null 2>&1; then
        checkpoint_receipt_record_once ack "ACK" || :
        checkpoint_receipt_record_once "h-term-after-ack-$resource" \
          "H_TERM_AFTER_ACK_$resource" || :
      else
        checkpoint_receipt_record_once "h-term-before-ack-$resource" \
          "H_TERM_BEFORE_ACK_$resource" || :
      fi
      exit 0
    ' TERM INT
    while sleep 1; do :; done
  fi

  case "${STUB_MODE:-}" in
    legacy-receipt-happy|legacy-receipt-r-error-410|legacy-receipt-r-clean-close|\
      legacy-receipt-r-exit-91|legacy-receipt-shell-happy|\
      legacy-receipt-publish-lost|legacy-receipt-scale-lost|\
      legacy-receipt-clear-lost|legacy-receipt-signal-before|\
      legacy-receipt-signal-after)
      receipt_mode=true
      ;;
  esac
  if [[ "$receipt_mode" == true &&
        "$raw_path" == *"timeoutSeconds=2"* &&
        "$raw_path" == *"resourceVersion=receipt-final-$resource-list-rv"* ]]; then
    checkpoint_receipt_record_once "pre-r-active-$resource" \
      "PRE_R_ACTIVE_$resource" || :
    for _ in {1..500}; do
      checkpoint_receipt_all_held_watches_live && break
      sleep 0.01
    done
    checkpoint_receipt_all_held_watches_live || exit 91
    sleep 0.15
    checkpoint_receipt_record_once "pre-r-close-$resource" \
      "PRE_R_CLOSE_$resource" || :
    jq -cn --arg rv "receipt-prebarrier-$resource-rv" \
      '{type:"BOOKMARK",object:{metadata:{resourceVersion:$rv}}}'
    exit 0
  fi
  if [[ "$receipt_mode" == true &&
        "$raw_path" == *"timeoutSeconds=2"* &&
        "$raw_path" == *"resourceVersion=receipt-prebarrier-$resource-rv"* ]]; then
    checkpoint_receipt_record_once "r-start-$resource" "R_START_$resource" || :
    if [[ "$resource" == deployments ]]; then
      case "${STUB_MODE:-}" in
        legacy-receipt-r-error-410)
          checkpoint_receipt_record_once r-error-410 'R_ERROR_410' || :
          jq -cn '{type:"ERROR",object:{apiVersion:"v1",kind:"Status",
            code:410,reason:"Expired",metadata:{resourceVersion:"receipt-r-410"}}}'
          exit 0
          ;;
        legacy-receipt-r-clean-close)
          checkpoint_receipt_record_once r-clean-close 'R_CLEAN_CLOSE' || :
          exit 0
          ;;
        legacy-receipt-r-exit-91)
          checkpoint_receipt_record_once r-exit-91 'R_EXIT_91' || :
          exit 91
          ;;
      esac
    fi
    checkpoint_receipt_record_once "r-natural-$resource" "R_NATURAL_$resource" || :
    jq -cn --arg rv "receipt-r-natural-$resource-rv" \
      '{type:"BOOKMARK",object:{metadata:{resourceVersion:$rv}}}'
    exit 0
  fi
  return 1
}
if [[ "$joined" == "config current-context" ]]; then printf '%s' "${STUB_CURRENT_CONTEXT:-fixture-context}"; exit 0; fi
if [[ "$joined" == "get lease yenhubs-operation-serialization -n hcce --ignore-not-found -o json" ]]; then
  [[ ! -f "$STUB_STATE_DIR/serialization-lease.json" ]] ||
    cat "$STUB_STATE_DIR/serialization-lease.json"
  exit 0
fi
if [[ "$joined" == "get lease yenhubs-operation-serialization -n hcce -o json" ]]; then
  [[ -f "$STUB_STATE_DIR/serialization-lease.json" ]] || exit 1
  if [[ "${STUB_MODE:-}" == checkpoint-writer-list-item-gvk-omitted ||
        "${STUB_MODE:-}" == checkpoint-writer-deployment-gvk-spoof ||
        "${STUB_MODE:-}" == checkpoint-writer-replicaset-gvk-spoof ||
        "${STUB_MODE:-}" == checkpoint-writer-pod-gvk-spoof ||
        "${STUB_MODE:-}" == checkpoint-writer-live-pod-defaults ||
        "${STUB_MODE:-}" == checkpoint-writer-template-pull-secret ||
        "${STUB_MODE:-}" == checkpoint-writer-list-key-order ||
        "${STUB_MODE:-}" == checkpoint-writer-live-pod-explicit-false ||
        "${STUB_MODE:-}" == checkpoint-writer-live-pod-secret-mismatch ||
        "${STUB_MODE:-}" == checkpoint-writer-live-pod-secret-watch-drift ]]; then
    lease_refresh_path="$(
      mktemp "$STUB_STATE_DIR/serialization-lease.next.XXXXXX"
    )" || exit 1
    jq -c --arg renew "$(date -u '+%Y-%m-%dT%H:%M:%S.000000Z')" \
      '.spec.renewTime = $renew' "$STUB_STATE_DIR/serialization-lease.json" \
      >"$lease_refresh_path"
    mv "$lease_refresh_path" \
      "$STUB_STATE_DIR/serialization-lease.json"
  fi
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
  if [[ "${STUB_MODE:-}" == lease-holder-lost ]]; then
    jq '.spec.holderIdentity = "cloud-apply:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" |
      .metadata.resourceVersion = "lease-rv-lost"' \
      "$STUB_STATE_DIR/serialization-lease.json" \
      >"$STUB_STATE_DIR/serialization-lease.next"
    mv "$STUB_STATE_DIR/serialization-lease.next" \
      "$STUB_STATE_DIR/serialization-lease.json"
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-lease-uid-drift ]]; then
    jq '.metadata.uid = "replacement-serialization-lease-uid"' \
      "$STUB_STATE_DIR/serialization-lease.json"
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-lease-transitions-drift &&
        "$(atomic_stub_counter checkpoint-writer-lease-read-count)" -ge 2 ]]; then
    jq '.metadata.resourceVersion = "lease-rv-robbed-and-returned" |
      .spec.leaseTransitions += 2' \
      "$STUB_STATE_DIR/serialization-lease.json"
    exit 0
  fi
  cat "$STUB_STATE_DIR/serialization-lease.json"
  exit 0
fi
if [[ "$joined" == "get role bot-orchestrator-runner-pods -n hcce-bot-runners -o json" ]]; then
  role_uid=runner-role-uid
  role_rv_number=1
  role_phase=active
  role_rules='[{"apiGroups":[""],"resources":["pods"],"verbs":["create","delete","get","list","patch"]}]'
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
if [[ "$joined" == "get namespace kube-system -o json" ]]; then
  cat "$RUNNER_EVIDENCE_LIVE_DIR/namespace-kube-system.json"
  exit 0
fi
if [[ "$joined" == "get namespace hcce -o json" ]]; then
  if [[ "$request_timeout" == "--request-timeout=3s" ]]; then
    : >"$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-queried"
    if [[ "${STUB_MODE:-}" == checkpoint-writer-terminal-control-gap &&
          -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w2-deployments-started" &&
          ! -e "$STUB_STATE_DIR/checkpoint-writer-terminal-control-delay" ]]; then
      : >"$STUB_STATE_DIR/checkpoint-writer-terminal-control-delay"
      for _ in {1..300}; do
        [[ ! -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-stopped" ]] || break
        sleep 0.01
      done
      [[ -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-stopped" ]] || exit 91
      sleep 0.6
    fi
    fence_count_file="$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-count-${STUB_MODE:-default}"
    fence_count=0
    [[ ! -f "$fence_count_file" ]] || fence_count="$(cat "$fence_count_file")"
    fence_count=$((fence_count + 1))
    printf '%s' "$fence_count" >"$fence_count_file"
    case "${STUB_MODE:-}" in
      checkpoint-writer-fence-parent-namespace-missing) exit 1 ;;
      checkpoint-writer-fence-parent-namespace-timeout) exec sleep 12 ;;
      checkpoint-writer-fence-global-deadline)
        sleep 2
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json"
        ;;
      checkpoint-writer-fence-parent-namespace-terminating)
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json" |
          jq '.metadata.deletionTimestamp = "2026-07-21T00:00:00Z"'
        ;;
      checkpoint-writer-fence-parent-namespace-inactive)
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json" |
          jq '.status.phase = "Terminating"'
        ;;
      checkpoint-writer-fence-parent-namespace-label-drift)
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json" |
          jq '.metadata.labels["kubernetes.io/metadata.name"] = "wrong"'
        ;;
      checkpoint-writer-fence-parent-namespace-replaced-after-ready)
        if ((fence_count >= 5)); then
          emit_recovery_fence_namespace_fixture \
            "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json" |
            jq '.metadata.uid = "replacement-parent-namespace-uid" |
              .metadata.resourceVersion = "namespace-rv-hcce-2"'
        else
          emit_recovery_fence_namespace_fixture \
            "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json"
        fi
        ;;
      checkpoint-writer-fence-parent-namespace-rv-drift-after-ready)
        if ((fence_count >= 5)); then
          emit_recovery_fence_namespace_fixture \
            "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json" |
            jq '.metadata.resourceVersion = "namespace-rv-hcce-2"'
        else
          emit_recovery_fence_namespace_fixture \
            "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json"
        fi
        ;;
      *)
        emit_recovery_fence_namespace_fixture \
          "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json"
        ;;
    esac
  else
    cat "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json"
  fi
  exit 0
fi
if [[ "$joined" == "get namespace hcce-bot-runners --ignore-not-found -o json" ]]; then
  if [[ "${STUB_RUNNER_NAMESPACE:-absent}" == present ]]; then
    cat "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json"
  fi
  exit 0
fi
if [[ "$joined" == "get deployments -n hcce -o json" ]]; then
  checkpoint_receipt_observe_handoff_marker
  if [[ "${STUB_MODE:-}" == legacy-receipt-status-only &&
        -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" &&
        ! -d "$STUB_STATE_DIR/checkpoint-receipt-phase-status-final-get" ]]; then
    checkpoint_receipt_record_once status-final-get 'STATUS_FINAL_GET_BEGIN' || :
    for _ in {1..500}; do
      [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-status-event" ]] && break
      sleep 0.01
    done
    [[ -d "$STUB_STATE_DIR/checkpoint-receipt-phase-status-event" ]] || exit 91
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-final-publication-excursion &&
        -n "${STUB_CHECKPOINT_OUTPUT_PATH:-}" &&
        -f "$STUB_CHECKPOINT_OUTPUT_PATH/.yenhubs-incomplete" &&
        -f "$STUB_CHECKPOINT_OUTPUT_PATH/SHA256SUMS" ]]; then
    : >"$STUB_STATE_DIR/checkpoint-writer-final-boundary-read"
  fi
  if [[ -d "$STUB_STATE_DIR/writer-watch-deployments.1" ]]; then
    case "${STUB_MODE:-}" in
      checkpoint-writer-terminal-list-gap)
        for _ in {1..300}; do
          [[ ! -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-closed" ]] || break
          sleep 0.01
        done
        [[ -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-closed" ]] || exit 91
        # Model an unobserved 0 -> 1 -> 0 excursion. The terminal LIST sees
        # only the safe final state and its newer RV, exactly the old gap.
        printf '%s' 99 >"$STUB_STATE_DIR/rv-reticulum"
        : >"$STUB_STATE_DIR/checkpoint-writer-terminal-list-gap-excursion"
        ;;
      checkpoint-writer-terminal-control-gap)
        for _ in {1..300}; do
          [[ ! -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-started" ]] || break
          sleep 0.01
        done
        [[ -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-started" ]] || exit 91
        sleep 0.2
        ;;
    esac
  fi
  if [[ "${STUB_MODE:-}" == preflight-final-image-drift &&
        "$(atomic_stub_counter preflight-deployment-list-count)" -ge 2 ]]; then
    emit_checkpoint_writer_deployments |
      jq -c '
        (.items[] | select(.metadata.name == "reticulum") |
          .spec.template.spec.containers[] | select(.name == "reticulum") |
          .image) = ("ghcr.io/yengalvez/reticulum@sha256:" + ("9" * 64))
      '
  else
    emit_checkpoint_writer_deployments
  fi
  exit 0
fi
if [[ "$joined" == "get replicasets -n hcce -o json" ]]; then
  emit_checkpoint_writer_replicasets
  exit 0
fi
if [[ "$joined" == get\ pod\ *\ -n\ *\ --ignore-not-found\ -o\ json ||
      "$joined" == get\ networkpolicy\ *\ -n\ hcce\ --ignore-not-found\ -o\ json ||
      "$joined" == get\ configmap\ yenhubs-recovery-operation-lock\ -n\ hcce\ --ignore-not-found\ -o\ json ]]; then
  [[ "${STUB_MODE:-}" != delete-poll-get-error ]] || exit 1
  # These reads are the post-DELETE existence poll. The raw DELETE branches
  # below remove the exact fixture identity before this poll; kubectl's
  # --ignore-not-found contract is status 0 with byte-empty stdout.
  exit 0
fi
if [[ "$joined" == "get secret bot-images-pull -n hcce --ignore-not-found -o json" ]]; then
  if [[ "${STUB_HCCE_PULL_SECRET:-absent}" == present ]]; then
    printf '%s' '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"bot-images-pull","namespace":"hcce","uid":"fixture-pull-uid","resourceVersion":"fixture-pull-rv"}}'
  fi
  exit 0
fi
emit_runner_residual() {
  local id="$1" alias="$2" api_version="$3" kind="$4" name="$5" namespace="${6:-}"
  local live_file="${7:-}"
  if [[ "${STUB_RUNNER_RESIDUAL:-}" == "$id" ||
        ( -n "$alias" && "${STUB_RUNNER_RESIDUAL:-}" == "$alias" ) ]]; then
    jq -cn --arg api_version "$api_version" --arg kind "$kind" \
      --arg name "$name" --arg namespace "$namespace" '
      {apiVersion:$api_version,kind:$kind,metadata:({name:$name,uid:("residual-"+$name+"-uid")} +
        if $namespace == "" then {} else {namespace:$namespace} end)}
    '
  elif [[ "${STUB_RUNNER_NAMESPACE:-absent}" == present && -n "$live_file" ]]; then
    if [[ "$live_file" == runner-role.json &&
          ( -f "$STUB_STATE_DIR/runner-role-uid" ||
            -f "$STUB_STATE_DIR/runner-role-rv" ||
            -f "$STUB_STATE_DIR/runner-role-phase" ||
            -f "$STUB_STATE_DIR/runner-role-rules.json" ) ]]; then
      role_uid="$(cat "$STUB_STATE_DIR/runner-role-uid" 2>/dev/null || \
        jq -r '.metadata.uid' "$RUNNER_EVIDENCE_LIVE_DIR/$live_file")"
      role_rv_number="$(cat "$STUB_STATE_DIR/runner-role-rv" 2>/dev/null || printf 1)"
      role_phase="$(cat "$STUB_STATE_DIR/runner-role-phase" 2>/dev/null || \
        jq -r '.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"]' \
          "$RUNNER_EVIDENCE_LIVE_DIR/$live_file")"
      role_rules="$(cat "$STUB_STATE_DIR/runner-role-rules.json" 2>/dev/null || \
        jq -c '.rules' "$RUNNER_EVIDENCE_LIVE_DIR/$live_file")"
      jq -c --arg uid "$role_uid" --arg rv "runner-role-rv-$role_rv_number" \
        --arg phase "$role_phase" --argjson rules "$role_rules" '
        .metadata.uid = $uid |
        .metadata.resourceVersion = $rv |
        .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] = $phase |
        .rules = $rules
      ' "$RUNNER_EVIDENCE_LIVE_DIR/$live_file"
    else
      cat "$RUNNER_EVIDENCE_LIVE_DIR/$live_file"
    fi
  fi
}
case "$joined" in
  "get serviceaccount bot-orchestrator -n hcce --ignore-not-found -o json")
    emit_runner_residual parent-serviceaccount serviceaccount v1 ServiceAccount bot-orchestrator hcce \
      parent-service-account.json; exit 0 ;;
  "get role bot-orchestrator-runner-pods -n hcce --ignore-not-found -o json")
    emit_runner_residual parent-role role rbac.authorization.k8s.io/v1 Role bot-orchestrator-runner-pods hcce \
      parent-role.json; exit 0 ;;
  "get rolebinding bot-orchestrator-runner-pods -n hcce --ignore-not-found -o json")
    emit_runner_residual parent-rolebinding rolebinding rbac.authorization.k8s.io/v1 RoleBinding bot-orchestrator-runner-pods hcce \
      parent-role-binding.json; exit 0 ;;
  "get configmap yenhubs-runner-cutover-v2 -n hcce --ignore-not-found -o json")
    emit_runner_residual cutover-journal '' v1 ConfigMap yenhubs-runner-cutover-v2 hcce \
      cutover-journal.json; exit 0 ;;
  "get secret bot-images-pull -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual runner-pull-secret '' v1 Secret bot-images-pull hcce-bot-runners \
      runner-pull-secret.json; exit 0 ;;
  "get serviceaccount bot-runner -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual runner-serviceaccount '' v1 ServiceAccount bot-runner hcce-bot-runners \
      runner-service-account.json; exit 0 ;;
  "get serviceaccount bot-runner-guard -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual guard-serviceaccount '' v1 ServiceAccount bot-runner-guard hcce-bot-runners \
      guard-service-account.json; exit 0 ;;
  "get resourcequota bot-runner-capacity -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual runner-quota '' v1 ResourceQuota bot-runner-capacity hcce-bot-runners \
      runner-quota.json; exit 0 ;;
  "get resourcequota bot-runner-guard-capacity -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual guard-quota '' v1 ResourceQuota bot-runner-guard-capacity hcce-bot-runners \
      guard-quota.json; exit 0 ;;
  "get role bot-orchestrator-runner-pods -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual runner-role '' rbac.authorization.k8s.io/v1 Role bot-orchestrator-runner-pods hcce-bot-runners \
      runner-role.json; exit 0 ;;
  "get rolebinding bot-orchestrator-runner-pods -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual runner-rolebinding '' rbac.authorization.k8s.io/v1 RoleBinding bot-orchestrator-runner-pods hcce-bot-runners \
      runner-role-binding.json; exit 0 ;;
  "get networkpolicy bot-runner-default-deny -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual runner-network-default-deny '' networking.k8s.io/v1 NetworkPolicy bot-runner-default-deny hcce-bot-runners \
      runner-default-deny.json; exit 0 ;;
  "get networkpolicy bot-runner-egress -n hcce-bot-runners --ignore-not-found -o json")
    emit_runner_residual runner-network-egress '' networking.k8s.io/v1 NetworkPolicy bot-runner-egress hcce-bot-runners \
      runner-egress.json; exit 0 ;;
  "get validatingadmissionpolicy bot-runner-pods.yenhubs.org --ignore-not-found -o json")
    emit_runner_residual policy-pods validatingadmissionpolicy admissionregistration.k8s.io/v1 ValidatingAdmissionPolicy bot-runner-pods.yenhubs.org '' \
      policy-bot-runner-pods.yenhubs.org.json; exit 0 ;;
  "get validatingadmissionpolicybinding bot-runner-pods.yenhubs.org --ignore-not-found -o json")
    emit_runner_residual binding-pods validatingadmissionpolicybinding admissionregistration.k8s.io/v1 ValidatingAdmissionPolicyBinding bot-runner-pods.yenhubs.org '' \
      binding-bot-runner-pods.yenhubs.org.json; exit 0 ;;
  "get validatingadmissionpolicy bot-runner-durable-protocol.yenhubs.org --ignore-not-found -o json")
    emit_runner_residual policy-durable '' admissionregistration.k8s.io/v1 ValidatingAdmissionPolicy bot-runner-durable-protocol.yenhubs.org '' \
      policy-bot-runner-durable-protocol.yenhubs.org.json; exit 0 ;;
  "get validatingadmissionpolicybinding bot-runner-durable-protocol.yenhubs.org --ignore-not-found -o json")
    emit_runner_residual binding-durable '' admissionregistration.k8s.io/v1 ValidatingAdmissionPolicyBinding bot-runner-durable-protocol.yenhubs.org '' \
      binding-bot-runner-durable-protocol.yenhubs.org.json; exit 0 ;;
  "get validatingadmissionpolicy yenhubs-runner-cutover-journal-v2 --ignore-not-found -o json")
    emit_runner_residual policy-journal '' admissionregistration.k8s.io/v1 ValidatingAdmissionPolicy yenhubs-runner-cutover-journal-v2 '' \
      policy-yenhubs-runner-cutover-journal-v2.json; exit 0 ;;
  "get validatingadmissionpolicybinding yenhubs-runner-cutover-journal-v2 --ignore-not-found -o json")
    emit_runner_residual binding-journal '' admissionregistration.k8s.io/v1 ValidatingAdmissionPolicyBinding yenhubs-runner-cutover-journal-v2 '' \
      binding-yenhubs-runner-cutover-journal-v2.json; exit 0 ;;
  "get validatingadmissionpolicy bot-orchestrator-fence-protocol.yenhubs.org --ignore-not-found -o json")
    emit_runner_residual policy-parent '' admissionregistration.k8s.io/v1 ValidatingAdmissionPolicy bot-orchestrator-fence-protocol.yenhubs.org '' \
      policy-bot-orchestrator-fence-protocol.yenhubs.org.json; exit 0 ;;
  "get validatingadmissionpolicybinding bot-orchestrator-fence-protocol.yenhubs.org --ignore-not-found -o json")
    emit_runner_residual binding-parent '' admissionregistration.k8s.io/v1 ValidatingAdmissionPolicyBinding bot-orchestrator-fence-protocol.yenhubs.org '' \
      binding-bot-orchestrator-fence-protocol.yenhubs.org.json; exit 0 ;;
  "get validatingadmissionpolicy recovery-operation-pod-fence.yenhubs.org --ignore-not-found -o json")
    if [[ "${STUB_RUNNER_NAMESPACE:-absent}" == present ||
          ( -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" &&
            -f "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" ) ]]; then
      cat "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
    else
      emit_runner_residual recovery-operation-fence-policy '' \
        admissionregistration.k8s.io/v1 ValidatingAdmissionPolicy \
        recovery-operation-pod-fence.yenhubs.org '' \
        policy-recovery-operation-pod-fence.yenhubs.org.json
    fi
    exit 0 ;;
  "get validatingadmissionpolicybinding recovery-operation-pod-fence.yenhubs.org --ignore-not-found -o json")
    if [[ -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" &&
          -f "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" ]]; then
      fence_state="$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")"
      fence_rv="$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")"
      case "$fence_state" in
        dormant)
          jq --arg rv "$fence_rv" '
            .metadata.resourceVersion = $rv |
            .spec.matchResources.namespaceSelector.matchExpressions = [{
              key:"kubernetes.io/metadata.name",operator:"DoesNotExist"}]
          ' "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
          ;;
        active)
          jq --arg rv "$fence_rv" '.metadata.resourceVersion = $rv' \
            "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
          ;;
        *) exit 1 ;;
      esac
    elif [[ "${STUB_RUNNER_NAMESPACE:-absent}" == present ]]; then
      cat "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
    else
      emit_runner_residual recovery-operation-fence-binding '' \
        admissionregistration.k8s.io/v1 ValidatingAdmissionPolicyBinding \
        recovery-operation-pod-fence.yenhubs.org '' \
        binding-recovery-operation-pod-fence.yenhubs.org.json
    fi
    exit 0 ;;
esac
if [[ "$joined" == get\ namespace\ *\ -o\ jsonpath=* &&
      "$joined" == *'.apiVersion'* ]]; then
  name="${3:-}"
  case "$name" in
    hcce) uid=fixture-uid ;;
    hcce-bot-runners) uid=fixture-runner-namespace-uid ;;
    *) exit 1 ;;
  esac
  [[ "${STUB_RUNNER_RESOURCE_DRIFT:-}" != namespace &&
     "${STUB_RUNNER_RESOURCE_DRIFT:-}" != "$name" ]] || uid="drifted-$uid"
  if [[ "$joined" == *'.metadata.resourceVersion'* ]]; then
    printf 'v1\tNamespace\t%s\t%s\tnamespace-rv-%s' "$name" "$uid" "$name"
  else
    printf 'v1\tNamespace\t%s\t%s' "$name" "$uid"
  fi
  exit 0
fi
if [[ "$joined" == get\ *\ *\ -n\ *\ -o\ jsonpath=* &&
      "$joined" == *'.apiVersion'* ]]; then
  resource="${2:-}"; name="${3:-}"; resource_namespace="${5:-}"
  api_version=""; kind=""; live_file=""
  case "$resource/$name" in
    serviceaccount/bot-orchestrator) api_version=v1; kind=ServiceAccount ;;
    secret/bot-images-pull) api_version=v1; kind=Secret ;;
    serviceaccount/bot-runner|serviceaccount/bot-runner-guard)
      api_version=v1; kind=ServiceAccount ;;
    resourcequota/bot-runner-capacity|resourcequota/bot-runner-guard-capacity)
      api_version=v1; kind=ResourceQuota ;;
    role/bot-orchestrator-runner-pods) api_version=rbac.authorization.k8s.io/v1; kind=Role ;;
    rolebinding/bot-orchestrator-runner-pods) api_version=rbac.authorization.k8s.io/v1; kind=RoleBinding ;;
    configmap/yenhubs-runner-cutover-v2) api_version=v1; kind=ConfigMap ;;
    networkpolicy/bot-runner-default-deny|networkpolicy/bot-runner-egress)
      api_version=networking.k8s.io/v1; kind=NetworkPolicy ;;
    *) exit 1 ;;
  esac
  if [[ "${STUB_RUNNER_NAMESPACE:-absent}" == present ]]; then
    case "$resource_namespace/$resource/$name" in
      hcce/serviceaccount/bot-orchestrator)
        live_file=parent-service-account.json ;;
      hcce/role/bot-orchestrator-runner-pods)
        live_file=parent-role.json ;;
      hcce/rolebinding/bot-orchestrator-runner-pods)
        live_file=parent-role-binding.json ;;
      hcce/configmap/yenhubs-runner-cutover-v2)
        live_file=cutover-journal.json ;;
      hcce-bot-runners/role/bot-orchestrator-runner-pods)
        live_file=runner-role.json ;;
      hcce-bot-runners/rolebinding/bot-orchestrator-runner-pods)
        live_file=runner-role-binding.json ;;
      hcce-bot-runners/secret/bot-images-pull)
        live_file=runner-pull-secret.json ;;
      hcce-bot-runners/serviceaccount/bot-runner)
        live_file=runner-service-account.json ;;
      hcce-bot-runners/serviceaccount/bot-runner-guard)
        live_file=guard-service-account.json ;;
      hcce-bot-runners/resourcequota/bot-runner-capacity)
        live_file=runner-quota.json ;;
      hcce-bot-runners/resourcequota/bot-runner-guard-capacity)
        live_file=guard-quota.json ;;
      hcce-bot-runners/networkpolicy/bot-runner-default-deny)
        live_file=runner-default-deny.json ;;
      hcce-bot-runners/networkpolicy/bot-runner-egress)
        live_file=runner-egress.json ;;
    esac
  fi
  if [[ -n "$live_file" ]]; then
    uid="$(jq -er '.metadata.uid' "$RUNNER_EVIDENCE_LIVE_DIR/$live_file")"
    resource_version="$(jq -er '.metadata.resourceVersion' \
      "$RUNNER_EVIDENCE_LIVE_DIR/$live_file")"
  else
    uid="uid-$name"
    resource_version="rv-$resource_namespace-$name"
  fi
  [[ "${STUB_RUNNER_RESOURCE_DRIFT:-}" != "$name" ]] || uid="drifted-$uid"
  if [[ "$joined" == *'.metadata.resourceVersion'* ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s' \
      "$api_version" "$kind" "$resource_namespace" "$name" "$uid" \
      "$resource_version"
  else
    printf '%s\t%s\t%s\t%s\t%s' \
      "$api_version" "$kind" "$resource_namespace" "$name" "$uid"
  fi
  exit 0
fi
if [[ "$joined" == get\ validatingadmissionpolicy*\ *\ -o\ jsonpath=* &&
      "$joined" == *'.apiVersion'* ]]; then
  resource="${2:-}"
  name="${3:-}"
  case "$name" in
    bot-runner-pods.yenhubs.org|bot-runner-durable-protocol.yenhubs.org|\
    yenhubs-runner-cutover-journal-v2|bot-orchestrator-fence-protocol.yenhubs.org|\
    recovery-operation-pod-fence.yenhubs.org) ;;
    *) exit 1 ;;
  esac
  if [[ "$resource" == validatingadmissionpolicy ]]; then
    kind=ValidatingAdmissionPolicy
  elif [[ "$resource" == validatingadmissionpolicybinding ]]; then
    kind=ValidatingAdmissionPolicyBinding
  else
    exit 1
  fi
  if [[ "${STUB_RUNNER_NAMESPACE:-absent}" == present ]]; then
    if [[ "$resource" == validatingadmissionpolicy ]]; then
      live_file="policy-$name.json"
    else
      live_file="binding-$name.json"
    fi
    uid="$(jq -er '.metadata.uid' "$RUNNER_EVIDENCE_LIVE_DIR/$live_file")"
    resource_version="$(jq -er '.metadata.resourceVersion' \
      "$RUNNER_EVIDENCE_LIVE_DIR/$live_file")"
  else
    uid="uid-$resource-$name"
    resource_version="rv-$resource-$name"
  fi
  [[ "${STUB_RUNNER_RESOURCE_DRIFT:-}" != "$resource" &&
     "${STUB_RUNNER_RESOURCE_DRIFT:-}" != "$name" ]] || uid="drifted-$uid"
  if [[ "$joined" == *'.metadata.resourceVersion'* ]]; then
    printf 'admissionregistration.k8s.io/v1\t%s\t%s\t%s\t%s' \
      "$kind" "$name" "$uid" "$resource_version"
  else
    printf 'admissionregistration.k8s.io/v1\t%s\t%s\t%s' \
      "$kind" "$name" "$uid"
  fi
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
  if [[ "${STUB_MODE:-}" == checkpoint-writer-post-join-transient &&
        -e "$STUB_STATE_DIR/checkpoint-writer-terminal-watch-seen" ]]; then
    post_join_lock_read="$(atomic_stub_counter \
      checkpoint-writer-post-join-lock-read)"
    # Reads 1-3 are Node's control-plane checks through writing FINAL. Read 4
    # is Bash's first lock recheck after the watcher has joined successfully.
    if [[ "$post_join_lock_read" == 4 &&
          ! -e "$STUB_STATE_DIR/checkpoint-writer-post-join-transient" ]]; then
      : >"$STUB_STATE_DIR/checkpoint-writer-post-join-transient"
      exit 1
    fi
  fi
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
  lock_runner_evidence="$(yaml_field 'yenhubs.org/runner-cutover-evidence-sha256:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_runner_generation="$(yaml_field 'yenhubs.org/runner-runtime-generation:' "$STUB_STATE_DIR/restore-lock.yaml")"
  lock_json="$(jq -cn --arg uid "$lock_uid" --arg rv "$lock_rv" --arg owner "$lock_owner" \
    --arg operation_id "$lock_operation_id" --arg token "$lock_token" \
    --arg namespace_uid "$lock_namespace_uid" --arg pvc_uid "$lock_pvc_uid" \
    --arg stamp "$lock_stamp" --arg dump "$lock_dump" --arg storage "$lock_storage" \
    --arg pre_epoch "$lock_pre_epoch" --arg target_epoch "$lock_target_epoch" \
    --arg inventory "$lock_inventory" --arg state "$lock_state" \
    --arg runner_evidence "$lock_runner_evidence" \
    --arg runner_generation "$lock_runner_generation" \
    '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"yenhubs-recovery-operation-lock",namespace:"hcce",uid:$uid,resourceVersion:$rv,labels:{"yenhubs.org/recovery-owner":$owner},annotations:({"yenhubs.org/operation-id":$operation_id,"yenhubs.org/recovery-token":$token,"yenhubs.org/namespace-uid":$namespace_uid,"yenhubs.org/pvc-uid":$pvc_uid,"yenhubs.org/checkpoint-stamp":$stamp,"yenhubs.org/dump-sha256":$dump,"yenhubs.org/storage-sha256":$storage} + if $inventory == "" then {} else {"yenhubs.org/deployment-inventory-sha256":$inventory} end + if $pre_epoch == "" then {} else {"yenhubs.org/pre-fence-epoch":$pre_epoch,"yenhubs.org/restore-fence-epoch":$target_epoch} end + if $state == "" then {} else {"yenhubs.org/recovery-state":$state} end + if $runner_evidence == "" and $runner_generation == "" then {} else {"yenhubs.org/runner-cutover-evidence-sha256":$runner_evidence,"yenhubs.org/runner-runtime-generation":$runner_generation} end)},immutable:true}')" || exit 1
  case "${STUB_MODE:-}" in
    restore-lock-deletion-timestamp)
      lock_json="$(jq -c '.metadata.deletionTimestamp = "2026-07-20T00:00:00Z"' \
        <<<"$lock_json")" || exit 1
      ;;
    restore-lock-deletion-grace)
      lock_json="$(jq -c '.metadata.deletionGracePeriodSeconds = 30' \
        <<<"$lock_json")" || exit 1
      ;;
    restore-lock-finalizer)
      lock_json="$(jq -c '.metadata.finalizers = ["fixture.invalid/retain"]' \
        <<<"$lock_json")" || exit 1
      ;;
    restore-lock-owner-reference)
      lock_json="$(jq -c '.metadata.ownerReferences = [{apiVersion:"v1",kind:"Secret",name:"foreign-owner",uid:"foreign-owner-uid"}]' \
        <<<"$lock_json")" || exit 1
      ;;
    checkpoint-writer-lock-rv-drift)
      lock_json="$(jq -c '.metadata.resourceVersion = "replacement-lock-rv"' \
        <<<"$lock_json")" || exit 1
      ;;
  esac
  printf '%s' "$lock_json"
  exit 0
fi
if [[ "$joined" == get\ pod\ reticulum-0*metadata.uid* ]]; then
  if [[ "${STUB_MODE:-}" == preflight-final-reticulum-uid-drift ||
        "${STUB_MODE:-}" == preflight-ttl-final ]]; then
    reticulum_uid_count="$(atomic_stub_counter preflight-reticulum-uid-count)"
    if [[ "$reticulum_uid_count" -ge 2 ]]; then
      if [[ "${STUB_MODE:-}" == preflight-final-reticulum-uid-drift ]]; then
        printf 'replacement-reticulum-pod-uid'
        exit 0
      fi
      printf '%s\n' complete >"$STUB_STATE_DIR/preflight-final-revalidation-complete"
    fi
  fi
  printf 'reticulum-pod-uid'
  exit 0
fi
if [[ "$joined" == get\ pod\ pgsql-0*metadata.uid* ]]; then printf 'pgsql-pod-uid'; exit 0; fi
if [[ "$joined" == rollout\ status\ * ]]; then
  if [[ "$joined" == *"deployment/reticulum"* &&
        -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]]; then
    checkpoint_receipt_record_once rollout-reticulum 'ROLLOUT_RETICULUM' || :
  fi
  if [[ "${STUB_MODE:-}" == "rollout-fail" && "$joined" == *"deployment/reticulum"* ]]; then exit 1; fi
  if [[ "${STUB_MODE:-}" == "resume-ret-fail" && "$joined" == *"deployment/reticulum"* &&
        -f "$STUB_STATE_DIR/replicas-reticulum" &&
        "$(cat "$STUB_STATE_DIR/replicas-reticulum")" == "1" ]]; then exit 1; fi
  if [[ ( "${STUB_MODE:-}" == "finalizer-failclose" ||
          "${STUB_MODE:-}" == "finalizer-failclose-drift" ||
          "${STUB_MODE:-}" == "finalizer-role-lost-response" ||
          "${STUB_MODE:-}" == "finalizer-role-cas-replaced" ||
          "${STUB_MODE:-}" == "finalizer-role-cas-drift" ) &&
        "$joined" == *"deployment/reticulum"* &&
        -f "$STUB_STATE_DIR/replicas-reticulum" &&
        "$(cat "$STUB_STATE_DIR/replicas-reticulum")" == "1" &&
        ! -e "$STUB_STATE_DIR/finalizer-failclose-triggered" ]]; then
    : >"$STUB_STATE_DIR/finalizer-failclose-triggered"
    rm -f -- "$STUB_STATE_DIR/restore-lock.yaml" \
      "$STUB_STATE_DIR/restore-lock-uid" "$STUB_STATE_DIR/restore-lock-rv"
    if [[ "${STUB_MODE:-}" == "finalizer-failclose-drift" ]]; then
      printf '%s' replacement-runner-role-uid >"$STUB_STATE_DIR/runner-role-uid"
      printf '%s' active >"$STUB_STATE_DIR/runner-role-phase"
      printf '%s' '[{"apiGroups":[""],"resources":["pods","secrets"],"verbs":["*"]}]' \
        >"$STUB_STATE_DIR/runner-role-rules.json"
    fi
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
  if [[ -e "$STUB_STATE_DIR/db-source-monitor-stream-started" &&
        ! -e "$STUB_STATE_DIR/db-source-monitor-stream-completed" ]]; then
    : >"$STUB_STATE_DIR/db-source-monitor-inflight-observed"
    printf '%s' "$$" >"$STUB_STATE_DIR/db-source-monitor-observer-pid"
    case "${STUB_MODE:-}" in
      db-source-monitor-uid-drift)
        printf '%s' '{"items":[{"metadata":{"name":"pgsql-0","uid":"replacement-pgsql-pod-uid","labels":{"app":"pgsql"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"pgsql-rs","uid":"pgsql-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[]}}]}'
        exit 0
        ;;
      db-source-monitor-replacement)
        printf '%s' '{"items":[{"metadata":{"name":"pgsql-1","uid":"replacement-pgsql-pod-uid","labels":{"app":"pgsql"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"pgsql-rs","uid":"pgsql-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[]}}]}'
        exit 0
        ;;
      db-source-monitor-stall)
        exec sleep 3
        ;;
    esac
  fi
  if [[ "${STUB_MODE:-}" == "rogue-pgsql-owner" ]]; then
    printf '%s' '{"items":[{"metadata":{"name":"pgsql-0","uid":"pgsql-pod-uid","labels":{"app":"pgsql"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"rogue-rs","uid":"rogue-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[]}}]}'
  else
    printf '%s' '{"items":[{"metadata":{"name":"pgsql-0","uid":"pgsql-pod-uid","labels":{"app":"pgsql"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"pgsql-rs","uid":"pgsql-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[]}}]}'
  fi
  exit 0
fi
if [[ "$joined" == get\ pod\ *"-l app=reticulum"*"-o json"* ]]; then
  if [[ "${STUB_MODE:-}" == preflight-final-reticulum-pod-drift ||
        "${STUB_MODE:-}" == preflight-final-reticulum-owner-drift ]]; then
    preflight_reticulum_pod_count="$(atomic_stub_counter preflight-reticulum-pod-list-count)"
    if [[ "$preflight_reticulum_pod_count" -ge 2 ]]; then
      if [[ "${STUB_MODE:-}" == preflight-final-reticulum-pod-drift ]]; then
        printf '%s' '{"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"reticulum-final-drift-rv"},"items":[]}'
      else
        printf '%s' '{"apiVersion":"v1","kind":"PodList","items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"},"ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"reticulum-rs","uid":"replacement-reticulum-rs-uid","controller":true}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]},"spec":{"volumes":[{"name":"durable","persistentVolumeClaim":{"claimName":"ret-pvc"}}],"containers":[{"name":"reticulum","volumeMounts":[{"name":"durable","mountPath":"/storage"}]}]}}]}'
      fi
      exit 0
    fi
  fi
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
  pod_json="$(read_created_storage_helper_pod_snapshot)" || exit 1
  requested_pod="${3:-}"
  stored_pod="$(jq -er '.metadata.name' <<<"$pod_json")"
  [[ "$requested_pod" == "$stored_pod" ]] || exit 1
  count=0
  if [[ "${STUB_MODE:-}" == restore-pod-replaced ||
        "${STUB_MODE:-}" == stale-helper-replaced ]]; then
    count="$(atomic_stub_counter restore-pod-get-count)"
  fi
  restore_uid="$(jq -er '.metadata.uid' <<<"$pod_json")"
  if [[ ( "${STUB_MODE:-}" == "restore-pod-replaced" && "$count" -ge 3 ) ||
        ( "${STUB_MODE:-}" == "stale-helper-replaced" && "$count" -ge 2 ) ]]; then
    restore_uid="replacement-pod-uid"
  fi
  jq -c --arg uid "$restore_uid" '.metadata.uid = $uid' <<<"$pod_json"
  exit 0
fi
if [[ "$joined" == "get pod -n hcce -o json" ||
      "$joined" == "get pod -n hcce-bot-runners -o json" ]]; then
  target_namespace="${4:-}"
  if [[ "$target_namespace" == hcce-bot-runners &&
        "${STUB_MODE:-}" == checkpoint-dormant-fence-aba-before-first-resume &&
        -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" &&
        -f "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" &&
        -f "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count" &&
        "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")" == dormant &&
        "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")" == \
          recovery-operation-fence-binding-rv-3 &&
        "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count")" == 2 &&
        ! -e "$STUB_STATE_DIR/checkpoint-dormant-fence-aba-before-first-resume-observed" ]]; then
    # Model an external dormant(rv3) -> active(rv4) -> dormant(rv5)
    # excursion immediately after the operation's legitimate deactivation.
    printf '%s' recovery-operation-fence-binding-rv-5 \
      >"$STUB_STATE_DIR/recovery-operation-fence-binding-rv"
    : >"$STUB_STATE_DIR/checkpoint-dormant-fence-aba-before-first-resume-observed"
  fi
  if [[ "$target_namespace" == hcce &&
        "${STUB_CHECKPOINT_WRITER_QUERY:-0}" != 1 &&
        -e "$STUB_STATE_DIR/restore-storage-stream-started" &&
        ! -e "$STUB_STATE_DIR/restore-storage-stream-completed" &&
        ! -e "$STUB_STATE_DIR/restore-storage-monitor-inflight-observed" ]]; then
    write_monotonic_ns_marker \
      "$STUB_STATE_DIR/restore-storage-monitor-inflight-observed"
    printf '%s' "$$" >"$STUB_STATE_DIR/restore-storage-monitor-observer-pid"
    case "${STUB_MODE:-}" in
      restore-storage-monitor-exit) exit 1 ;;
      restore-storage-monitor-stall) exec sleep 12 ;;
    esac
  fi
  if [[ "$target_namespace" == hcce-bot-runners &&
        -n "${STUB_RUNNER_POD_PROFILE:-}" ]]; then
    profile_fixture="${STUB_RUNNER_POD_PROFILE}"
    case "$STUB_RUNNER_POD_PROFILE" in
      fence-stable) profile_fixture=fence ;;
      fence-disappears)
        if [[ -e "$STUB_STATE_DIR/checkpoint-backup-complete" ]]; then
          : >"$STUB_STATE_DIR/durable-fence-disappears-observed"
          profile_fixture=empty
        else
          profile_fixture=fence
        fi
        ;;
      fence-replaced)
        if [[ -e "$STUB_STATE_DIR/checkpoint-backup-complete" ]]; then
          : >"$STUB_STATE_DIR/durable-fence-replaced-observed"
          profile_fixture=fence-replaced
        else
          profile_fixture=fence
        fi
        ;;
      fence-terminating)
        if [[ -e "$STUB_STATE_DIR/checkpoint-backup-complete" ]]; then
          : >"$STUB_STATE_DIR/durable-fence-terminating-observed"
          profile_fixture=fence-terminating
        else
          profile_fixture=fence
        fi
        ;;
      runner|intent)
        [[ ! -e "$STUB_STATE_DIR/runner-profile-deleted" ]] || profile_fixture=empty
        ;;
    esac
    cat "$RUNNER_POD_FIXTURE_DIR/$profile_fixture.json"
    exit 0
  fi
  if [[ "$target_namespace" == hcce-bot-runners &&
        "${STUB_MODE:-}" == checkpoint-orphan-runner ]]; then
    if [[ -e "$STUB_STATE_DIR/checkpoint-orphan-runner-deleted" ]]; then
      cat "$RUNNER_POD_FIXTURE_DIR/empty.json"
    else
      cat "$RUNNER_POD_FIXTURE_DIR/runner.json"
    fi
    exit 0
  fi
  helper_snapshot_purpose=list
  if [[ "${STUB_MODE:-}" == helper-pod-list-open-missing-race ]]; then
    helper_snapshot_purpose=list-open-missing-race
  fi
  pods_json='{"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"100"},"items":[]}'
  if [[ "$target_namespace" == hcce &&
        "${STUB_MODE:-}" == checkpoint-writer-direct-pod-preexisting ]]; then
    pods_json='{"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"100"},"items":[{"apiVersion":"v1","kind":"Pod","metadata":{"name":"reticulum-direct","uid":"reticulum-direct-uid","labels":{"app":"reticulum"}},"spec":{"containers":[]},"status":{"phase":"Pending"}}]}'
  elif [[ "$target_namespace" == hcce &&
          "${STUB_CHECKPOINT_WRITER_QUERY:-}" == 1 ]]; then
    pods_json="$(emit_checkpoint_writer_pods)"
  elif [[ "$target_namespace" == hcce ]] &&
       helper_pod_json="$(read_created_storage_helper_pod_snapshot \
         "$helper_snapshot_purpose")"; then
    count=0
    if [[ "${STUB_MODE:-}" == monitor-extra ]]; then
      count="$(atomic_stub_counter consumer-count)"
    fi
    if [[ "${STUB_MODE:-}" == "extra-consumer" ||
          "${STUB_MODE:-}" == "backup-extra-consumer" ||
          ( "${STUB_MODE:-}" == "monitor-extra" && "$count" -ge 3 ) ||
          ( "${STUB_MODE:-}" == "backup-monitor-extra" &&
            -e "$STUB_STATE_DIR/backup-monitor-stream-started" ) ]]; then
      pods_json="$(jq -cn --argjson helper "$helper_pod_json" \
        '{apiVersion:"v1",kind:"PodList",metadata:{resourceVersion:"101"},
          items:[$helper,{apiVersion:"v1",kind:"Pod",metadata:{name:"rogue",
            namespace:"hcce",uid:"rogue-pod-uid",resourceVersion:"rogue-rv-1",
            labels:{}},spec:{volumes:[{persistentVolumeClaim:{claimName:"ret-pvc"}}]}}]}')"
    else
      pods_json="$(jq -cn --argjson helper "$helper_pod_json" \
        '{apiVersion:"v1",kind:"PodList",metadata:{resourceVersion:"101"},
          items:[$helper]}')"
    fi
  elif [[ "$target_namespace" == hcce ]]; then
    if [[ "${STUB_OPERATION:-}" == "storage-backup" ]]; then
      if [[ "${STUB_MODE:-}" == "backup-extra-consumer" ||
            ( "${STUB_MODE:-}" == "backup-monitor-extra" &&
              -e "$STUB_STATE_DIR/backup-monitor-stream-started" ) ]]; then
        pods_json='{"apiVersion":"v1","kind":"PodList","items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"}},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}},{"metadata":{"name":"rogue","uid":"rogue-pod-uid","labels":{}},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}}]}'
      else
        pods_json='{"apiVersion":"v1","kind":"PodList","items":[{"metadata":{"name":"reticulum-0","uid":"reticulum-pod-uid","labels":{"app":"reticulum"}},"spec":{"volumes":[{"persistentVolumeClaim":{"claimName":"ret-pvc"}}]}}]}'
      fi
    else
      pods_json='{"apiVersion":"v1","kind":"PodList","items":[]}'
    fi
  fi
  runner_count=0
  if [[ "${STUB_MODE:-}" == runner-reappears ||
        "${STUB_MODE:-}" == runner-reappears-timeout ]]; then
    runner_count="$(atomic_stub_counter runner-list-count)"
  fi
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
    runner-reappears|runner-reappears-timeout)
      # Keep both the initial generation read and the exact parent-writer
      # boundary clean. The third ordinary read belongs to the child
      # quiescence waiter whose residual/timeout behavior these modes test.
      if [[ "$runner_count" -ge 3 ]]; then
        runner_labels='{"app":"bot-runner","yenhubs.org/managed-by":"bot-orchestrator"}'
      fi
      ;;
    runner-reappears-during-storage|runner-reappears-before-parent|runner-transient-during-ret)
      if [[ -e "$STUB_STATE_DIR/runner-reappear" ]]; then
        runner_labels='{"app":"bot-runner","yenhubs.org/managed-by":"bot-orchestrator"}'
      fi
      ;;
    finalizer-failclose-drift)
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
  if [[ "$target_namespace" == hcce &&
        "${STUB_CHECKPOINT_WRITER_QUERY:-}" == 1 ]]; then
    if [[ -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]]; then
      pods_json="$(jq -c '
        .metadata.resourceVersion = "receipt-final-pods-list-rv"
      ' <<<"$pods_json")"
    elif [[ "${STUB_MODE:-}" == legacy-receipt-w1-pod &&
            -d "$STUB_STATE_DIR/checkpoint-receipt-phase-pod-list-boundary" ]]; then
      pods_json="$(jq -c '
        .metadata.resourceVersion = "receipt-race-pods-list-rv"
      ' <<<"$pods_json")"
    fi
  fi
  printf '%s' "$pods_json"
  exit 0
fi
if [[ "$joined" == "get --raw /apis/apps/v1/namespaces/hcce/deployments" ]]; then
  case "${STUB_MODE:-}" in
    checkpoint-writer-list-item-gvk-omitted)
      emit_checkpoint_writer_deployments | jq -c '
        .items |= map(del(.apiVersion, .kind))
      '
      ;;
    checkpoint-writer-deployment-gvk-spoof)
      emit_checkpoint_writer_deployments | jq -c '
        (.items[] | select(.metadata.name == "reticulum") | .kind) = "Pod"
      '
      ;;
    checkpoint-writer-list-key-order)
      emit_checkpoint_writer_deployments | jq -c '
        .items |= map(
          .spec.template = {
            spec:.spec.template.spec,
            metadata:.spec.template.metadata
          }
        )
      '
      ;;
    *)
      "$0" --context fixture-context --request-timeout=45s \
        get deployments -n hcce -o json
      ;;
  esac
  exit $?
fi
if [[ "$joined" == "get --raw /apis/apps/v1/namespaces/hcce/replicasets" ]]; then
  case "${STUB_MODE:-}" in
    rolling-preflight-replicaset)
      emit_checkpoint_writer_replicasets | jq -c '
        (.items[] | select(.metadata.name == "bot-orchestrator-rs") |
          .metadata.ownerReferences[0].uid) = "foreign-deployment-uid"
      '
      ;;
    rolling-rs-hash-mismatch)
      emit_checkpoint_writer_replicasets | jq -c '
        (.items[] | select(.metadata.name == "bot-orchestrator-rs") |
          .spec.template.metadata.labels["pod-template-hash"]) = "wrong-hash"
      '
      ;;
    rolling-rs-revision-mismatch)
      emit_checkpoint_writer_replicasets | jq -c '
        (.items[] | select(.metadata.name == "bot-orchestrator-rs") |
          .metadata.annotations["deployment.kubernetes.io/revision"]) = "12"
      '
      ;;
    rolling-rs-template-drift)
      emit_checkpoint_writer_replicasets | jq -c '
        (.items[] | select(.metadata.name == "bot-orchestrator-rs") |
          .spec.template.metadata.annotations["fixture.invalid/drift"]) = "true"
      '
      ;;
    rolling-list-item-gvk-omitted)
      emit_checkpoint_writer_replicasets | jq -c '
        .items |= map(del(.apiVersion, .kind))
      '
      ;;
    rolling-rs-current-gvk-spoof)
      emit_checkpoint_writer_replicasets | jq -c '
        (.items[] | select(.metadata.name == "bot-orchestrator-rs") |
          .apiVersion) = "apps/v2"
      '
      ;;
    rolling-rs-historical-gvk-spoof)
      emit_checkpoint_writer_replicasets | jq -c '
        (.items[] | select(.metadata.name == "bot-orchestrator-rs-historical") |
          .kind) = "Deployment"
      '
      ;;
    checkpoint-writer-list-item-gvk-omitted)
      emit_checkpoint_writer_replicasets | jq -c '
        .items |= map(del(.apiVersion, .kind))
      '
      ;;
    checkpoint-writer-replicaset-gvk-spoof)
      emit_checkpoint_writer_replicasets | jq -c '
        (.items[] | select(.metadata.name == "reticulum-rs") |
          .apiVersion) = "apps/v2"
      '
      ;;
    checkpoint-writer-template-pull-secret)
      emit_checkpoint_writer_replicasets | jq -c '
        .items |= map(
          .spec.template.spec.imagePullSecrets =
            [{name:"fixture-template-pull-secret"}]
        )
      '
      ;;
    *)
      "$0" --context fixture-context --request-timeout=45s \
        get replicasets -n hcce -o json
      ;;
  esac
  exit $?
fi
if [[ "$joined" == \
      "get --raw /api/v1/namespaces/hcce/pods?labelSelector=app%3Dbot-orchestrator" ]]; then
  case "${STUB_MODE:-}" in
    rolling-preflight-pod)
      emit_process_local_parent_pods | jq -c '
        .items += [(.items[0] | .metadata.name = "bot-orchestrator-extra" |
          .metadata.uid = "bot-orchestrator-extra-uid")]
      '
      ;;
    rolling-list-item-gvk-omitted)
      emit_process_local_parent_pods | jq -c '
        .items |= map(del(.apiVersion, .kind))
      '
      ;;
    rolling-pod-gvk-spoof)
      emit_process_local_parent_pods | jq -c '
        (.items[] | select(.metadata.labels.app == "bot-orchestrator") |
          .kind) = "ReplicaSet"
      '
      ;;
    *) emit_process_local_parent_pods ;;
  esac
  exit 0
fi
if [[ "$joined" == \
      "get --raw /apis/autoscaling/v2/namespaces/hcce/horizontalpodautoscalers" ]]; then
  if [[ "${STUB_MODE:-}" == rolling-preflight-hpa ]]; then
    jq -cn '{apiVersion:"autoscaling/v2",kind:"HorizontalPodAutoscalerList",
      metadata:{resourceVersion:"hpa-list-rv"},items:[{apiVersion:"autoscaling/v2",
      kind:"HorizontalPodAutoscaler",metadata:{name:"bot-orchestrator",namespace:"hcce"},
      spec:{scaleTargetRef:{apiVersion:"apps/v1",kind:"Deployment",
        name:"bot-orchestrator"},minReplicas:1,maxReplicas:2}}]}'
  else
    jq -cn '{apiVersion:"autoscaling/v2",kind:"HorizontalPodAutoscalerList",
      metadata:{resourceVersion:"hpa-list-rv"},items:[]}'
  fi
  exit 0
fi
if [[ "$joined" == get\ --raw\ /apis/apps/v1/namespaces/hcce/deployments\?* ||
      "$joined" == get\ --raw\ /apis/apps/v1/namespaces/hcce/replicasets\?* ]]; then
  raw_path="${3:-}"
  [[ "$raw_path" == *"allowWatchBookmarks=true"* &&
     "$raw_path" == *"resourceVersion="* &&
     "$raw_path" != *"resourceVersionMatch="* &&
     "$raw_path" != *"sendInitialEvents="* ]] || exit 1
  if [[ "$raw_path" == *"/deployments?"* ]]; then
    writer_watch_resource=deployments
  else
    writer_watch_resource=replicasets
  fi
  checkpoint_receipt_watch_handoff "$writer_watch_resource" "$raw_path" || :
  if [[ "${STUB_MODE:-}" == checkpoint-writer-post-join-transient ]]; then
    if [[ "$writer_watch_resource" == deployments &&
          "$raw_path" == *"timeoutSeconds=65"* ]]; then
      : >"$STUB_STATE_DIR/checkpoint-writer-terminal-watch-seen"
    fi
    if [[ -e "$STUB_STATE_DIR/checkpoint-writer-post-join-transient" ]]; then
      : >"$STUB_STATE_DIR/checkpoint-writer-post-join-rewait"
    fi
  fi
  writer_terminal_watch=false
  if [[ "$raw_path" == *"timeoutSeconds=65"* ||
        "$raw_path" == *"timeoutSeconds=1"* ]]; then
    writer_terminal_watch=true
  fi
  if [[ "$writer_terminal_watch" == true &&
        "$writer_watch_resource" == deployments ]]; then
    if [[ "$raw_path" == *"resourceVersion=writer-deployments-list-rv"* ]]; then
      : >"$STUB_STATE_DIR/checkpoint-writer-terminal-w2-deployments-started"
    else
      : >"$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-started"
      if [[ "${STUB_MODE:-}" == checkpoint-writer-terminal-control-gap ]]; then
        trap ': >"$STUB_STATE_DIR/checkpoint-writer-terminal-w1-stopped"; trap - TERM; kill -TERM "$$"' TERM
      fi
    fi
  fi
  writer_watch_count="$(atomic_stub_counter "writer-watch-$writer_watch_resource")"
  case "${STUB_MODE:-}" in
    checkpoint-writer-watch-error)
      if [[ "$writer_watch_resource" == deployments && "$writer_watch_count" == 1 ]]; then
        jq -cn '{type:"ERROR",object:{apiVersion:"v1",kind:"Status",code:410,
          reason:"Expired",metadata:{resourceVersion:"writer-watch-error-rv"}}}'
        exit 0
      fi
      ;;
    checkpoint-writer-watch-closes)
      if [[ "$writer_watch_resource" == deployments && "$writer_watch_count" == 1 ]]; then
        exit 0
      fi
      ;;
    checkpoint-writer-deployment-excursion)
      if [[ "$writer_watch_resource" == deployments && "$writer_watch_count" == 1 ]]; then
        emit_checkpoint_writer_deployments | jq -c '
          .items[] | select(.metadata.name == "reticulum") |
          .spec.replicas = 1 |
          {type:"MODIFIED",object:.},
          (.spec.replicas = 0 | .metadata.resourceVersion = "rv-reticulum-excursion-2" |
            {type:"MODIFIED",object:.})
        '
        exit 0
      fi
      ;;
    checkpoint-writer-post-ready-excursion)
      if [[ "$writer_watch_resource" == deployments &&
            -e "$STUB_STATE_DIR/checkpoint-backup-complete" &&
            ! -e "$STUB_STATE_DIR/checkpoint-writer-post-ready-emitted" ]]; then
        : >"$STUB_STATE_DIR/checkpoint-writer-post-ready-emitted"
        emit_checkpoint_writer_deployments | jq -c '
          .items[] | select(.metadata.name == "reticulum") |
          .spec.replicas = 1 | .metadata.resourceVersion = "rv-reticulum-post-ready-1" |
          {type:"MODIFIED",object:.},
          (.spec.replicas = 0 | .metadata.resourceVersion = "rv-reticulum-post-ready-2" |
            {type:"MODIFIED",object:.})
        '
        exit 0
      fi
      ;;
    checkpoint-writer-final-publication-excursion)
      if [[ "$writer_watch_resource" == deployments &&
            ! -e "$STUB_STATE_DIR/checkpoint-writer-final-event-emitted" ]]; then
        # Stay below the monitor's two-second watch contract while polling the
        # test-only signal. Repeated watch rounds cover the whole backup until
        # the final claimed-directory rehash exposes the boundary marker.
        for _ in {1..100}; do
          [[ ! -e "$STUB_STATE_DIR/checkpoint-writer-final-boundary-read" ]] || break
          sleep 0.01
        done
        if [[ -e "$STUB_STATE_DIR/checkpoint-writer-final-boundary-read" ]]; then
          : >"$STUB_STATE_DIR/checkpoint-writer-final-event-emitted"
          emit_checkpoint_writer_deployments | jq -c '
            .items[] | select(.metadata.name == "reticulum") |
            .spec.replicas = 1 |
            .metadata.resourceVersion = "rv-reticulum-final-publication-1" |
            {type:"MODIFIED",object:.},
            (.spec.replicas = 0 |
              .metadata.resourceVersion = "rv-reticulum-final-publication-2" |
              {type:"MODIFIED",object:.})
          '
          exit 0
        fi
      fi
      ;;
    checkpoint-writer-replicaset-excursion)
      if [[ "$writer_watch_resource" == replicasets && "$writer_watch_count" == 1 ]]; then
        emit_checkpoint_writer_replicasets | jq -c '
          .items[] | select(.metadata.name == "reticulum-rs") |
          .spec.replicas = 1 |
          {type:"MODIFIED",object:.},
          (.spec.replicas = 0 | .metadata.resourceVersion = "rv-reticulum-rs-excursion-2" |
            {type:"MODIFIED",object:.})
        '
        exit 0
      fi
      ;;
    checkpoint-writer-replicaset-added)
      if [[ "$writer_watch_resource" == replicasets && "$writer_watch_count" == 1 ]]; then
        emit_checkpoint_writer_replicasets | jq -c '
          .items[] | select(.metadata.name == "reticulum-rs") |
          .metadata.name = "reticulum-rs-new" |
          .metadata.uid = "reticulum-rs-new-uid" |
          .metadata.resourceVersion = "rv-reticulum-rs-new" |
          {type:"ADDED",object:.}
        '
        exit 0
      fi
      ;;
  esac
  jq -cn --arg rv "writer-$writer_watch_resource-bookmark-$writer_watch_count" '
    {type:"BOOKMARK",object:{metadata:{resourceVersion:$rv}}}
  '
  if [[ "$writer_terminal_watch" == true ]]; then
    case "${STUB_MODE:-}" in
      checkpoint-writer-terminal-list-gap)
        sleep 1
        if [[ "$writer_watch_resource" == deployments ]]; then
          : >"$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-closed"
        fi
        exit 0
        ;;
      checkpoint-writer-terminal-live)
        while sleep 1; do :; done
        ;;
      checkpoint-writer-terminal-control-gap)
        if [[ "$writer_watch_resource" == deployments &&
              "$raw_path" == *"resourceVersion=writer-deployments-list-rv"* ]]; then
          for _ in {1..300}; do
            [[ ! -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-stopped" ]] || break
            sleep 0.01
          done
          [[ -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-stopped" ]] || exit 91
          sleep 0.15
          emit_checkpoint_writer_deployments | jq -c '
            .items[] | select(.metadata.name == "reticulum") |
            .spec.replicas = 1 |
            .metadata.resourceVersion = "rv-reticulum-terminal-gap-1" |
            {type:"MODIFIED",object:.},
            (.spec.replicas = 0 |
              .metadata.resourceVersion = "rv-reticulum-terminal-gap-2" |
              {type:"MODIFIED",object:.})
          '
          : >"$STUB_STATE_DIR/checkpoint-writer-terminal-control-gap-excursion"
        fi
        while sleep 1; do :; done
        ;;
    esac
  fi
  exit 0
fi
if [[ "$joined" == "get --raw /api/v1/namespaces/hcce/pods" ]]; then
  case "${STUB_MODE:-}" in
    checkpoint-writer-list-item-gvk-omitted)
      emit_checkpoint_writer_pods | jq -c '
        .items |= map(del(.apiVersion, .kind))
      '
      ;;
    checkpoint-writer-pod-gvk-spoof)
      emit_checkpoint_writer_pods | jq -c '
        (.items[0].kind) = "ReplicaSet"
      '
      ;;
    checkpoint-writer-live-pod-defaults|checkpoint-writer-live-pod-secret-watch-drift)
      emit_checkpoint_writer_pods | jq -c '
        .items |= map(
          del(.apiVersion, .kind) |
          .spec.enableServiceLinks = true |
          .spec.imagePullSecrets = [{name:"fixture-serviceaccount-pull-secret"}]
        )
      '
      ;;
    checkpoint-writer-template-pull-secret)
      emit_checkpoint_writer_pods | jq -c '
        .items |= map(
          del(.apiVersion, .kind) |
          .spec.enableServiceLinks = true |
          .spec.imagePullSecrets = [{name:"fixture-template-pull-secret"}]
        )
      '
      ;;
    checkpoint-writer-live-pod-secret-mismatch)
      emit_checkpoint_writer_pods | jq -c '
        .items |= map(
          del(.apiVersion, .kind) |
          .spec.enableServiceLinks = true |
          .spec.imagePullSecrets = [{name:"wrong-fixture-pull-secret"}]
        )
      '
      ;;
    checkpoint-writer-live-pod-explicit-false)
      emit_checkpoint_writer_pods | jq -c '
        .items |= map(
          del(.apiVersion, .kind) |
          .spec.enableServiceLinks = true |
          .spec.imagePullSecrets = [{name:"fixture-serviceaccount-pull-secret"}]
        ) |
        .items[0].spec.enableServiceLinks = false
      '
      ;;
    *)
      "$0" --context fixture-context --request-timeout=45s \
        get pod -n hcce -o json
      ;;
  esac
  exit $?
fi
if [[ "$joined" == get\ serviceaccount\ *\ -n\ hcce\ -o\ json ]]; then
  service_account_name="${3:-}"
  [[ -n "$service_account_name" ]] || exit 1
  jq -cn --arg name "$service_account_name" '{apiVersion:"v1",kind:"ServiceAccount",
    metadata:{name:$name,namespace:"hcce",uid:($name+"-uid"),
      resourceVersion:($name+"-rv")},
    imagePullSecrets:[{name:"fixture-serviceaccount-pull-secret"}]}'
  exit 0
fi
if [[ "$joined" == \
      "get --raw /api/v1/namespaces/hcce-bot-runners/pods" ]]; then
  "$0" --context fixture-context --request-timeout=45s \
    get pod -n hcce-bot-runners -o json
  exit $?
fi
if [[ "$joined" == \
      "get --raw /api/v1/namespaces/hcce/persistentvolumeclaims" ]]; then
  "$0" --context fixture-context --request-timeout=45s \
    get persistentvolumeclaim -n hcce -o json
  exit $?
fi
if [[ "$joined" == "get --raw /apis/batch/v1/namespaces/hcce/jobs" ]]; then
  "$0" --context fixture-context --request-timeout=45s \
    get job -n hcce -o json
  exit $?
fi
if [[ "$joined" == "get --raw /apis/batch/v1/namespaces/hcce/cronjobs" ]]; then
  "$0" --context fixture-context --request-timeout=45s \
    get cronjob -n hcce -o json
  exit $?
fi
if [[ "$joined" == "get --raw /apis/apps/v1/namespaces/hcce/daemonsets" ]]; then
  "$0" --context fixture-context --request-timeout=45s \
    get daemonset -n hcce -o json
  exit $?
fi
if [[ "$joined" == "get --raw /apis/apps/v1/namespaces/hcce/statefulsets" ]]; then
  "$0" --context fixture-context --request-timeout=45s \
    get statefulset -n hcce -o json
  exit $?
fi
if [[ "$joined" == "get --raw /api/v1/namespaces/hcce" ]]; then
  emit_recovery_fence_namespace_fixture \
    "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce.json"
  exit 0
fi
if [[ "$joined" == \
      "get --raw /api/v1/namespaces/hcce-bot-runners" ]]; then
  emit_recovery_fence_namespace_fixture \
    "$RUNNER_EVIDENCE_LIVE_DIR/namespace-hcce-bot-runners.json"
  exit 0
fi
if [[ "$joined" == "get --raw /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/recovery-operation-pod-fence.yenhubs.org" ]]; then
  cat "$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
  exit 0
fi
if [[ "$joined" == "get --raw /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/recovery-operation-pod-fence.yenhubs.org" ]]; then
  if [[ -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" &&
        -f "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" ]]; then
    fence_state="$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")"
    fence_rv="$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")"
    if [[ "$fence_state" == active ]]; then
      jq --arg rv "$fence_rv" '.metadata.resourceVersion = $rv' \
        "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
    elif [[ "$fence_state" == dormant ]]; then
      jq --arg rv "$fence_rv" '
        .metadata.resourceVersion = $rv |
        .spec.matchResources.namespaceSelector.matchExpressions = [{
          key:"kubernetes.io/metadata.name",operator:"DoesNotExist"}]
      ' "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
    else
      exit 1
    fi
  else
    cat "$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
  fi
  exit 0
fi
if [[ "$joined" == "get --raw /api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock" ]]; then
  "$0" --context fixture-context --request-timeout=45s \
    get configmap yenhubs-recovery-operation-lock -n hcce -o json
  exit $?
fi
if [[ "$joined" == "get --raw /apis/coordination.k8s.io/v1/namespaces/hcce/leases/yenhubs-operation-serialization" ]]; then
  lease_fixture_lock_acquire || exit 1
  trap lease_fixture_lock_release EXIT
  raw_lease_get_status=0
  "$0" --context fixture-context --request-timeout=45s \
    get lease yenhubs-operation-serialization -n hcce -o json ||
    raw_lease_get_status=$?
  if [[ -d "$LEASE_FIXTURE_HANDOFF_DIR" ]]; then
    rmdir "$LEASE_FIXTURE_HANDOFF_DIR" || exit 1
  fi
  exit "$raw_lease_get_status"
fi
if [[ "$joined" == get\ --raw\ *\?*fieldSelector=metadata.name%3D* ]]; then
  raw_path="${3:-}"
  case "$raw_path" in
    /api/v1/namespaces\?*hcce-bot-runners*) control_watch_rv=namespace-rv-runner ;;
    /api/v1/namespaces\?*) control_watch_rv=namespace-rv-hcce ;;
    /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies\?*)
      control_watch_rv=recovery-operation-fence-policy-rv-1 ;;
    /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings\?*)
      control_watch_rv=recovery-operation-fence-binding-rv-1
      [[ ! -f "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" ]] ||
        control_watch_rv="$(cat \
          "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")"
      ;;
    /api/v1/namespaces/hcce/configmaps\?*) control_watch_rv=lock-rv-1 ;;
    /apis/coordination.k8s.io/v1/namespaces/hcce/leases\?*)
      lease_fixture_lock_acquire || exit 1
      trap lease_fixture_lock_release EXIT
      [[ -f "$STUB_STATE_DIR/serialization-lease.json" ]] || exit 1
      control_watch_lease_json="$(cat \
        "$STUB_STATE_DIR/serialization-lease.json")"
      control_watch_rv="$(jq -er '.metadata.resourceVersion' \
        <<<"$control_watch_lease_json")"
      control_watch_cursor="${raw_path#*resourceVersion=}"
      control_watch_cursor="${control_watch_cursor%%&*}"
      [[ ! -e "$LEASE_FIXTURE_HANDOFF_DIR" ]] || exit 1
      mkdir "$LEASE_FIXTURE_HANDOFF_DIR" || exit 1
      if [[ "$control_watch_cursor" != "$control_watch_rv" ]]; then
        jq -c '{type:"MODIFIED",object:.}' \
          <<<"$control_watch_lease_json"
      fi
      ;;
    *) exit 91 ;;
  esac
  jq -cn --arg rv "$control_watch_rv" \
    '{type:"BOOKMARK",object:{metadata:{resourceVersion:$rv}}}'
  exit 0
fi
if [[ "$joined" == get\ --raw\ /api/v1/namespaces/*/pods\?* ]]; then
  raw_path="${3:-}"
  initial_watch=false
  if [[ "$raw_path" == *"resourceVersionMatch=NotOlderThan"* ||
        "$raw_path" == *"sendInitialEvents=true"* ]]; then
    [[ "${STUB_RUNNER_NAMESPACE:-absent}" == present &&
       "$raw_path" == *"allowWatchBookmarks=true"* &&
       "$raw_path" == *"resourceVersion="* &&
       "$raw_path" == *"resourceVersionMatch=NotOlderThan"* &&
       "$raw_path" == *"sendInitialEvents=true"* ]] || exit 1
    initial_watch=true
  else
    [[ "$raw_path" == *"allowWatchBookmarks=true"* &&
       "$raw_path" == *"resourceVersion="* ]] || exit 1
  fi
  watch_namespace="${raw_path#/api/v1/namespaces/}"
  watch_namespace="${watch_namespace%%/pods\?*}"
  [[ "$watch_namespace" == hcce || "$watch_namespace" == hcce-bot-runners ]] || exit 1
  if [[ "$watch_namespace" == hcce ]]; then
    checkpoint_receipt_watch_handoff pods "$raw_path" || :
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-post-join-transient &&
        -e "$STUB_STATE_DIR/checkpoint-writer-post-join-transient" ]]; then
    : >"$STUB_STATE_DIR/checkpoint-writer-post-join-rewait"
  fi
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
  if [[ "$initial_watch" == true ]]; then
    "$0" --context fixture-context --request-timeout=45s \
      get pod -n "$watch_namespace" -o json | jq -c '
        .items[] |
        .apiVersion = "v1" | .kind = "Pod" |
        {type:"ADDED",object:.}
      '
    jq -cn '{type:"BOOKMARK",object:{apiVersion:"v1",kind:"Pod",metadata:{
      resourceVersion:"101",annotations:{
        "k8s.io/initial-events-end":"true"}}}}'
    trap 'exit 0' TERM INT
    while sleep 1; do :; done
  fi
  if [[ "${STUB_MODE:-}" == runner-watch-fails-before-event ]]; then
    exit 1
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-watch-error &&
        "$watch_namespace" == hcce && "$watch_count" == 1 ]]; then
    jq -cn '{type:"ERROR",object:{apiVersion:"v1",kind:"Status",code:410,
      reason:"Expired",metadata:{resourceVersion:"writer-pod-watch-error-rv"}}}'
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-watch-closes &&
        "$watch_namespace" == hcce && "$watch_count" == 1 ]]; then
    exit 0
  fi
  if [[ ( "${STUB_MODE:-}" == checkpoint-writer-owned-helper-lifecycle ||
          "${STUB_MODE:-}" == checkpoint-writer-helper-rw ||
          "${STUB_MODE:-}" == checkpoint-writer-helper-env ||
          "${STUB_MODE:-}" == checkpoint-writer-helper-ephemeral ||
          "${STUB_MODE:-}" == checkpoint-writer-helper-cross-owner ||
          "${STUB_MODE:-}" == checkpoint-writer-helper-cross-mode ||
          "${STUB_MODE:-}" == checkpoint-writer-helper-image-drift ) &&
        "$watch_namespace" == hcce && "$watch_count" == 2 ]]; then
    helper_added="$(emit_checkpoint_storage_helper_pod helper-rv-1 Pending)"
    case "${STUB_MODE:-}" in
      checkpoint-writer-helper-rw)
        helper_added="$(jq -c '
          .spec.volumes[0].persistentVolumeClaim.readOnly = false |
          .spec.containers[0].volumeMounts[0].readOnly = false
        ' <<<"$helper_added")"
        ;;
      checkpoint-writer-helper-env)
        helper_added="$(jq -c '
          .spec.containers[0].env = [{name:"DEBUG",value:"true"}]
        ' <<<"$helper_added")"
        ;;
      checkpoint-writer-helper-ephemeral)
        helper_added="$(jq -c '
          .spec.ephemeralContainers = [{name:"debugger",
            image:("ghcr.io/yengalvez/reticulum@sha256:"+("6"*64))}]
        ' <<<"$helper_added")"
        ;;
      checkpoint-writer-helper-image-drift)
        helper_added="$(jq -c '
          .spec.containers[0].image =
            ("ghcr.io/yengalvez/reticulum@sha256:"+("9"*64))
        ' <<<"$helper_added")"
        ;;
    esac
    if [[ "${STUB_MODE:-}" == checkpoint-writer-owned-helper-lifecycle ]]; then
      helper_modified="$(emit_checkpoint_storage_helper_pod helper-rv-2 Running)"
      helper_deleted="$(emit_checkpoint_storage_helper_pod helper-rv-3 Succeeded \
        2026-07-20T00:00:00Z)"
      jq -cn --argjson added "$helper_added" --argjson modified "$helper_modified" \
        --argjson deleted "$helper_deleted" '
        {type:"ADDED",object:$added},
        {type:"MODIFIED",object:$modified},
        {type:"DELETED",object:$deleted},
        {type:"BOOKMARK",object:{metadata:{resourceVersion:"helper-lifecycle-rv"}}}
      '
    else
      jq -cn --argjson added "$helper_added" '
        {type:"ADDED",object:$added},
        {type:"BOOKMARK",object:{metadata:{resourceVersion:"invalid-helper-rv"}}}
      '
    fi
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-nonwriter-pod-replacement &&
        "$watch_namespace" == hcce && "$watch_count" == 1 ]]; then
    baseline_pod="$(emit_checkpoint_writer_pods | jq -ce '
      .items[] | select(.metadata.name == "dialog-0")
    ')"
    replacement_pod="$(jq -c '
      .metadata.name = "dialog-1" |
      .metadata.uid = "dialog-replacement-pod-uid" |
      .metadata.resourceVersion = "dialog-replacement-pod-rv-1" |
      .status = {phase:"Pending"}
    ' <<<"$baseline_pod")"
    replacement_ready="$(jq -c '
      .metadata.resourceVersion = "dialog-replacement-pod-rv-2" |
      .status = {phase:"Running",conditions:[{type:"Ready",status:"True"}]}
    ' <<<"$replacement_pod")"
    jq -cn --argjson deleted "$(jq -c '
        .metadata.resourceVersion = "dialog-deleted-pod-rv"
      ' <<<"$baseline_pod")" \
      --argjson added "$replacement_pod" --argjson modified "$replacement_ready" '
      {type:"DELETED",object:$deleted},
      {type:"ADDED",object:$added},
      {type:"MODIFIED",object:$modified},
      {type:"BOOKMARK",object:{metadata:{resourceVersion:"dialog-replacement-rv"}}}
    '
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-live-pod-secret-watch-drift &&
        "$watch_namespace" == hcce && "$watch_count" == 1 ]]; then
    baseline_pod="$(emit_checkpoint_writer_pods | jq -ce '
      .items[] | select(.metadata.name == "dialog-0") |
      .spec.enableServiceLinks = true |
      .spec.imagePullSecrets = [{name:"fixture-serviceaccount-pull-secret"}]
    ')"
    replacement_pod="$(jq -c '
      .metadata.name = "dialog-secret-drift" |
      .metadata.uid = "dialog-secret-drift-uid" |
      .metadata.resourceVersion = "dialog-secret-drift-rv" |
      .spec.imagePullSecrets = [{name:"wrong-fixture-pull-secret"}]
    ' <<<"$baseline_pod")"
    jq -cn --argjson added "$replacement_pod" '
      {type:"ADDED",object:$added},
      {type:"BOOKMARK",object:{metadata:{resourceVersion:"secret-drift-rv"}}}
    '
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-nonwriter-pod-annotation-drift &&
        "$watch_namespace" == hcce && "$watch_count" == 1 ]]; then
    emit_checkpoint_writer_pods | jq -c '
      .items[] | select(.metadata.name == "dialog-0") |
      .metadata.resourceVersion = "dialog-annotation-drift-rv" |
      .metadata.annotations["fixture.invalid/drift"] = "unsafe" |
      {type:"MODIFIED",object:.}
    '
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-pod-excursion &&
        "$watch_namespace" == hcce && "$watch_count" == 1 ]]; then
    jq -cn '
      {type:"ADDED",object:{apiVersion:"v1",kind:"Pod",metadata:{
        name:"reticulum-transient",namespace:"hcce",uid:"reticulum-transient-uid",
        resourceVersion:"writer-pod-rv-1",labels:{app:"reticulum"}},spec:{containers:[]}}},
      {type:"DELETED",object:{apiVersion:"v1",kind:"Pod",metadata:{
        name:"reticulum-transient",namespace:"hcce",uid:"reticulum-transient-uid",
        resourceVersion:"writer-pod-rv-2",labels:{app:"reticulum"}},spec:{containers:[]}}}
    '
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-writer-pod-modified-dangerous &&
        "$watch_namespace" == hcce && "$watch_count" == 1 ]]; then
    jq -cn '
      {type:"MODIFIED",object:{apiVersion:"v1",kind:"Pod",metadata:{
        name:"reticulum-direct",namespace:"hcce",uid:"reticulum-direct-uid",
        resourceVersion:"writer-pod-modified-rv",labels:{app:"reticulum"}},
        spec:{containers:[]},status:{phase:"Pending"}}}
    '
    exit 0
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
  elif [[ "${STUB_MODE:-}" == durable-wrapper-live ]]; then
    jq -cn '{type:"BOOKMARK",object:{metadata:{resourceVersion:"101"}}}'
  else
    jq -cn '{type:"BOOKMARK",object:{metadata:{resourceVersion:"101",annotations:{
      "k8s.io/initial-events-end":"true"}}}}'
  fi
  if [[ "${STUB_MODE:-}" == durable-wrapper-live ]]; then
    trap 'exit 0' TERM INT
    while sleep 1; do :; done
  fi
  if [[ "$raw_path" == *"timeoutSeconds=65"* ||
        "$raw_path" == *"timeoutSeconds=1"* ]]; then
    case "${STUB_MODE:-}" in
      checkpoint-writer-terminal-list-gap)
        sleep 1
        ;;
      checkpoint-writer-terminal-live|checkpoint-writer-terminal-control-gap)
        while sleep 1; do :; done
        ;;
    esac
  fi
  exit 0
fi
if [[ "$joined" == get\ networkpolicy\ *"-o json" && "$joined" != "get networkpolicy -n hcce -o json" ]]; then
  [[ -f "$STUB_STATE_DIR/network-policy.yaml" ]] || exit 1
  requested_policy="${3:-}"
  stored_policy="$(cat "$STUB_STATE_DIR/network-policy-name")"
  [[ "$requested_policy" == "$stored_policy" ]] || exit 1
  policy_uid="$(cat "$STUB_STATE_DIR/network-policy-uid")"
  if [[ "${STUB_MODE:-}" == helper-policy-replaced &&
        "$(atomic_stub_counter helper-policy-get-count)" -ge 2 ]]; then
    policy_uid=replacement-network-policy-uid
  fi
  emit_created_storage_network_policy "$policy_uid"
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
if [[ "$joined" == "-n hcce get deployment bot-orchestrator -o json" ]]; then
  replicas=1
  [[ ! -f "$STUB_STATE_DIR/replicas-bot-orchestrator" ]] ||
    replicas="$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator")"
  rv_number=1
  [[ ! -f "$STUB_STATE_DIR/rv-bot-orchestrator" ]] ||
    rv_number="$(cat "$STUB_STATE_DIR/rv-bot-orchestrator")"
  jq -c --argjson replicas "$replicas" --arg rv "rv-bot-orchestrator-$rv_number" '
    .spec.replicas = $replicas |
    .metadata.resourceVersion = $rv |
    .status = {observedGeneration:1,replicas:$replicas,
      readyReplicas:$replicas,availableReplicas:$replicas,
      updatedReplicas:$replicas,unavailableReplicas:0}
  ' "$RUNNER_EVIDENCE_LIVE_DIR/parent-deployment.json"
  exit 0
fi
if [[ "$joined" == "get deployment -n hcce -o json" ]]; then
  cat "$STUB_DEPLOYMENTS_JSON"
  exit 0
fi
if [[ "$joined" == "get persistentvolumeclaim -n hcce -o json" ]]; then
  jq -cn --arg ret_uid "${STUB_PVC_UID:-fixture-pvc-uid}" '
    {apiVersion:"v1",kind:"PersistentVolumeClaimList",items:[
      {apiVersion:"v1",kind:"PersistentVolumeClaim",metadata:{name:"pgsql-pvc",
        namespace:"hcce",uid:"target-pgsql-pvc-uid",resourceVersion:"pvc-rv-1"}},
      {apiVersion:"v1",kind:"PersistentVolumeClaim",metadata:{name:"ret-pvc",
        namespace:"hcce",uid:$ret_uid,resourceVersion:"pvc-rv-2"}}]}
  '
  exit 0
fi
if [[ "$joined" == "get job -n hcce -o json" ]]; then
  printf '%s' '{"apiVersion":"batch/v1","kind":"JobList","items":[]}'
  exit 0
fi
if [[ "$joined" == "get cronjob -n hcce -o json" ]]; then
  printf '%s' '{"apiVersion":"batch/v1","kind":"CronJobList","items":[]}'
  exit 0
fi
if [[ "$joined" == "get daemonset -n hcce -o json" ]]; then
  printf '%s' '{"apiVersion":"apps/v1","kind":"DaemonSetList","items":[]}'
  exit 0
fi
if [[ "$joined" == "get statefulset -n hcce -o json" ]]; then
  printf '%s' '{"apiVersion":"apps/v1","kind":"StatefulSetList","items":[]}'
  exit 0
fi
if [[ "$joined" == "get horizontalpodautoscaler -n hcce -o json" ]]; then
  printf '%s' '{"apiVersion":"autoscaling/v2","kind":"HorizontalPodAutoscalerList","items":[]}'
  exit 0
fi
if [[ "$joined" == "get service lb -n hcce -o jsonpath={.status.loadBalancer.ingress[0].ip}" ]]; then
  printf '%s' '203.0.113.10'
  exit 0
fi
if [[ "$joined" == "get replicaset -n hcce -o json" ]]; then
  jq -c '
    {apiVersion:"apps/v1",kind:"ReplicaSetList",
     metadata:{resourceVersion:"replicaset-list-rv-1"},items:[.items[] |
      .metadata.name as $name |
      select(["reticulum","pgbouncer","pgbouncer-t","bot-orchestrator","coturn"] |
        index($name)) |
      .metadata.uid as $deployment_uid |
      {apiVersion:"apps/v1",kind:"ReplicaSet",metadata:{name:($name+"-rs"),
        namespace:"hcce",uid:($name+"-rs-uid"),ownerReferences:[{
          apiVersion:"apps/v1",kind:"Deployment",name:$name,
          uid:$deployment_uid,controller:true}]}}]}
  ' "$STUB_DEPLOYMENTS_JSON"
  exit 0
fi
if [[ "$joined" == get\ replicaset\ *"-o json" ]]; then
  replica_set="${3:-}"
  deployment="${replica_set%-rs}"
  jq -cn --arg rs "$replica_set" --arg deployment "$deployment" \
    --arg deployment_uid "$(jq -er --arg deployment "$deployment" \
      '.items[] | select(.metadata.name == $deployment) | .metadata.uid' \
      "$STUB_DEPLOYMENTS_JSON")" \
    '{apiVersion:"apps/v1",kind:"ReplicaSet",metadata:{name:$rs,namespace:"hcce",
      uid:($rs+"-uid"),ownerReferences:[{apiVersion:"apps/v1",kind:"Deployment",
      name:$deployment,uid:$deployment_uid,controller:true}]}}'
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
  checkpoint_receipt_observe_handoff_marker
  if [[ "${STUB_MODE:-}" == legacy-receipt-signal-before &&
        "$deployment" == reticulum &&
        -d "$STUB_STATE_DIR/checkpoint-receipt-phase-arm" &&
        ! -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] &&
     mkdir "$STUB_STATE_DIR/checkpoint-receipt-signal-before" 2>/dev/null; then
    checkpoint_receipt_trace 'SIGNAL_BEFORE_RECEIPT'
    kill -TERM "${STUB_RESTORE_DRIVER_PID:?}"
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-resume-postcheck-lost &&
        "$deployment" == bot-orchestrator &&
        -e "$STUB_STATE_DIR/checkpoint-resume-postcheck-pending" ]]; then
    rm -f -- "$STUB_STATE_DIR/checkpoint-resume-postcheck-pending"
    : >"$STUB_STATE_DIR/checkpoint-resume-postcheck-lost"
    exit 1
  fi
  deployment_json="$(emit_stub_deployment_json "$deployment")" || exit 1
  if [[ "$deployment" == bot-orchestrator ]]; then
    if [[ "${STUB_MODE:-}" == rolling-resume-committed-lost &&
          -e "$STUB_STATE_DIR/rolling-resume-reconcile-pending" ]]; then
      mv "$STUB_STATE_DIR/rolling-resume-reconcile-pending" \
        "$STUB_STATE_DIR/rolling-resume-reconcile-seen"
    fi
    if [[ "${STUB_MODE:-}" == rolling-strategy-window-drift &&
          -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
      deployment_json="$(jq -c '
        .spec.strategy = {type:"RollingUpdate",rollingUpdate:{
          maxSurge:"25%",maxUnavailable:"25%"}}
      ' <<<"$deployment_json")"
    fi
    case "${STUB_MODE:-}" in
      rolling-preflight-deployment-drift)
        rolling_deployment_get_count="$(atomic_stub_counter \
          rolling-preflight-deployment-get)"
        if ((rolling_deployment_get_count % 2 == 0)); then
          deployment_json="$(jq -c '
            .metadata.resourceVersion = "rolling-drift-rv" |
            .spec.template.metadata.annotations["fixture.invalid/drift"] = "true"
          ' <<<"$deployment_json")"
        fi
        ;;
      rolling-preflight-rollout)
        deployment_json="$(jq -c '
          .status.observedGeneration = (.metadata.generation - 1) |
          .status.readyReplicas = 0 | .status.availableReplicas = 0 |
          .status.unavailableReplicas = 1
        ' <<<"$deployment_json")"
        ;;
      rolling-post-downscale-drift)
        if [[ -f "$STUB_STATE_DIR/replicas-bot-orchestrator" &&
              "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator")" == 0 ]]; then
          deployment_json="$(jq -c '
            .spec.template.metadata.annotations["fixture.invalid/post-zero-drift"] = "true"
          ' <<<"$deployment_json")"
        fi
        ;;
      rolling-resume-ambiguous-lost)
        if [[ -e "$STUB_STATE_DIR/rolling-resume-ambiguous-lost" ]]; then
          deployment_json="$(jq -c '
            .spec.template.metadata.annotations["fixture.invalid/ambiguous"] = "true"
          ' <<<"$deployment_json")"
        fi
        ;;
    esac
  fi
  if [[ "$deployment" == reticulum &&
        -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" &&
        -d "$STUB_STATE_DIR/checkpoint-receipt-phase-rollout-reticulum" ]]; then
    checkpoint_receipt_record_once recapture-reticulum 'RECAPTURE_RETICULUM_RV' || :
  fi
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
    if [[ -e "$STUB_STATE_DIR/restore-db-stream-started" &&
          ! -e "$STUB_STATE_DIR/restore-db-stream-completed" &&
          ! -e "$STUB_STATE_DIR/restore-db-monitor-inflight-observed" ]]; then
      write_monotonic_ns_marker \
        "$STUB_STATE_DIR/restore-db-monitor-inflight-observed"
      printf '%s' "$$" >"$STUB_STATE_DIR/restore-db-monitor-observer-pid"
      case "${STUB_MODE:-}" in
        restore-db-monitor-exit) exit 1 ;;
        restore-db-monitor-stall) exec sleep 12 ;;
      esac
    fi
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
  if [[ ( "${STUB_MODE:-}" == runner-timeout ||
          "${STUB_MODE:-}" == runner-reappears-timeout ) &&
        "$joined" == *"pod/bot-runner-"* ]]; then
    exit 1
  fi
  [[ "${STUB_MODE:-}" != timeout ]] || exit 1
  : >"$STUB_STATE_DIR/waited"
  exit 0
fi
if [[ "$joined" == wait\ --for=condition=Ready\ * ]]; then exit 0; fi
if [[ "$joined" == patch\ deployment\ * ]]; then
  deployment="${3:-}"
  patch_json=""
  for argument in "$@"; do
    case "$argument" in
      --patch=*) patch_json="${argument#*=}" ;;
    esac
  done
  replica_file="$STUB_STATE_DIR/replicas-$deployment"
  rv_file="$STUB_STATE_DIR/rv-$deployment"
  current=1; [[ ! -f "$replica_file" ]] || current="$(cat "$replica_file")"
  rv_number=1; [[ ! -f "$rv_file" ]] || rv_number="$(cat "$rv_file")"
  generation_file="$STUB_STATE_DIR/generation-$deployment"
  generation=1
  [[ ! -f "$generation_file" ]] || generation="$(cat "$generation_file")"
  current_spec="$(emit_stub_deployment_json "$deployment" | jq -c '.spec')" || exit 1
  [[ "$joined" == *" -n hcce --type=json "* && -n "$patch_json" ]] || exit 1
  expected_patch_uid="$(jq -er --arg deployment "$deployment" \
    '.items[] | select(.metadata.name == $deployment) | .metadata.uid' \
    "$STUB_DEPLOYMENTS_JSON")" || exit 1
  if [[ "${STUB_MODE:-}" == finalizer-failclose-drift &&
        -e "$STUB_STATE_DIR/finalizer-failclose-triggered" &&
        "$deployment" == pgbouncer ]]; then
    expected_patch_uid=replacement-uid-pgbouncer
  fi
  patch_contract="$(jq -er --arg uid "$expected_patch_uid" \
    --arg rv "rv-$deployment-$rv_number" --argjson current "$current" \
    --argjson generation "$generation" --argjson current_spec "$current_spec" '
    def added_receipt:
      if .op == "add" and
         .path == "/metadata/annotations/yenhubs.org~1checkpoint-resume-operation" and
         (.value | type) == "string" then .value
      elif .op == "add" and .path == "/metadata/annotations" and
           (.value | type) == "object" and
           (.value | keys) == ["yenhubs.org/checkpoint-resume-operation"] and
           (.value["yenhubs.org/checkpoint-resume-operation"] | type) == "string"
      then .value["yenhubs.org/checkpoint-resume-operation"]
      else null end;
    select(type == "array") |
    select(.[0] == {op:"test",path:"/metadata/uid",value:$uid}) |
    select(.[1] == {op:"test",path:"/metadata/resourceVersion",value:$rv}) |
    select(.[2] == {op:"test",path:"/spec/replicas",value:$current} or
      .[2] == {op:"test",path:"/metadata/generation",value:$generation}) |
    if length == 5 and
       .[2] == {op:"test",path:"/metadata/generation",value:$generation} and
       .[3] == {op:"test",path:"/spec",value:$current_spec} and
       .[4].op == "replace" and .[4].path == "/spec/replicas" and
       (.[4].value | type) == "number" and .[4].value >= 0 and
       (.[4].value | floor) == .[4].value then
      ["rolling-scale",(.[4].value | tostring),""]
    elif length == 4 and (.[3] | added_receipt) != null then
      ["receipt",($current | tostring),(.[3] | added_receipt)]
    elif length == 4 and .[3].op == "replace" and
       .[3].path == "/spec/replicas" and
       (.[3].value | type) == "number" and .[3].value >= 0 and
       (.[3].value | floor) == .[3].value then
      ["scale",(.[3].value | tostring),""]
    elif length == 5 and (.[3] | added_receipt) != null and
         .[4].op == "replace" and .[4].path == "/spec/replicas" and
         (.[4].value | type) == "number" and .[4].value >= 0 and
         (.[4].value | floor) == .[4].value then
      ["resume",(.[4].value | tostring),(.[3] | added_receipt)]
    elif length == 5 and .[3].op == "test" and
         .[3].path == "/metadata/annotations/yenhubs.org~1checkpoint-resume-operation" and
         (.[3].value | type) == "string" and
         .[4].op == "replace" and .[4].path == "/spec/replicas" and
         (.[4].value | type) == "number" and .[4].value >= 0 and
         (.[4].value | floor) == .[4].value then
      ["resume-existing",(.[4].value | tostring),.[3].value]
    elif length == 5 and .[3].op == "test" and
         .[3].path == "/metadata/annotations/yenhubs.org~1checkpoint-resume-operation" and
         (.[3].value | type) == "string" and
         .[4] == {op:"remove",path:"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"}
    then ["cleanup",($current | tostring),.[3].value]
    else empty end | @tsv
  ' <<<"$patch_json")" || exit 1
  IFS=$'\t' read -r patch_kind replicas resume_receipt <<<"$patch_contract"
  receipt_file="$STUB_STATE_DIR/checkpoint-resume-receipt-$deployment"
  if [[ "$patch_kind" == receipt || "$patch_kind" == resume ||
        "$patch_kind" == resume-existing || "$patch_kind" == cleanup ]]; then
    [[ "$resume_receipt" =~ ^[a-f0-9]{32}$ ]] || exit 1
  fi
  if [[ "$patch_kind" == receipt || "$patch_kind" == resume ]]; then
    [[ ! -e "$receipt_file" ]] || exit 1
  elif [[ "$patch_kind" == resume-existing || "$patch_kind" == cleanup ]]; then
    [[ -f "$receipt_file" && "$(cat "$receipt_file")" == "$resume_receipt" ]] || exit 1
  fi
  if [[ "${STUB_MODE:-}" == prepare-parent-scale-fail &&
        "$deployment" == bot-orchestrator && "$replicas" == 0 ]]; then
    exit 1
  fi
  if [[ "$patch_kind" == rolling-scale &&
        "$deployment" == bot-orchestrator && "$current:$replicas" == 0:1 ]]; then
    case "${STUB_MODE:-}" in
      rolling-resume-uncommitted-lost)
        : >"$STUB_STATE_DIR/rolling-resume-uncommitted-lost"
        exit 1
        ;;
      rolling-resume-ambiguous-lost)
        : >"$STUB_STATE_DIR/rolling-resume-ambiguous-lost"
        exit 1
        ;;
    esac
  fi
  if [[ "$replicas" == 1 && -n "${STUB_CHECKPOINT_OUTPUT_PATH:-}" ]]; then
    if [[ -d "$STUB_CHECKPOINT_OUTPUT_PATH" &&
          ! -e "$STUB_CHECKPOINT_OUTPUT_PATH/.yenhubs-incomplete" &&
          -s "$STUB_CHECKPOINT_OUTPUT_PATH/SHA256SUMS" &&
          -s "$STUB_CHECKPOINT_OUTPUT_PATH/checkpoint-metadata.json" ]]; then
      : >"$STUB_STATE_DIR/checkpoint-publication-before-resume"
    else
      : >"$STUB_STATE_DIR/checkpoint-resume-before-publication"
    fi
  fi
  printf '%s' "$replicas" >"$replica_file"
  printf '%s' "$((rv_number + 1))" >"$rv_file"
  if [[ "$replicas" != "$current" ]]; then
    generation=$((generation + 1))
  fi
  printf '%s' "$generation" >"$generation_file"
  if [[ "${STUB_MODE:-}" == rolling-resume-committed-lost &&
        "$patch_kind" == rolling-scale && "$deployment" == bot-orchestrator &&
        "$current:$replicas" == 0:1 &&
        ! -e "$STUB_STATE_DIR/rolling-resume-reconcile-seen" ]]; then
    : >"$STUB_STATE_DIR/rolling-resume-reconcile-pending"
    exit 1
  fi
  if [[ "$deployment" == bot-orchestrator ]]; then
    max_parent_pods=0
    [[ ! -f "$STUB_STATE_DIR/max-pods-bot-orchestrator" ]] ||
      max_parent_pods="$(cat "$STUB_STATE_DIR/max-pods-bot-orchestrator")"
    if ((replicas > max_parent_pods)); then
      printf '%s' "$replicas" >"$STUB_STATE_DIR/max-pods-bot-orchestrator"
    fi
  fi
  if [[ "$patch_kind" == receipt || "$patch_kind" == resume ]]; then
    if [[ "${STUB_MODE:-}" == checkpoint-resume-external-without-receipt &&
          "$deployment" == bot-orchestrator &&
          ! -e "$STUB_STATE_DIR/checkpoint-resume-external-emitted" ]]; then
      : >"$STUB_STATE_DIR/checkpoint-resume-external-emitted"
    elif [[ "${STUB_MODE:-}" == checkpoint-resume-wrong-receipt &&
            "$deployment" == bot-orchestrator &&
            ! -e "$STUB_STATE_DIR/checkpoint-resume-wrong-emitted" ]]; then
      printf 'ffffffffffffffffffffffffffffffff' >"$receipt_file"
      : >"$STUB_STATE_DIR/checkpoint-resume-wrong-emitted"
    else
      printf '%s' "$resume_receipt" >"$receipt_file"
    fi
  elif [[ "$patch_kind" == cleanup ]]; then
    rm -f -- "$receipt_file"
  fi
  case "$patch_kind:$deployment" in
    receipt:reticulum)
      checkpoint_receipt_record_once patch-receipt 'PATCH_RECEIPT' || :
      ;;
    resume-existing:reticulum)
      checkpoint_receipt_record_once scale-reticulum-receipt \
        'SCALE_RETICULUM_WITH_RECEIPT' || :
      ;;
    cleanup:reticulum)
      checkpoint_receipt_record_once clear-reticulum-receipt \
        'CLEAR_RETICULUM_RECEIPT' || :
      ;;
    scale:*)
      if [[ "$replicas" == 1 ]]; then
        checkpoint_receipt_record_once "scale-other-$deployment" \
          "SCALE_OTHER_$deployment" || :
      fi
      ;;
  esac
  if [[ "${STUB_MODE:-}" == legacy-receipt-signal-after &&
        "$patch_kind" == receipt && "$deployment" == reticulum ]] &&
     mkdir "$STUB_STATE_DIR/checkpoint-receipt-signal-after" 2>/dev/null; then
    checkpoint_receipt_trace 'SIGNAL_AFTER_RECEIPT'
    kill -TERM "${STUB_RESTORE_DRIVER_PID:?}"
  fi
  if [[ "${STUB_MODE:-}" == legacy-receipt-publish-lost &&
        "$patch_kind" == receipt && "$deployment" == reticulum ]] &&
     mkdir "$STUB_STATE_DIR/checkpoint-receipt-publish-lost" 2>/dev/null; then
    checkpoint_receipt_trace 'PUBLISH_RESPONSE_LOST'
    exit 1
  fi
  if [[ "${STUB_MODE:-}" == legacy-receipt-scale-lost &&
        "$patch_kind" == resume-existing && "$deployment" == reticulum ]] &&
     mkdir "$STUB_STATE_DIR/checkpoint-receipt-scale-lost" 2>/dev/null; then
    checkpoint_receipt_trace 'SCALE_RESPONSE_LOST'
    exit 1
  fi
  if [[ "${STUB_MODE:-}" == legacy-receipt-clear-lost &&
        "$patch_kind" == cleanup && "$deployment" == reticulum ]] &&
     mkdir "$STUB_STATE_DIR/checkpoint-receipt-clear-lost" 2>/dev/null; then
    checkpoint_receipt_trace 'CLEAR_RESPONSE_LOST'
    exit 1
  fi
  if [[ "$patch_kind" == scale && "$replicas" == 0 ]]; then
    if [[ "${STUB_MODE:-}" == checkpoint-quiesce-bot-lost-response &&
          "$deployment" == bot-orchestrator &&
          ! -e "$STUB_STATE_DIR/checkpoint-quiesce-bot-lost-response" ]]; then
      : >"$STUB_STATE_DIR/checkpoint-quiesce-bot-lost-response"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == checkpoint-quiesce-reticulum-lost-response &&
          "$deployment" == reticulum &&
          ! -e "$STUB_STATE_DIR/checkpoint-quiesce-reticulum-lost-response" ]]; then
      : >"$STUB_STATE_DIR/checkpoint-quiesce-reticulum-lost-response"
      exit 1
    fi
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-local-input-mutation &&
        "$deployment" == bot-orchestrator && "$replicas" == 0 ]]; then
    [[ -n "${STUB_MUTABLE_VALUES_PATH:-}" &&
       -n "${STUB_MUTABLE_MANIFEST_PATH:-}" &&
       -n "${STUB_MUTABLE_KEY_PATH:-}" ]] || exit 1
    printf '%s\n' 'invalid: [' >"$STUB_MUTABLE_VALUES_PATH"
    printf '%s\n' 'tampered-after-fence' >"$STUB_MUTABLE_MANIFEST_PATH"
    printf '%s\n' 'fixture-rotated-cutover-key-at-least-32-bytes' \
      >"$STUB_MUTABLE_KEY_PATH"
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-resume-lost-response &&
        "$patch_kind" == resume && "$deployment" == bot-orchestrator &&
        ! -e "$STUB_STATE_DIR/checkpoint-resume-lost-response" ]]; then
    : >"$STUB_STATE_DIR/checkpoint-resume-lost-response"
    exit 1
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-resume-postcheck-lost &&
        "$patch_kind" == resume && "$deployment" == bot-orchestrator &&
        ! -e "$STUB_STATE_DIR/checkpoint-resume-postcheck-lost" ]]; then
    : >"$STUB_STATE_DIR/checkpoint-resume-postcheck-pending"
  fi
  if [[ ( "${STUB_MODE:-}" == checkpoint-resume-external-without-receipt &&
          -e "$STUB_STATE_DIR/checkpoint-resume-external-emitted" ) ||
        ( "${STUB_MODE:-}" == checkpoint-resume-wrong-receipt &&
          -e "$STUB_STATE_DIR/checkpoint-resume-wrong-emitted" ) ]] &&
     [[ "$patch_kind" == resume && "$deployment" == bot-orchestrator ]]; then
    exit 1
  fi
  if [[ "${STUB_MODE:-}" == checkpoint-resume-cleanup-lost-response &&
        "$patch_kind" == cleanup && "$deployment" == bot-orchestrator &&
        ! -e "$STUB_STATE_DIR/checkpoint-resume-cleanup-lost-response" ]]; then
    printf '%s\n' "$deployment" \
      >"$STUB_STATE_DIR/checkpoint-resume-cleanup-lost-response"
    exit 1
  fi
  emit_stub_deployment_json "$deployment"
  exit 0
fi
if [[ "$joined" == "replace --dry-run=server -f - -o json" ]]; then
  jq -c 'del(.status)'
  exit 0
fi
if [[ "$joined" == "create --dry-run=server -f - -o json" ]]; then
  dry_run_input="$(cat)"
  dry_run_kind="$(jq -r '.kind // ""' <<<"$dry_run_input")"
  case "$dry_run_kind" in
    ValidatingAdmissionPolicy)
      dry_run_match_policy=Equivalent
      [[ "${STUB_MODE:-}" != freeze-fence-dry-run-policy-drift ]] || \
        dry_run_match_policy=Exact
      jq -c --arg match_policy "$dry_run_match_policy" '
        .spec.matchConstraints.matchPolicy = $match_policy |
        .spec.matchConstraints.namespaceSelector = {} |
        .spec.matchConstraints.objectSelector = {} |
        .spec.paramKind = null |
        .spec.validations |= map(.reason = null)
      ' <<<"$dry_run_input"
      ;;
    ValidatingAdmissionPolicyBinding)
      dry_run_object_selector='{}'
      [[ "${STUB_MODE:-}" != freeze-fence-dry-run-binding-drift ]] || \
        dry_run_object_selector='{ "matchLabels": { "fixture": "true" } }'
      jq -c --argjson object_selector "$dry_run_object_selector" '
        .spec.matchResources.matchPolicy = "Equivalent" |
        .spec.matchResources.objectSelector = $object_selector
      ' <<<"$dry_run_input"
      ;;
    *) exit 1 ;;
  esac
  exit $?
fi
if [[ "$joined" == "get validatingadmissionpolicy freeze-checkpoint-pod-create-fence.yenhubs.org --ignore-not-found -o json" ||
      "$joined" == "get validatingadmissionpolicy freeze-checkpoint-pod-create-fence.yenhubs.org -o json" ]]; then
  if [[ "${STUB_MODE:-}" == freeze-fence-preexisting &&
        "$joined" == *" --ignore-not-found "* &&
        ! -f "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" ]]; then
    printf '%s' '{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingAdmissionPolicy","metadata":{"name":"freeze-checkpoint-pod-create-fence.yenhubs.org","uid":"foreign","resourceVersion":"foreign"},"spec":{}}'
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == freeze-fence-policy-aba &&
        "$joined" != *" --ignore-not-found "* &&
        -f "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" ]]; then
    freeze_fence_policy_get_count="$STUB_STATE_DIR/freeze-fence-policy-live-get-count"
    freeze_fence_policy_gets="$(cat "$freeze_fence_policy_get_count" \
      2>/dev/null || printf 0)"
    freeze_fence_policy_gets=$((freeze_fence_policy_gets + 1))
    printf '%s' "$freeze_fence_policy_gets" >"$freeze_fence_policy_get_count"
    if [[ "$freeze_fence_policy_gets" -ge 2 ]]; then
      jq -c '.metadata.uid="freeze-fence-policy-replacement-uid" |
        .metadata.resourceVersion="freeze-fence-policy-rv-2"' \
        "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" \
        >"$STUB_STATE_DIR/freeze-checkpoint-fence-policy.next"
      mv "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.next" \
        "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json"
    fi
  fi
  if [[ "${STUB_MODE:-}" == freeze-fence-policy-create-get-failure &&
        -f "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" ]]; then
    exit 1
  fi
  [[ -f "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" ]] || {
    [[ "$joined" == *" --ignore-not-found "* ]] && exit 0
    exit 1
  }
  jq -c . "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json"
  exit 0
fi
if [[ "$joined" == "get validatingadmissionpolicybinding freeze-checkpoint-pod-create-fence.yenhubs.org --ignore-not-found -o json" ||
      "$joined" == "get validatingadmissionpolicybinding freeze-checkpoint-pod-create-fence.yenhubs.org -o json" ]]; then
  if [[ "${STUB_MODE:-}" == freeze-fence-partial-preexisting &&
        "$joined" == *" --ignore-not-found "* &&
        ! -f "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" ]]; then
    printf '%s' '{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingAdmissionPolicyBinding","metadata":{"name":"freeze-checkpoint-pod-create-fence.yenhubs.org","uid":"foreign","resourceVersion":"foreign"},"spec":{}}'
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == freeze-fence-binding-drift &&
        -f "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" ]]; then
    jq -c '.spec.validationActions=["Warn"]' \
      "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json"
    exit 0
  fi
  if [[ "${STUB_MODE:-}" == freeze-fence-binding-create-get-failure &&
        -f "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" ]]; then
    exit 1
  fi
  [[ -f "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" ]] || {
    [[ "$joined" == *" --ignore-not-found "* ]] && exit 0
    exit 1
  }
  jq -c . "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json"
  exit 0
fi
if [[ "$joined" == "create --dry-run=server -f -" ]]; then
  recovery_probe_payload="$(mktemp "$STUB_STATE_DIR/recovery-fence-probe.XXXXXX")"
  trap 'rm -f -- "$recovery_probe_payload"' EXIT
  cat >"$recovery_probe_payload"
  recovery_probe_namespace="$(jq -er '.metadata.namespace' "$recovery_probe_payload")"
  if [[ -f "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" &&
        "$recovery_probe_namespace" == hcce ]]; then
    if jq -e '
      .metadata.name == ("ret-storage-backup-" +
        .metadata.labels["yenhubs.org/operation-id"][0:12]) and
      .metadata.labels["yenhubs.org/recovery-owner"] == "ret-storage-backup" and
      .metadata.annotations["yenhubs.org/operation-id"] ==
        .metadata.labels["yenhubs.org/operation-id"] and
      .spec.automountServiceAccountToken == false and
      (.spec.containers | length) == 1 and (.spec.initContainers // [] | length) == 0 and
      (.spec.ephemeralContainers // [] | length) == 0 and
      .spec.containers[0].command == ["sh","-c","sleep 3600"] and
      .spec.containers[0].securityContext.readOnlyRootFilesystem == true and
      .spec.volumes == [{name:"storage",persistentVolumeClaim:{claimName:"ret-pvc",readOnly:true}}] and
      .spec.containers[0].volumeMounts == [{name:"storage",mountPath:"/storage",readOnly:true}]
    ' >/dev/null "$recovery_probe_payload"; then
      jq -c . "$recovery_probe_payload"
      exit 0
    fi
    printf '%s: %s\n' freeze-checkpoint-pod-create-fence.yenhubs.org \
      'freeze checkpoint Pod fence denies this Pod mutation' >&2
    exit 1
  fi
  recovery_probe_state=active
  [[ ! -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" ]] ||
    recovery_probe_state="$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")"
  if [[ "$recovery_probe_state" == dormant ]]; then
    jq -c . "$recovery_probe_payload"
    exit 0
  fi
  if [[ "$recovery_probe_namespace" == hcce ]]; then
    printf '%s: %s\n' recovery-operation-pod-fence.yenhubs.org \
      'recovery operation Pod fence denies database-writer Pod creation while checkpoint or restore is fenced' >&2
  elif [[ "$recovery_probe_namespace" == hcce-bot-runners ]]; then
    printf '%s: %s\n' recovery-operation-pod-fence.yenhubs.org \
      'recovery operation Pod fence denies runner Pod mutation while checkpoint or restore is fenced' >&2
  else
    exit 91
  fi
  exit 1
fi
if [[ "$joined" == "replace -f - -o json" ]]; then
  replace_payload="$(mktemp "$STUB_STATE_DIR/replace-payload.XXXXXX")"
  trap 'rm -f -- "$replace_payload"' EXIT
  cat >"$replace_payload"
  if [[ "${STUB_DEBUG_REPLACE:-0}" == 1 ]]; then
    printf 'stub replace kind=%s name=%s\n' \
      "$(jq -r '.kind // ""' "$replace_payload")" \
      "$(jq -r '.metadata.name // ""' "$replace_payload")" >&2
  fi
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
    (
      lease_fixture_lock_held=false
      for _ in {1..300}; do
        if ! lease_fixture_lock_try_acquire; then
          sleep 0.01
          continue
        fi
        if ! lease_fixture_handoff_pending; then
          lease_fixture_lock_held=true
          break
        fi
        lease_fixture_lock_release || exit 1
        sleep 0.01
      done
      [[ "$lease_fixture_lock_held" == true ]] || exit 1
      trap lease_fixture_lock_release EXIT
      [[ -f "$STUB_STATE_DIR/serialization-lease.json" ]] || exit 1
      [[ "${STUB_MODE:-}" != lease-cas-conflict ]] || exit 1
      current_uid="$(jq -er '.metadata.uid' \
        "$STUB_STATE_DIR/serialization-lease.json")"
      current_rv="$(jq -er '.metadata.resourceVersion' \
        "$STUB_STATE_DIR/serialization-lease.json")"
      [[ "$(jq -er '.metadata.uid' "$replace_payload")" == "$current_uid" &&
         "$(jq -er '.metadata.resourceVersion' "$replace_payload")" == \
           "$current_rv" ]] || exit 1
      lease_rv_number=1
      [[ ! "$current_rv" =~ ^lease-rv-([0-9]+)$ ]] ||
        lease_rv_number="${BASH_REMATCH[1]}"
      lease_rv_number=$((lease_rv_number + 1))
      jq -c --arg uid "$current_uid" --arg rv "lease-rv-$lease_rv_number" \
        '.metadata.uid = $uid | .metadata.resourceVersion = $rv' \
        "$replace_payload" >"$STUB_STATE_DIR/serialization-lease.next"
      mv "$STUB_STATE_DIR/serialization-lease.next" \
        "$STUB_STATE_DIR/serialization-lease.json"
      cat "$STUB_STATE_DIR/serialization-lease.json"
    )
    exit $?
  fi
  if [[ "$(jq -r '.kind // ""' "$replace_payload")" == \
        ValidatingAdmissionPolicyBinding &&
        "$(jq -r '.metadata.name // ""' "$replace_payload")" == \
        recovery-operation-pod-fence.yenhubs.org ]]; then
    recovery_binding_replace_count=0
    [[ ! -f "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count" ]] ||
      recovery_binding_replace_count="$(cat \
        "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count")"
    recovery_binding_replace_count=$((recovery_binding_replace_count + 1))
    printf '%s' "$recovery_binding_replace_count" \
      >"$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count"
    cp "$replace_payload" \
      "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-payload.json"
    [[ -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" &&
       -f "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" ]] || exit 1
    [[ "${STUB_MODE:-}" != recovery-fence-cas-conflict ]] || exit 1
    recovery_binding_rv="$(cat \
      "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")"
    [[ "$(jq -er '.metadata.uid' "$replace_payload")" == \
         recovery-operation-fence-binding-uid &&
       "$(jq -er '.metadata.resourceVersion' "$replace_payload")" == \
         "$recovery_binding_rv" ]] || exit 1
    recovery_binding_state="$(jq -er '
      .spec.matchResources.namespaceSelector.matchExpressions as $expressions |
      if $expressions == [{key:"kubernetes.io/metadata.name",
          operator:"DoesNotExist"}] then "dormant"
      elif $expressions == [{key:"kubernetes.io/metadata.name",operator:"In",
          values:["hcce","hcce-bot-runners"]}] then "active"
      else error("state") end
    ' "$replace_payload")" || exit 1
    recovery_binding_rv_number=1
    [[ ! "$recovery_binding_rv" =~ -rv-([0-9]+)$ ]] ||
      recovery_binding_rv_number="${BASH_REMATCH[1]}"
    recovery_binding_rv_number=$((recovery_binding_rv_number + 1))
    recovery_binding_next_rv="recovery-operation-fence-binding-rv-$recovery_binding_rv_number"
    printf '%s' "$recovery_binding_state" \
      >"$STUB_STATE_DIR/recovery-operation-fence-binding-state"
    printf '%s' "$recovery_binding_next_rv" \
      >"$STUB_STATE_DIR/recovery-operation-fence-binding-rv"
    if [[ "${STUB_MODE:-}" == recovery-fence-aba-after-replace ]]; then
      printf '%s' recovery-operation-fence-binding-rv-99 \
        >"$STUB_STATE_DIR/recovery-operation-fence-binding-rv"
    fi
    jq -c --arg rv "$recovery_binding_next_rv" \
      '.metadata.resourceVersion = $rv' "$replace_payload"
    exit 0
  fi
  if [[ "$(jq -r '.kind // ""' "$replace_payload")" == Role ]]; then
    cp "$replace_payload" "$STUB_STATE_DIR/runner-role-replace-payload.json"
    if [[ "${STUB_MODE:-}" == restore-role-replace-retry &&
          ! -e "$STUB_STATE_DIR/role-replace-failed-once" ]]; then
      : >"$STUB_STATE_DIR/role-replace-failed-once"
      exit 1
    fi
    current_role_uid=runner-role-uid
    current_role_rv_number=1
    [[ ! -f "$STUB_STATE_DIR/runner-role-uid" ]] || current_role_uid="$(cat "$STUB_STATE_DIR/runner-role-uid")"
    [[ ! -f "$STUB_STATE_DIR/runner-role-rv" ]] || current_role_rv_number="$(cat "$STUB_STATE_DIR/runner-role-rv")"
    if [[ "${STUB_MODE:-}" == finalizer-role-cas-replaced &&
          ! -e "$STUB_STATE_DIR/finalizer-role-cas-triggered" ]]; then
      : >"$STUB_STATE_DIR/finalizer-role-cas-triggered"
      current_role_uid=replacement-runner-role-uid
      printf '%s' "$current_role_uid" >"$STUB_STATE_DIR/runner-role-uid"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == finalizer-role-cas-drift &&
          ! -e "$STUB_STATE_DIR/finalizer-role-cas-triggered" ]]; then
      : >"$STUB_STATE_DIR/finalizer-role-cas-triggered"
      current_role_rv_number=$((current_role_rv_number + 1))
      printf '%s' "$current_role_rv_number" >"$STUB_STATE_DIR/runner-role-rv"
      exit 1
    fi
    [[ "$(jq -er '.metadata.uid' "$replace_payload")" == "$current_role_uid" &&
       "$(jq -er '.metadata.resourceVersion' "$replace_payload")" == \
         "runner-role-rv-$current_role_rv_number" ]] || exit 1
    current_role_rv_number=$((current_role_rv_number + 1))
    printf '%s' "$current_role_uid" >"$STUB_STATE_DIR/runner-role-uid"
    printf '%s' "$current_role_rv_number" >"$STUB_STATE_DIR/runner-role-rv"
    jq -c '.rules' "$replace_payload" >"$STUB_STATE_DIR/runner-role-rules.json"
    jq -r '.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"]' \
      "$replace_payload" >"$STUB_STATE_DIR/runner-role-phase"
    if [[ "${STUB_MODE:-}" == finalizer-role-lost-response &&
          ! -e "$STUB_STATE_DIR/finalizer-role-lost-response" ]]; then
      : >"$STUB_STATE_DIR/finalizer-role-lost-response"
      exit 1
    fi
    jq -c --arg rv "runner-role-rv-$current_role_rv_number" \
      '.metadata.resourceVersion = $rv' "$replace_payload"
    exit 0
  fi
  [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] || exit 1
  cp "$replace_payload" "$STUB_STATE_DIR/restore-lock-replace-payload.json"
  current_uid="$(cat "$STUB_STATE_DIR/restore-lock-uid")"
  current_rv="$(cat "$STUB_STATE_DIR/restore-lock-rv")"
  [[ "$(jq -er '.metadata.uid' "$replace_payload")" == "$current_uid" &&
     "$(jq -er '.metadata.resourceVersion' "$replace_payload")" == "$current_rv" &&
     "$(jq -er '.metadata.annotations["yenhubs.org/recovery-state"]' "$replace_payload")" == \
       restore-complete-awaiting-reactivation ]] || exit 1
  printf '%s\n' 'fixture:restore-lock-cas-replace' >>"$KUBECTL_LOG"
  awk '
    /yenhubs.org\/recovery-state:/ {
      print "    yenhubs.org/recovery-state: \"restore-complete-awaiting-reactivation\""
      next
    }
    {print}
  ' "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
  mv "$STUB_STATE_DIR/restore-lock.next" "$STUB_STATE_DIR/restore-lock.yaml"
  if [[ "${STUB_MODE:-}" == restore-lock-cas-no-rv-advance ]]; then
    jq -c --arg rv "$current_rv" '.metadata.resourceVersion = $rv' \
      "$replace_payload"
    exit 0
  fi
  printf '%s' lock-rv-2 >"$STUB_STATE_DIR/restore-lock-rv"
  if [[ "${STUB_MODE:-}" == \
        restore-fence-identity-drift-after-lock-cas ]]; then
    printf '%s' recovery-operation-fence-binding-rv-99 \
      >"$STUB_STATE_DIR/recovery-operation-fence-binding-rv"
  fi
  jq -c '.metadata.resourceVersion = "lock-rv-2"' "$replace_payload"
  exit 0
fi
if [[ "$joined" == "create -f - -o json" ]]; then
  create_input="$STUB_STATE_DIR/create-input.yaml"
  cat >"$create_input"
  create_kind="$(jq -r '.kind // ""' "$create_input" 2>/dev/null || :)"
  if [[ "$create_kind" == ValidatingAdmissionPolicy ||
        "$create_kind" == ValidatingAdmissionPolicyBinding ]]; then
    if [[ "$create_kind" == ValidatingAdmissionPolicy ]]; then
      freeze_fence_state="$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json"
      freeze_fence_create_count="$STUB_STATE_DIR/freeze-fence-policy-create-count"
      freeze_fence_uid=freeze-fence-policy-uid
      freeze_fence_rv=freeze-fence-policy-rv-1
    else
      freeze_fence_state="$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json"
      freeze_fence_create_count="$STUB_STATE_DIR/freeze-fence-binding-create-count"
      freeze_fence_uid=freeze-fence-binding-uid
      freeze_fence_rv=freeze-fence-binding-rv-1
    fi
    printf '%s' "$(( $(cat "$freeze_fence_create_count" 2>/dev/null || printf 0) + 1 ))" \
      >"$freeze_fence_create_count"
    [[ ! -e "$freeze_fence_state" ]] || exit 1
    jq -c --arg uid "$freeze_fence_uid" --arg rv "$freeze_fence_rv" '
      .metadata.uid=$uid | .metadata.resourceVersion=$rv |
      .metadata.generation=1 |
      if .kind == "ValidatingAdmissionPolicy" then
        .status={observedGeneration:1} else . end
    ' "$create_input" >"$freeze_fence_state"
    if [[ "${STUB_MODE:-}" == freeze-fence-create-signal &&
          "$create_kind" == ValidatingAdmissionPolicy ]]; then
      : >"$STUB_STATE_DIR/freeze-fence-create-signal-ready"
      : >"$STUB_STATE_DIR/freeze-fence-create-signal-sent"
      kill -TERM "${STUB_CHECKPOINT_DRIVER_PID:?}"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == freeze-fence-policy-create-lost &&
          "$create_kind" == ValidatingAdmissionPolicy ]] ||
       [[ "${STUB_MODE:-}" == freeze-fence-binding-create-lost &&
          "$create_kind" == ValidatingAdmissionPolicyBinding ]]; then
      exit 1
    fi
    cat "$freeze_fence_state"
    exit 0
  fi
  if grep -q '^kind: Lease$' "$create_input"; then
    lease_create_payload="$STUB_STATE_DIR/serialization-lease-create.yaml"
    mv "$create_input" "$lease_create_payload"
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
  create_count_file="$STUB_STATE_DIR/create-count"
  create_count=0
  [[ ! -f "$create_count_file" ]] || create_count="$(cat "$create_count_file")"
  create_count=$((create_count + 1))
  printf '%s' "$create_count" >"$create_count_file"
  create_payload="$STUB_STATE_DIR/create-payload-$create_count.yaml"
  mv "$create_input" "$create_payload"
  if grep -q '^kind: NetworkPolicy$' "$create_payload"; then
    [[ ! -e "$STUB_STATE_DIR/network-policy.yaml" ]] || exit 1
    cp "$create_payload" "$STUB_STATE_DIR/network-policy.yaml"
    yaml_field '^[[:space:]]+name:' "$create_payload" \
      >"$STUB_STATE_DIR/network-policy-name"
    printf '%s' network-policy-uid >"$STUB_STATE_DIR/network-policy-uid"
    printf '%s' network-policy-rv-1 >"$STUB_STATE_DIR/network-policy-rv"
    if [[ "${STUB_MODE:-}" == helper-policy-create-decoy ]]; then
      sed -E \
        's#(yenhubs.org/operation-token: )"[a-f0-9]{32}"#\1"ffffffffffffffffffffffffffffffff"#' \
        "$STUB_STATE_DIR/network-policy.yaml" \
        >"$STUB_STATE_DIR/network-policy.next"
      mv "$STUB_STATE_DIR/network-policy.next" \
        "$STUB_STATE_DIR/network-policy.yaml"
      : >"$STUB_STATE_DIR/helper-policy-create-decoy"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == helper-policy-create-lost-response ]]; then
      : >"$STUB_STATE_DIR/helper-policy-create-lost-response"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == helper-policy-create-signal ]]; then
      : >"$STUB_STATE_DIR/helper-policy-create-signal-ready"
      trap 'exit 130' INT
      trap 'exit 143' TERM
      while :; do sleep 1; done
    fi
    emit_created_storage_network_policy
    exit 0
  fi
  if grep -q '^kind: Pod$' "$create_payload"; then
    [[ "${STUB_MODE:-}" != "restore-pod-already-exists" &&
       ! -e "$STUB_STATE_DIR/storage-helper-pod-live.json" ]] || exit 1
    cp "$create_payload" "$STUB_STATE_DIR/applied.yaml"
    yaml_field '^[[:space:]]+name:' "$create_payload" >"$STUB_STATE_DIR/pod-name"
    printf '%s' restore-pod-uid >"$STUB_STATE_DIR/pod-uid"
    printf '%s' restore-pod-rv-1 >"$STUB_STATE_DIR/pod-rv"
    if [[ "${STUB_MODE:-}" == helper-pod-create-decoy ]]; then
      sed -E \
        's#(yenhubs.org/operation-token: )"[a-f0-9]{32}"#\1"ffffffffffffffffffffffffffffffff"#' \
        "$STUB_STATE_DIR/applied.yaml" >"$STUB_STATE_DIR/applied.next"
      mv "$STUB_STATE_DIR/applied.next" "$STUB_STATE_DIR/applied.yaml"
    fi
    publish_created_storage_helper_pod_snapshot || exit 1
    : >"$STUB_STATE_DIR/pod-created"
    if [[ "${STUB_MODE:-}" == helper-pod-create-decoy ]]; then
      : >"$STUB_STATE_DIR/helper-pod-create-decoy"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == helper-pod-create-lost-response ]]; then
      : >"$STUB_STATE_DIR/helper-pod-create-lost-response"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == helper-pod-create-signal ]]; then
      : >"$STUB_STATE_DIR/helper-pod-create-signal-ready"
      trap 'exit 130' INT
      trap 'exit 143' TERM
      while :; do sleep 1; done
    fi
    read_created_storage_helper_pod_snapshot
    exit 0
  fi
  exit 1
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
    if [[ "${STUB_MODE:-}" == checkpoint-lock-create-wrong-token ]]; then
      sed -E 's#(yenhubs.org/recovery-token: )"[a-f0-9]{32}"#\1"ffffffffffffffffffffffffffffffff"#' \
        "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
      mv "$STUB_STATE_DIR/restore-lock.next" "$STUB_STATE_DIR/restore-lock.yaml"
      : >"$STUB_STATE_DIR/checkpoint-lock-create-wrong-token"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == checkpoint-lock-create-competitor ]]; then
      sed -E \
        -e 's#(yenhubs.org/operation-id: )"[a-f0-9]{32}"#\1"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"#' \
        -e 's#(yenhubs.org/recovery-token: )"[a-f0-9]{32}"#\1"ffffffffffffffffffffffffffffffff"#' \
        "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
      mv "$STUB_STATE_DIR/restore-lock.next" "$STUB_STATE_DIR/restore-lock.yaml"
      : >"$STUB_STATE_DIR/checkpoint-lock-create-competitor"
      exit 1
    fi
    if [[ "${STUB_MODE:-}" == checkpoint-lock-create-lost-response ]]; then
      : >"$STUB_STATE_DIR/checkpoint-lock-create-lost-response"
      exit 1
    fi
  elif grep -q '^kind: NetworkPolicy$' "$create_payload"; then
    [[ ! -e "$STUB_STATE_DIR/network-policy.yaml" ]] || exit 1
    cp "$create_payload" "$STUB_STATE_DIR/network-policy.yaml"
    yaml_field '^[[:space:]]+name:' "$create_payload" >"$STUB_STATE_DIR/network-policy-name"
    printf '%s' network-policy-uid >"$STUB_STATE_DIR/network-policy-uid"
    printf '%s' network-policy-rv-1 >"$STUB_STATE_DIR/network-policy-rv"
  elif grep -q '^kind: Pod$' "$create_payload"; then
    [[ "${STUB_MODE:-}" != "restore-pod-already-exists" &&
       ! -e "$STUB_STATE_DIR/storage-helper-pod-live.json" ]] || exit 1
    cp "$create_payload" "$STUB_STATE_DIR/applied.yaml"
    yaml_field '^[[:space:]]+name:' "$create_payload" >"$STUB_STATE_DIR/pod-name"
    printf '%s' restore-pod-uid >"$STUB_STATE_DIR/pod-uid"
    printf '%s' restore-pod-rv-1 >"$STUB_STATE_DIR/pod-rv"
    publish_created_storage_helper_pod_snapshot || exit 1
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
  raw_path=""
  for argument in "$@"; do [[ "$argument" != --raw=* ]] || raw_path="${argument#--raw=}"; done
  printf '%s\n' "$raw_path" >"$STUB_STATE_DIR/delete-path-$delete_count"
  chmod 600 "$STUB_STATE_DIR/delete-path-$delete_count"
  if [[ "$raw_path" == /api/v1/namespaces/hcce/pods/ret-storage-backup-* ]]; then
    jq -e '
      (keys | sort) == ["apiVersion","kind","preconditions","propagationPolicy"] and
      .apiVersion == "v1" and .kind == "DeleteOptions" and
      .propagationPolicy == "Background" and
      (.preconditions | keys) == ["uid"] and
      (.preconditions.uid | type == "string" and length > 0)
    ' >/dev/null "$delete_payload" || exit 1
  elif [[ "$raw_path" == /api/v1/namespaces/hcce-bot-runners/pods/* &&
        "$raw_path" != */pods/bot-runner-fixture ]]; then
    jq -e '
      (keys | sort) == ["apiVersion","gracePeriodSeconds","kind","preconditions","propagationPolicy"] and
      .apiVersion == "v1" and .kind == "DeleteOptions" and
      .gracePeriodSeconds == 0 and .propagationPolicy == "Background" and
      (.preconditions | keys | sort) == ["resourceVersion","uid"] and
      (.preconditions.uid | type == "string" and length > 0) and
      (.preconditions.resourceVersion | type == "string" and length > 0)
    ' >/dev/null "$delete_payload" || exit 1
  elif [[ "$raw_path" == \
      /api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock ]]; then
    jq -e '
      (keys | sort) == ["apiVersion","kind","preconditions","propagationPolicy"] and
      .apiVersion == "v1" and .kind == "DeleteOptions" and
      .propagationPolicy == "Foreground" and
      (.preconditions | keys | sort) == ["resourceVersion","uid"] and
      (.preconditions.uid | type == "string" and length > 0) and
      (.preconditions.resourceVersion | type == "string" and length > 0)
    ' >/dev/null "$delete_payload" || exit 1
  elif [[ "$raw_path" == /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/freeze-checkpoint-pod-create-fence.yenhubs.org ||
          "$raw_path" == /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/freeze-checkpoint-pod-create-fence.yenhubs.org ]]; then
    jq -e '
      (keys | sort) == ["apiVersion","kind","preconditions","propagationPolicy"] and
      .apiVersion == "v1" and .kind == "DeleteOptions" and
      .propagationPolicy == "Foreground" and
      (.preconditions | keys | sort) == ["resourceVersion","uid"] and
      all(.preconditions.uid,.preconditions.resourceVersion;
        type == "string" and length > 0)
    ' >/dev/null "$delete_payload" || exit 1
  else
    jq -e '
      (keys | sort) == ["apiVersion","kind","preconditions","propagationPolicy"] and
      .apiVersion == "v1" and .kind == "DeleteOptions" and
      .propagationPolicy == "Foreground" and
      (.preconditions | keys) == ["uid"] and
      (.preconditions.uid | type == "string" and length > 0)
    ' >/dev/null "$delete_payload" || exit 1
  fi
  expected_uid="$(jq -r '.preconditions.uid' "$delete_payload")"
  expected_resource_version="$(jq -r '.preconditions.resourceVersion // ""' \
    "$delete_payload")"
  case "$raw_path" in
    /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/freeze-checkpoint-pod-create-fence.yenhubs.org)
      [[ -f "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" &&
         "$expected_uid" == "$(jq -r '.metadata.uid' "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json")" &&
         "$expected_resource_version" == "$(jq -r '.metadata.resourceVersion' "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json")" ]] || exit 1
      if [[ "${STUB_MODE:-}" == freeze-fence-delete-ambiguous-present ]]; then
        exit 1
      fi
      if [[ "${STUB_MODE:-}" == freeze-fence-delete-signal ]]; then
        : >"$STUB_STATE_DIR/freeze-fence-delete-signal-ready"
        : >"$STUB_STATE_DIR/freeze-fence-delete-signal-sent"
        kill -TERM "${STUB_CHECKPOINT_DRIVER_PID:?}"
      fi
      mv "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" \
        "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.deleted"
      [[ "${STUB_MODE:-}" != freeze-fence-delete-committed-lost ]] || exit 1
      ;;
    /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/freeze-checkpoint-pod-create-fence.yenhubs.org)
      [[ -f "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" &&
         "$expected_uid" == "$(jq -r '.metadata.uid' "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json")" &&
         "$expected_resource_version" == "$(jq -r '.metadata.resourceVersion' "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json")" ]] || exit 1
      mv "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" \
        "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.deleted"
      [[ "${STUB_MODE:-}" != freeze-fence-delete-committed-lost ]] || exit 1
      ;;
    /api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock)
      [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] || exit 1
      current_uid="$(cat "$STUB_STATE_DIR/restore-lock-uid")"
      current_rv="$(cat "$STUB_STATE_DIR/restore-lock-rv")"
      if [[ "${STUB_MODE:-}" == "restore-lock-replaced-on-release" ]]; then
        current_uid=replacement-lock-uid
        printf '%s' "$current_uid" >"$STUB_STATE_DIR/restore-lock-uid"
      fi
      [[ "$expected_uid" == "$current_uid" &&
         "$expected_resource_version" == "$current_rv" ]] || exit 1
      rm -f -- "$STUB_STATE_DIR/restore-lock.yaml" "$STUB_STATE_DIR/restore-lock-uid" "$STUB_STATE_DIR/restore-lock-rv"
      checkpoint_receipt_record_once lock-delete 'DELETE_RESTORE_LOCK' || :
      ;;
    /api/v1/namespaces/hcce-bot-runners/pods/bot-runner-fixture)
      [[ "$expected_uid" == runner-pod-uid ]] || exit 1
      : >"$STUB_STATE_DIR/checkpoint-orphan-runner-deleted"
      ;;
    /api/v1/namespaces/hcce-bot-runners/pods/*)
      case "${STUB_RUNNER_POD_PROFILE:-}" in
        runner)
          [[ "$expected_uid" == runner-uid-1 &&
             "$expected_resource_version" == pod-rv-12 ]] || exit 1
          ;;
        intent)
          [[ "$expected_uid" == intent-uid-1 &&
             "$expected_resource_version" == pod-rv-11 ]] || exit 1
          ;;
        '')
          [[ "${STUB_MODE:-}" == checkpoint-orphan-runner &&
             "$expected_uid" == runner-uid-1 &&
             "$expected_resource_version" == pod-rv-12 ]] || exit 1
          : >"$STUB_STATE_DIR/checkpoint-orphan-runner-deleted"
          ;;
        *)
          # In particular an exact permanent fence is never a deletion target.
          : >"$STUB_STATE_DIR/runner-fence-delete-attempted"
          exit 1
          ;;
      esac
      : >"$STUB_STATE_DIR/runner-profile-deleted"
      ;;
    /api/v1/namespaces/hcce/pods/*)
      [[ -f "$STUB_STATE_DIR/storage-helper-pod-live.json" ]] || exit 1
      current_uid="$(jq -er '.metadata.uid' \
        "$STUB_STATE_DIR/storage-helper-pod-live.json")"
      [[ "$expected_uid" == "$current_uid" ]] || exit 1
      rm -f -- "$STUB_STATE_DIR/storage-helper-pod-live.json"
      if [[ "${STUB_MODE:-}" == helper-pod-list-delete-race ]]; then
        : >"$STUB_STATE_DIR/helper-pod-delete-finished"
      fi
      rm -f -- "$STUB_STATE_DIR/pod-created" "$STUB_STATE_DIR/pod-name" \
        "$STUB_STATE_DIR/pod-uid" "$STUB_STATE_DIR/pod-rv"
      ;;
    /apis/networking.k8s.io/v1/namespaces/hcce/networkpolicies/*)
      [[ -f "$STUB_STATE_DIR/network-policy.yaml" ]] || exit 1
      current_uid="$(cat "$STUB_STATE_DIR/network-policy-uid")"
      [[ "$expected_uid" == "$current_uid" ]] || exit 1
      rm -f -- "$STUB_STATE_DIR/network-policy.yaml" \
        "$STUB_STATE_DIR/network-policy-name" \
        "$STUB_STATE_DIR/network-policy-uid" "$STUB_STATE_DIR/network-policy-rv"
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
    if [[ "${STUB_MODE:-}" == freeze-fence-db-barrier-loss ]]; then
      mv "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" \
        "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.lost"
      sleep 0.08
    fi
    if [[ "${STUB_MODE:-}" == checkpoint-process-local-mode-drift ||
          "${STUB_MODE:-}" == checkpoint-writer-post-ready-excursion ||
          "${STUB_RUNNER_POD_PROFILE:-}" == fence-disappears ||
          "${STUB_RUNNER_POD_PROFILE:-}" == fence-replaced ||
          "${STUB_RUNNER_POD_PROFILE:-}" == fence-terminating ]]; then
      : >"$STUB_STATE_DIR/checkpoint-backup-complete"
    fi
    if [[ "${STUB_MODE:-}" == checkpoint-parent-writer-guard-stale ]]; then
      : >"$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-started"
      sleep 12
      : >"$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-completed"
    fi
    if [[ -n "${STUB_DB_DUMP_DELAY_SECONDS:-}" ]]; then
      : >"$STUB_STATE_DIR/db-source-monitor-stream-started"
      printf '%s' "$$" >"$STUB_STATE_DIR/db-source-monitor-stream-pid"
      case "${STUB_MODE:-}" in
        db-source-monitor-uid-drift|db-source-monitor-replacement|\
          db-source-monitor-stall)
          sleep "$STUB_DB_DUMP_DELAY_SECONDS"
          ;;
        *)
          for _ in {1..500}; do
            [[ -e "$STUB_STATE_DIR/db-source-monitor-inflight-observed" ]] && break
            sleep 0.01
          done
          [[ -e "$STUB_STATE_DIR/db-source-monitor-inflight-observed" ]] || exit 1
          ;;
      esac
      : >"$STUB_STATE_DIR/db-source-monitor-stream-completed"
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
  elif [[ "$joined" == *"tar -C /storage -cf - owned"* ]]; then
    if [[ "${STUB_MODE:-}" == freeze-fence-storage-barrier-loss ]]; then
      mv "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" \
        "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.lost"
      sleep 0.08
    fi
    if [[ "${STUB_MODE:-}" == backup-monitor-extra ]]; then
      : >"$STUB_STATE_DIR/backup-monitor-stream-started"
      sleep 0.08
    fi
    if [[ "${STUB_MODE:-}" == checkpoint-parent-writer-guard-stale ]]; then
      : >"$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-started"
      sleep 12
      : >"$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-completed"
    fi
    [[ -z "${STUB_ARCHIVE_DELAY_SECONDS:-}" ]] || sleep "$STUB_ARCHIVE_DELAY_SECONDS"
    cat "$STUB_TAR_STREAM"
  elif [[ "$joined" == *"tar -C /storage -xf -"* ]]; then
    if [[ "${STUB_MODE:-}" == restore-storage-monitor-exit ||
          "${STUB_MODE:-}" == restore-storage-monitor-stall ||
          "${STUB_MODE:-}" == checkpoint-parent-writer-guard-stale ||
          "${STUB_MODE:-}" == restore-storage-durable-capability-stream ]]; then
      run_restore_stream_fixture restore-storage-stream
    elif [[ "${STUB_MODE:-}" == runner-reappears-during-storage ]]; then
      : >"$STUB_STATE_DIR/runner-reappear"
      sleep 0.08
    elif [[ "${STUB_MODE:-}" == monitor-extra || "${STUB_MODE:-}" == restore-pod-replaced ]]; then
      sleep 0.08
    fi
    cat >/dev/null
  elif [[ "$joined" == *"psql -v ON_ERROR_STOP=1 -q"* ]]; then
    if [[ "${STUB_MODE:-}" == restore-db-monitor-exit ||
          "${STUB_MODE:-}" == restore-db-monitor-stall ||
          "${STUB_MODE:-}" == checkpoint-parent-writer-guard-stale ||
          "${STUB_MODE:-}" == restore-db-durable-capability-stream ]]; then
      run_restore_stream_fixture restore-db-stream
    else
      cat >/dev/null
    fi
  else printf '0\n'
  fi
  exit 0
fi
printf 'Unhandled kubectl stub call: %s\n' "$joined" >&2
exit 90
STUB
chmod 700 "$TMP_DIR/bin/kubectl"
cat >"$TMP_DIR/bin/kubectl-checkpoint-writer" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
export STUB_CHECKPOINT_WRITER_QUERY=1
exec "$(cd "$(dirname "$0")" && pwd -P)/kubectl" "$@"
STUB
chmod 700 "$TMP_DIR/bin/kubectl-checkpoint-writer"
cat >"$TMP_DIR/bin/doctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'kubernetes cluster get hubs-ce --context yenhubs --output json')
    case "${STUB_DOCTL_CLUSTER_HA:-false}" in
      absent)
        printf '%s\n' '{"id":"fixture-cluster-id","name":"hubs-ce","region":"ams3","node_pools":[{"size":"s-4vcpu-8gb","count":1}]}'
        ;;
      false)
        printf '%s\n' '{"id":"fixture-cluster-id","name":"hubs-ce","region":"ams3","ha":false,"node_pools":[{"size":"s-4vcpu-8gb","count":1}]}'
        ;;
      true)
        printf '%s\n' '{"id":"fixture-cluster-id","name":"hubs-ce","region":"ams3","ha":true,"node_pools":[{"size":"s-4vcpu-8gb","count":1}]}'
        ;;
      string)
        printf '%s\n' '{"id":"fixture-cluster-id","name":"hubs-ce","region":"ams3","ha":"false","node_pools":[{"size":"s-4vcpu-8gb","count":1}]}'
        ;;
      *) exit 91 ;;
    esac
    ;;
  'compute load-balancer list --context yenhubs --output json')
    printf '%s\n' '[{"id":"fixture-lb-id","type":"REGIONAL_NETWORK"}]'
    ;;
  'compute volume list --context yenhubs --output json')
    printf '%s\n' '[{"id":"fixture-pgsql-volume"},{"id":"fixture-ret-volume"}]'
    ;;
  *) printf '[]\n' ;;
esac
STUB
chmod 700 "$TMP_DIR/bin/doctl"
cat >"$TMP_DIR/bin/date" <<STUB
#!/usr/bin/env bash
set -euo pipefail
if [[ "\$#" == 1 && "\$1" == '+%Y%m%d-%H%M%S' ]]; then
  printf '%s\n' '$STAMP'
elif [[ -x /bin/date ]]; then
  exec /bin/date "\$@"
else
  exec /usr/bin/date "\$@"
fi
STUB
chmod 700 "$TMP_DIR/bin/date"
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
  `${count}\t${process.env.HCCE_INPUT_VALUES_PATH}\t${process.env.HCCE_MANIFEST_PATH}` +
    `\t${process.env.PROCESS_LOCAL_CUTOVER_KEY_PATH || ""}` +
    `\t${(fs.statSync(path.dirname(process.env.HCCE_INPUT_VALUES_PATH)).mode & 0o777).toString(8)}` +
    `\t${process.env.PROCESS_LOCAL_CUTOVER_KEY_PATH
      ? (fs.statSync(path.dirname(process.env.PROCESS_LOCAL_CUTOVER_KEY_PATH)).mode & 0o777).toString(8)
      : ""}\n`,
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
RUNNER_CHECKPOINT_HELPER_FIXTURE="$TMP_DIR/runner-checkpoint-helper.fixture.mjs"
cat >"$RUNNER_CHECKPOINT_HELPER_FIXTURE" <<'STUB'
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const helper = process.env.REAL_RUNNER_CHECKPOINT_HELPER;
const stateDirectory = process.env.STUB_STATE_DIR;
if (!helper || !stateDirectory) process.exit(2);
const result = spawnSync(process.execPath, [helper, ...process.argv.slice(2)], {
  env: process.env,
  encoding: "utf8"
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);

const modeIndex = process.argv.indexOf("--live-mode");
const liveMode = modeIndex < 0 ? "" : process.argv[modeIndex + 1];
if (liveMode === "quiesced-source") {
  const mode = process.env.STUB_MODE;
  if (mode === "prepare-lock-disappears-after-evidence") {
    for (const name of ["restore-lock.yaml", "restore-lock-uid", "restore-lock-rv"]) {
      fs.rmSync(path.join(stateDirectory, name), { force: true });
    }
  } else if (mode === "prepare-lock-replaced-after-evidence") {
    fs.writeFileSync(
      path.join(stateDirectory, "restore-lock-uid"),
      "replacement-lock-uid",
      { mode: 0o600 }
    );
  }
}
if (
  (liveMode === "quiesced-target" || liveMode === "quiesced-active-target") &&
  process.env.STUB_MODE === "clear-stale-final-evidence-drift" &&
  !fs.existsSync(path.join(stateDirectory, "pod-created")) &&
  !fs.existsSync(path.join(stateDirectory, "network-policy.yaml"))
) {
  const countPath = path.join(
    stateDirectory,
    "clear-stale-post-helper-evidence-count"
  );
  const previous = fs.existsSync(countPath)
    ? Number(fs.readFileSync(countPath, "utf8"))
    : 0;
  const count = previous + 1;
  fs.writeFileSync(countPath, String(count), { mode: 0o600 });
  if (count >= 2) {
    process.stderr.write("clear_stale_final_evidence_drift\n");
    process.exit(1);
  }
}
STUB
chmod 600 "$RUNNER_CHECKPOINT_HELPER_FIXTURE"
export REAL_RUNNER_CHECKPOINT_HELPER="$ROOT_DIR/deployment/runner-cutover-checkpoint-evidence.mjs"
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
LIVE_REACTIVATION_VERIFIER_FIXTURE="$TMP_DIR/live-reactivation-verifier.fixture.sh"
cat >"$LIVE_REACTIVATION_VERIFIER_FIXTURE" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "${EXPECTED_KUBE_CONTEXT:-}" == fixture-context &&
   "${EXPECTED_NAMESPACE_UID:-}" == fixture-uid &&
   "${EXPECTED_RET_PVC_UID:-}" == fixture-pvc-uid &&
   -f "$VALUES_FILE" && ! -L "$VALUES_FILE" &&
   -f "$HCCE_MANIFEST_PATH" && ! -L "$HCCE_MANIFEST_PATH" &&
   -f "${STUB_LIVE_REACTIVATION_MANIFEST_FILE:?}" &&
   ! -L "$STUB_LIVE_REACTIVATION_MANIFEST_FILE" ]]
cmp -s "$HCCE_MANIFEST_PATH" "$STUB_LIVE_REACTIVATION_MANIFEST_FILE"
if [[ -n "${STUB_LIVE_REACTIVATION_VALUES_CONTENT_FILE:-}" ]]; then
  [[ -f "$STUB_LIVE_REACTIVATION_VALUES_CONTENT_FILE" &&
     ! -L "$STUB_LIVE_REACTIVATION_VALUES_CONTENT_FILE" ]] &&
    cmp -s "$VALUES_FILE" "$STUB_LIVE_REACTIVATION_VALUES_CONTENT_FILE"
else
  [[ -f "${STUB_LIVE_REACTIVATION_VALUES_FILE:?}" &&
     ! -L "$STUB_LIVE_REACTIVATION_VALUES_FILE" ]] &&
    cmp -s "$VALUES_FILE" "$STUB_LIVE_REACTIVATION_VALUES_FILE"
fi
if [[ "${STUB_MODE:-}" == cold-rebind-live-verifier-fail ]]; then
  printf 'live_reactivation_verifier_failed_fixture\n' >&2
  exit 1
fi
count_path="${STUB_STATE_DIR:?}/live-reactivation-verifier-count"
count=0
[[ ! -f "$count_path" ]] || count="$(cat "$count_path")"
[[ "$count" =~ ^[0-9]+$ ]]
printf '%s' "$((count + 1))" >"$count_path.next"
chmod 600 "$count_path.next"
mv "$count_path.next" "$count_path"
printf 'live_reactivation_verified_fixture\n'
STUB
chmod 600 "$LIVE_REACTIVATION_VERIFIER_FIXTURE"
RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE="$TMP_DIR/hcce.fixture.yaml"
RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_FIXTURE="$TMP_DIR/hcce.journal-bootstrap.fixture.yaml"
RUNNER_EVIDENCE_LIVE_DIR="$TMP_DIR/runner-evidence-live"
RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE="$TMP_DIR/hcce.restore-fence.fixture.yaml"
RUNNER_RESTORE_FENCE_LIVE_DIR="$TMP_DIR/runner-evidence-live-restore-fence"
RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE="$TMP_DIR/hcce.active-target.fixture.yaml"
RUNNER_ACTIVE_TARGET_LIVE_DIR="$TMP_DIR/runner-evidence-live-active-target"
PROCESS_LOCAL_CUTOVER_KEY_PATH="$TMP_DIR/runner-cutover-owner.key"
mkdir -p "$RUNNER_EVIDENCE_LIVE_DIR" "$RUNNER_RESTORE_FENCE_LIVE_DIR" \
  "$RUNNER_ACTIVE_TARGET_LIVE_DIR"
node - "$ROOT_DIR/hubs-cloud/community-edition" \
  "$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" "$RUNNER_EVIDENCE_LIVE_DIR" \
  "$PROCESS_LOCAL_CUTOVER_KEY_PATH" "$LIVE_RUNNER_EPOCH" \
  "$RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_FIXTURE" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

const communityEdition = process.argv[2];
const manifestPath = process.argv[3];
const liveDirectory = process.argv[4];
const keyPath = process.argv[5];
const recoveryEpoch = process.argv[6];
const bootstrapManifestPath = process.argv[7];
const requireCe = createRequire(path.join(communityEdition, "package.json"));
const YAML = requireCe("yaml");
const {
  CUTOVER_JOURNAL_DATA_KEY,
  createCutoverJournal,
  cutoverJournalConfigMap,
  sha256Canonical
} = require(path.join(communityEdition, "apply/cutover-journal.js"));
const {
  ADMISSION_POLICY_NAME,
  CUTOVER_JOURNAL_POLICY_NAME,
  PARENT_FENCE_POLICY_NAME,
  RECOVERY_OPERATION_FENCE_POLICY_NAME,
  RECOVERY_PHASE_ANNOTATION,
  RUNNER_PROTOCOL_POLICY_NAME,
  readActivationPlanText
} = require(path.join(communityEdition, "apply/runner-activation.js"));

const ciInputPath = path.join(communityEdition, "input-values.ci.yaml");
const generatorInputPath = path.join(liveDirectory, "generator-input.yaml");
const input = YAML.parse(fs.readFileSync(ciInputPath, "utf8"));
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
input.PERMS_KEY = privateKey;
input.BOT_RUNNER_RECOVERY_EPOCH = recoveryEpoch;
input.BOT_RUNNER_ACTIVATION_PHASE = "active";
input.BOT_RUNNER_RECOVERY_PHASE = "active";
fs.writeFileSync(generatorInputPath, YAML.stringify(input), { mode: 0o600 });
const generated = spawnSync(process.execPath, [
  path.join(communityEdition, "generate_script/index.js")
], {
  cwd: communityEdition,
  env: {
    ...process.env,
    HCCE_INPUT_VALUES_PATH: generatorInputPath,
    HCCE_OUTPUT_PATH: manifestPath
  },
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024
});
if (generated.status !== 0) throw new Error("runner_evidence_manifest_fixture_failed");
fs.chmodSync(manifestPath, 0o600);

const bootstrapInput = structuredClone(input);
bootstrapInput.BOT_RUNNER_ACTIVATION_PHASE = "bootstrap";
bootstrapInput.BOT_RUNNER_RECOVERY_PHASE = "active";
const bootstrapInputPath = path.join(liveDirectory, "journal-bootstrap-input.yaml");
fs.writeFileSync(bootstrapInputPath, YAML.stringify(bootstrapInput), { mode: 0o600 });
const bootstrapGenerated = spawnSync(process.execPath, [
  path.join(communityEdition, "generate_script/index.js")
], {
  cwd: communityEdition,
  env: {
    ...process.env,
    HCCE_INPUT_VALUES_PATH: bootstrapInputPath,
    HCCE_OUTPUT_PATH: bootstrapManifestPath
  },
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024
});
if (bootstrapGenerated.status !== 0) {
  throw new Error(`runner_journal_bootstrap_fixture_failed:${bootstrapGenerated.stderr}`);
}
fs.chmodSync(bootstrapManifestPath, 0o600);

const manifestBytes = fs.readFileSync(manifestPath);
const plan = readActivationPlanText(manifestBytes.toString("utf8"));
const bootstrapManifestBytes = fs.readFileSync(bootstrapManifestPath);
const bootstrapPlan = readActivationPlanText(bootstrapManifestBytes.toString("utf8"));
const names = [
  ADMISSION_POLICY_NAME,
  RUNNER_PROTOCOL_POLICY_NAME,
  CUTOVER_JOURNAL_POLICY_NAME,
  PARENT_FENCE_POLICY_NAME,
  RECOVERY_OPERATION_FENCE_POLICY_NAME
];
function exactFrom(sourcePlan, apiVersion, kind, name, namespace = "") {
  const matches = sourcePlan.resources.filter(resource =>
    resource?.apiVersion === apiVersion && resource?.kind === kind &&
    resource?.metadata?.name === name &&
    (resource?.metadata?.namespace || "") === namespace
  );
  if (matches.length !== 1) throw new Error("runner_evidence_resource_fixture_failed");
  return structuredClone(matches[0]);
}
function exact(apiVersion, kind, name, namespace = "") {
  return exactFrom(plan, apiVersion, kind, name, namespace);
}
function write(name, value) {
  fs.writeFileSync(path.join(liveDirectory, name), `${JSON.stringify(value)}\n`, {
    mode: 0o600
  });
}
function liveAdmission(target, prefix, index, observed) {
  const live = structuredClone(target);
  live.metadata.uid = `${prefix}-uid-${index}`;
  live.metadata.resourceVersion = `${prefix}-rv-${index}`;
  live.metadata.creationTimestamp = "2026-07-19T00:00:00Z";
  if (observed) {
    live.metadata.generation = 1;
    live.status = { observedGeneration: 1, typeChecking: {}, conditions: [] };
  }
  return live;
}

const expectedPairs = Object.fromEntries(names.map((name, index) => {
  const policy = exact(
    "admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", name
  );
  const binding = exact(
    "admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", name
  );
  write(`policy-${name}.json`, liveAdmission(policy, "policy", index, true));
  write(`binding-${name}.json`, liveAdmission(binding, "binding", index, false));
  return [name, { policy, binding }];
}));
const parentResourceDefinitions = [
  ["service-account", "v1", "ServiceAccount", "bot-orchestrator"],
  ["role", "rbac.authorization.k8s.io/v1", "Role", "bot-orchestrator-runner-pods"],
  ["role-binding", "rbac.authorization.k8s.io/v1", "RoleBinding", "bot-orchestrator-runner-pods"]
];
for (const [slug, apiVersion, kind, name] of parentResourceDefinitions) {
  const expected = exact(apiVersion, kind, name, "hcce");
  const live = structuredClone(expected);
  live.metadata.uid = `parent-${slug}-uid`;
  live.metadata.resourceVersion = `parent-${slug}-rv`;
  live.metadata.creationTimestamp = "2026-07-19T00:00:00Z";
  write(`parent-${slug}.json`, live);
}
const runnerResourceDefinitions = [
  ["runner-pull-secret", "v1", "Secret", "bot-images-pull"],
  ["runner-service-account", "v1", "ServiceAccount", "bot-runner"],
  ["guard-service-account", "v1", "ServiceAccount", "bot-runner-guard"],
  ["runner-quota", "v1", "ResourceQuota", "bot-runner-capacity"],
  ["guard-quota", "v1", "ResourceQuota", "bot-runner-guard-capacity"],
  ["runner-default-deny", "networking.k8s.io/v1", "NetworkPolicy",
    "bot-runner-default-deny"],
  ["runner-egress", "networking.k8s.io/v1", "NetworkPolicy", "bot-runner-egress"]
];
for (const [slug, apiVersion, kind, name] of runnerResourceDefinitions) {
  const live = exact(apiVersion, kind, name, "hcce-bot-runners");
  live.metadata.uid = `${slug}-uid`;
  live.metadata.resourceVersion = `${slug}-rv-1`;
  live.metadata.creationTimestamp = "2026-07-19T00:00:00Z";
  write(`${slug}.json`, live);
}
const runnerRole = exact(
  "rbac.authorization.k8s.io/v1", "Role",
  "bot-orchestrator-runner-pods", "hcce-bot-runners"
);
runnerRole.metadata.uid = "runner-role-uid";
runnerRole.metadata.resourceVersion = "runner-role-rv-1";
runnerRole.metadata.creationTimestamp = "2026-07-19T00:00:00Z";
write("runner-role.json", runnerRole);
const runnerRoleBinding = exact(
  "rbac.authorization.k8s.io/v1", "RoleBinding",
  "bot-orchestrator-runner-pods", "hcce-bot-runners"
);
runnerRoleBinding.metadata.uid = "runner-role-binding-uid";
runnerRoleBinding.metadata.resourceVersion = "runner-role-binding-rv-1";
runnerRoleBinding.metadata.creationTimestamp = "2026-07-19T00:00:00Z";
write("runner-role-binding.json", runnerRoleBinding);
const parentTarget = exact("apps/v1", "Deployment", "bot-orchestrator", "hcce");
parentTarget.metadata.annotations = {
  ...(parentTarget.metadata.annotations || {}),
  [RECOVERY_PHASE_ANNOTATION]: "active"
};
parentTarget.spec = { ...parentTarget.spec, replicas: 0 };
const parentLive = structuredClone(parentTarget);
parentLive.metadata.uid = "uid-bot-orchestrator";
parentLive.metadata.resourceVersion = "rv-bot-orchestrator-2";
parentLive.metadata.creationTimestamp = "2026-07-19T00:00:00Z";
parentLive.metadata.generation = 1;
parentLive.status = { observedGeneration: 1, replicas: 0, readyReplicas: 0 };
write("parent-deployment.json", parentLive);

function bootstrapResource(kind, name) {
  return exactFrom(
    bootstrapPlan,
    "admissionregistration.k8s.io/v1",
    kind,
    name
  );
}
const bootstrapParentTarget = exactFrom(
  bootstrapPlan, "apps/v1", "Deployment", "bot-orchestrator", "hcce"
);
const historicalTargetHashes = {
  journalPolicy: sha256Canonical(bootstrapResource(
    "ValidatingAdmissionPolicy", CUTOVER_JOURNAL_POLICY_NAME
  )),
  journalBinding: sha256Canonical(bootstrapResource(
    "ValidatingAdmissionPolicyBinding", CUTOVER_JOURNAL_POLICY_NAME
  )),
  parentPolicy: sha256Canonical(bootstrapResource(
    "ValidatingAdmissionPolicy", PARENT_FENCE_POLICY_NAME
  )),
  parentBinding: sha256Canonical(bootstrapResource(
    "ValidatingAdmissionPolicyBinding", PARENT_FENCE_POLICY_NAME
  )),
  parentDeployment: sha256Canonical(bootstrapParentTarget)
};
const cutoverKey = crypto.randomBytes(48);
fs.writeFileSync(keyPath, cutoverKey, { mode: 0o600 });
const journal = createCutoverJournal({
  mode: "clean-install",
  operationId: "12345678-1234-4234-8234-123456789abc",
  authorization: null,
  expectedKubeContext: "fixture-context",
  namespace: "hcce",
  namespaceUid: "fixture-uid",
  baselineDeployment: null,
  manifestSha256: crypto.createHash("sha256")
    .update(bootstrapManifestBytes).digest("hex"),
  targetHashes: historicalTargetHashes,
  issuedAt: "2026-07-19T00:00:00.000Z"
}, cutoverKey);
const journalConfigMap = cutoverJournalConfigMap(journal);
journalConfigMap.metadata.uid = "cutover-journal-uid";
journalConfigMap.metadata.resourceVersion = "cutover-journal-rv";
journalConfigMap.metadata.creationTimestamp = "2026-07-19T00:00:00Z";
if (typeof journalConfigMap.data[CUTOVER_JOURNAL_DATA_KEY] !== "string") {
  throw new Error("runner_evidence_journal_fixture_failed");
}
write("cutover-journal.json", journalConfigMap);
write("namespace-kube-system.json", {
  apiVersion: "v1", kind: "Namespace",
  metadata: { name: "kube-system", uid: "fixture-cluster-anchor-uid" },
  status: { phase: "Active" }
});
write("namespace-hcce.json", {
  apiVersion: "v1", kind: "Namespace",
  metadata: { name: "hcce", uid: "fixture-uid", resourceVersion: "namespace-rv-hcce" },
  status: { phase: "Active" }
});
const runnerNamespace = exact("v1", "Namespace", "hcce-bot-runners");
runnerNamespace.metadata.uid = "fixture-runner-namespace-uid";
runnerNamespace.metadata.resourceVersion = "namespace-rv-runner";
runnerNamespace.metadata.creationTimestamp = "2026-07-19T00:00:00Z";
runnerNamespace.spec = { finalizers: ["kubernetes"] };
runnerNamespace.status = { phase: "Active" };
write("namespace-hcce-bot-runners.json", runnerNamespace);
NODE
RUNNER_ACTIVE_MANIFEST_SHA="$(sha256_digest \
  "$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE")"
RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_SHA="$(sha256_digest \
  "$RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_FIXTURE")"
[[ "$RUNNER_ACTIVE_MANIFEST_SHA" != \
   "$RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_SHA" ]] || {
  printf 'Runner journal history fixture must differ from the active manifest.\n' >&2
  exit 1
}
node - "$ROOT_DIR/hubs-cloud/community-edition" "$RUNNER_EVIDENCE_LIVE_DIR" \
  "$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" "$RUNNER_RESTORE_FENCE_LIVE_DIR" \
  "$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" "$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
  "$TARGET_RUNNER_EPOCH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

const communityEdition = process.argv[2];
const sourceLiveDirectory = process.argv[3];
const targetFixtures = [
  { manifestPath: process.argv[4], liveDirectory: process.argv[5], phase: "restore-fence" },
  { manifestPath: process.argv[6], liveDirectory: process.argv[7], phase: "active" }
];
const recoveryEpoch = process.argv[8];
const requireCe = createRequire(path.join(communityEdition, "package.json"));
const YAML = requireCe("yaml");
const {
  ADMISSION_POLICY_NAME,
  CUTOVER_JOURNAL_POLICY_NAME,
  PARENT_FENCE_POLICY_NAME,
  RECOVERY_OPERATION_FENCE_POLICY_NAME,
  RECOVERY_PHASE_ANNOTATION,
  RUNNER_PROTOCOL_POLICY_NAME,
  readActivationPlanText
} = require(path.join(communityEdition, "apply/runner-activation.js"));

const names = [
  ADMISSION_POLICY_NAME,
  RUNNER_PROTOCOL_POLICY_NAME,
  CUTOVER_JOURNAL_POLICY_NAME,
  PARENT_FENCE_POLICY_NAME,
  RECOVERY_OPERATION_FENCE_POLICY_NAME
];
const sourceInput = YAML.parse(fs.readFileSync(
  path.join(sourceLiveDirectory, "generator-input.yaml"), "utf8"
));
function source(name) {
  return JSON.parse(fs.readFileSync(path.join(sourceLiveDirectory, name), "utf8"));
}
function exact(plan, apiVersion, kind, name, namespace = "") {
  const matches = plan.resources.filter(resource =>
    resource?.apiVersion === apiVersion && resource?.kind === kind &&
    resource?.metadata?.name === name &&
    (resource?.metadata?.namespace || "") === namespace
  );
  if (matches.length !== 1) throw new Error("runner_target_resource_fixture_failed");
  return structuredClone(matches[0]);
}
function preserveIdentity(target, current, observed = false) {
  target.metadata = {
    ...(target.metadata || {}),
    uid: current.metadata.uid,
    resourceVersion: current.metadata.resourceVersion,
    creationTimestamp: current.metadata.creationTimestamp
  };
  if (observed) {
    target.metadata.generation = current.metadata.generation;
    target.status = structuredClone(current.status);
  }
  return target;
}
function write(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value)}\n`, {
    mode: 0o600
  });
}
for (const fixture of targetFixtures) {
  const input = structuredClone(sourceInput);
  input.BOT_RUNNER_RECOVERY_EPOCH = recoveryEpoch;
  input.BOT_RUNNER_ACTIVATION_PHASE = "active";
  input.BOT_RUNNER_RECOVERY_PHASE = fixture.phase;
  const generatorInputPath = path.join(fixture.liveDirectory, "generator-input.yaml");
  fs.writeFileSync(generatorInputPath, YAML.stringify(input), { mode: 0o600 });
  const generated = spawnSync(process.execPath, [
    path.join(communityEdition, "generate_script/index.js")
  ], {
    cwd: communityEdition,
    env: {
      ...process.env,
      HCCE_INPUT_VALUES_PATH: generatorInputPath,
      HCCE_OUTPUT_PATH: fixture.manifestPath
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (generated.status !== 0) {
    throw new Error(`runner_target_manifest_fixture_failed:${generated.stderr}`);
  }
  fs.chmodSync(fixture.manifestPath, 0o600);
  const plan = readActivationPlanText(fs.readFileSync(fixture.manifestPath, "utf8"));
  names.forEach((name, index) => {
    const policy = exact(
      plan, "admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", name
    );
    const binding = exact(
      plan, "admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", name
    );
    write(fixture.liveDirectory, `policy-${name}.json`, preserveIdentity(
      policy, source(`policy-${name}.json`), true
    ));
    write(fixture.liveDirectory, `binding-${name}.json`, preserveIdentity(
      binding, source(`binding-${name}.json`), false
    ));
  });
  for (const [slug, apiVersion, kind, name] of [
    ["service-account", "v1", "ServiceAccount", "bot-orchestrator"],
    ["role", "rbac.authorization.k8s.io/v1", "Role", "bot-orchestrator-runner-pods"],
    ["role-binding", "rbac.authorization.k8s.io/v1", "RoleBinding", "bot-orchestrator-runner-pods"]
  ]) {
    write(fixture.liveDirectory, `parent-${slug}.json`, preserveIdentity(
      exact(plan, apiVersion, kind, name, "hcce"),
      source(`parent-${slug}.json`), false
    ));
  }
  for (const [slug, apiVersion, kind, name] of [
    ["runner-pull-secret", "v1", "Secret", "bot-images-pull"],
    ["runner-service-account", "v1", "ServiceAccount", "bot-runner"],
    ["guard-service-account", "v1", "ServiceAccount", "bot-runner-guard"],
    ["runner-quota", "v1", "ResourceQuota", "bot-runner-capacity"],
    ["guard-quota", "v1", "ResourceQuota", "bot-runner-guard-capacity"],
    ["runner-default-deny", "networking.k8s.io/v1", "NetworkPolicy",
      "bot-runner-default-deny"],
    ["runner-egress", "networking.k8s.io/v1", "NetworkPolicy", "bot-runner-egress"]
  ]) {
    write(fixture.liveDirectory, `${slug}.json`, preserveIdentity(
      exact(plan, apiVersion, kind, name, "hcce-bot-runners"),
      source(`${slug}.json`), false
    ));
  }
  write(fixture.liveDirectory, "runner-role.json", preserveIdentity(
    exact(
      plan, "rbac.authorization.k8s.io/v1", "Role",
      "bot-orchestrator-runner-pods", "hcce-bot-runners"
    ),
    source("runner-role.json"), false
  ));
  write(fixture.liveDirectory, "runner-role-binding.json", preserveIdentity(
    exact(
      plan, "rbac.authorization.k8s.io/v1", "RoleBinding",
      "bot-orchestrator-runner-pods", "hcce-bot-runners"
    ),
    source("runner-role-binding.json"), false
  ));
  const parent = exact(plan, "apps/v1", "Deployment", "bot-orchestrator", "hcce");
  parent.metadata.annotations = {
    ...(parent.metadata.annotations || {}),
    [RECOVERY_PHASE_ANNOTATION]: fixture.phase
  };
  parent.spec = { ...parent.spec, replicas: 0 };
  preserveIdentity(parent, source("parent-deployment.json"), true);
  parent.status = {
    observedGeneration: parent.metadata.generation,
    replicas: 0,
    readyReplicas: 0,
    availableReplicas: 0,
    updatedReplicas: 0,
    unavailableReplicas: 0
  };
  write(fixture.liveDirectory, "parent-deployment.json", parent);
  for (const name of [
    "cutover-journal.json", "namespace-kube-system.json", "namespace-hcce.json",
    "namespace-hcce-bot-runners.json"
  ]) {
    write(fixture.liveDirectory, name, source(name));
  }
}
NODE
for runner_live_directory in "$RUNNER_EVIDENCE_LIVE_DIR" \
  "$RUNNER_RESTORE_FENCE_LIVE_DIR" "$RUNNER_ACTIVE_TARGET_LIVE_DIR"; do
  for runner_fence_resource in policy binding; do
    runner_fence_live_path="$runner_live_directory/$runner_fence_resource-recovery-operation-pod-fence.yenhubs.org.json"
    if [[ "$runner_fence_resource" == policy ]]; then
      runner_fence_identity_fixture="$RECOVERY_OPERATION_FENCE_POLICY_FIXTURE"
    else
      runner_fence_identity_fixture="$RECOVERY_OPERATION_FENCE_BINDING_FIXTURE"
    fi
    runner_fence_uid="$(jq -er '.metadata.uid' \
      "$runner_fence_identity_fixture")"
    jq --arg uid "$runner_fence_uid" '.metadata.uid = $uid' \
      "$runner_fence_live_path" >"$runner_fence_live_path.next"
    chmod 600 "$runner_fence_live_path.next"
    mv "$runner_fence_live_path.next" "$runner_fence_live_path"
  done
done
export RUNNER_EVIDENCE_LIVE_DIR RUNNER_RESTORE_FENCE_LIVE_DIR \
  RUNNER_ACTIVE_TARGET_LIVE_DIR PROCESS_LOCAL_CUTOVER_KEY_PATH \
  RUNNER_ACTIVE_MANIFEST_SHA RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_SHA
export PATH="$TMP_DIR/bin:$PATH"
export RECOVERY_WAIT_RETRY_DELAY_SECONDS=0
export RECOVERY_STREAM_POLL_SECONDS=0.01
export RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=120
# shellcheck disable=SC2031 # Intentional global fixture values after isolated subshells.
export YENHUBS_RECOVERY_TEST_MODE=local-fixture
# shellcheck disable=SC2031 # Intentional global fixture value after isolated subshells.
export RECOVERY_TEST_STABLE_ABSENCE_SECONDS=0
export YENHUBS_RECOVERY_RUNNER_CONTROL_PLANE_VERIFIER="$RUNNER_CONTROL_PLANE_VERIFIER_FIXTURE"
export YENHUBS_RECOVERY_GENERATED_MANIFEST_VERIFIER="$GENERATED_MANIFEST_VERIFIER_FIXTURE"
export YENHUBS_RECOVERY_LIVE_REACTIVATION_VERIFIER="$LIVE_REACTIVATION_VERIFIER_FIXTURE"
export STUB_LIVE_REACTIVATION_VALUES_FILE="$RESTORE_VALUES_FIXTURE"
export STUB_LIVE_REACTIVATION_MANIFEST_FILE="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE"
export HCCE_MANIFEST_PATH="$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE"

reset_stub() {
  unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
    YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY \
    YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256 \
    YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256 \
    YENHUBS_PARENT_WRITER_MONITOR_PID \
    YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY \
    YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_READY_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256 \
    YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH \
    YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256 \
    YENHUBS_PARENT_DURABLE_MONITOR_PID \
    YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY \
    YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH \
    YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH \
    YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH \
    YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256 \
    YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256 \
    YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY \
    YENHUBS_PARENT_FREEZE_FENCE_CAPABILITY \
    RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID \
    RECOVERY_CONSUMER_CONTRACT_JSON RECOVERY_DEPLOYMENT_INVENTORY_SHA256 \
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256 RECOVERY_RUNNER_RUNTIME_GENERATION \
    RECOVERY_OPERATION_STATE RECOVERY_OPERATION_BINDING_SHA256 \
    STUB_CHECKPOINT_WRITER_OPERATION_OWNER \
    STUB_CHECKPOINT_WRITER_MONITOR_DIR STUB_CHECKPOINT_WRITER_DISCOVER_MONITOR \
    STUB_CHECKPOINT_RECEIPT_TRACE STUB_RESTORE_DRIVER_PID \
    RECOVERY_FENCE_PRE_EPOCH RECOVERY_FENCE_TARGET_EPOCH \
    RECOVERY_CHECKPOINT_RUNNER_GENERATION \
    RECOVERY_CHECKPOINT_METADATA_SCHEMA RECOVERY_CHECKPOINT_METADATA_COPY \
    RECOVERY_DEPLOYMENT_INVENTORY_COPY RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY \
    RECOVERY_SERIALIZATION_LEASE_REQUIRED \
    RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY \
    RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID \
    RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV \
    RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID \
    RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV
  : >"$KUBECTL_LOG"
  rm -rf -- "$STUB_STATE_DIR/serialization-lease-fixture-lock" \
    "$STUB_STATE_DIR"/serialization-lease-watch-handoff.*
  rm -f -- "$STUB_STATE_DIR/waited" "$STUB_STATE_DIR/applied.yaml" \
    "$STUB_STATE_DIR/pod-created" "$STUB_STATE_DIR/consumer-count" \
    "$STUB_STATE_DIR/db-contract-count" "$STUB_STATE_DIR/uuid-query-count" \
    "$STUB_STATE_DIR/restore-pod-get-count" "$STUB_STATE_DIR/restore-lock-get-count" \
    "$STUB_STATE_DIR/restore-lock.yaml" "$STUB_STATE_DIR/restore-lock-uid" \
    "$STUB_STATE_DIR/restore-lock-rv" "$STUB_STATE_DIR/network-policy.yaml" \
    "$STUB_STATE_DIR/network-policy-name" "$STUB_STATE_DIR/network-policy-uid" \
    "$STUB_STATE_DIR/network-policy-rv" \
    "$STUB_STATE_DIR/pod-name" "$STUB_STATE_DIR/pod-uid" "$STUB_STATE_DIR/pod-rv" \
    "$STUB_STATE_DIR/storage-helper-pod-live.json" \
    "$STUB_STATE_DIR/helper-pod-list-snapshot-opened" \
    "$STUB_STATE_DIR/helper-pod-delete-finished" \
    "$STUB_STATE_DIR/create-input.yaml" \
    "$STUB_STATE_DIR/helper-policy-create-decoy" \
    "$STUB_STATE_DIR/helper-policy-create-lost-response" \
    "$STUB_STATE_DIR/helper-policy-create-signal-ready" \
    "$STUB_STATE_DIR/helper-pod-create-decoy" \
    "$STUB_STATE_DIR/helper-pod-create-lost-response" \
    "$STUB_STATE_DIR/helper-pod-create-signal-ready" \
    "$STUB_STATE_DIR/create-count" "$STUB_STATE_DIR/delete-count" \
    "$STUB_STATE_DIR/replace-ready-Lease" \
    "$STUB_STATE_DIR/replace-ready-Role" \
    "$STUB_STATE_DIR/serialization-lease.json" \
    "$STUB_STATE_DIR/serialization-lease.next" \
    "$STUB_STATE_DIR"/serialization-lease.next.* \
    "$STUB_STATE_DIR/serialization-lease-create.yaml" \
    "$STUB_STATE_DIR/serialization-lease-get-count" \
    "$STUB_STATE_DIR/runner-role-uid" "$STUB_STATE_DIR/runner-role-rv" \
    "$STUB_STATE_DIR/runner-role-phase" "$STUB_STATE_DIR/runner-role-rules.json" \
    "$STUB_STATE_DIR/parent-death-stream-started" \
    "$STUB_STATE_DIR/parent-death-stream-terminated" \
    "$STUB_STATE_DIR/parent-death-stream-completed" \
    "$STUB_STATE_DIR/parent-death-stream-pid" \
    "$STUB_STATE_DIR/parent-death-stream-pgid" \
    "$STUB_STATE_DIR/parent-death-grandchild-pid" \
    "$STUB_STATE_DIR"/parent-death-stream-*.next.* \
    "$STUB_STATE_DIR/guard-failure-stream-started" \
    "$STUB_STATE_DIR/guard-failure-stream-terminated" \
    "$STUB_STATE_DIR/guard-failure-stream-completed" \
    "$STUB_STATE_DIR/guard-failure-stream-pid" \
    "$STUB_STATE_DIR/guard-failure-stream-pgid" \
    "$STUB_STATE_DIR/guard-failure-grandchild-pid" \
    "$STUB_STATE_DIR"/guard-failure-stream-*.next.* \
    "$STUB_STATE_DIR/multi-guard-stream-started" \
    "$STUB_STATE_DIR/multi-guard-stream-completed" \
    "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-started" \
    "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-completed" \
    "$STUB_STATE_DIR/db-source-monitor-stream-started" \
    "$STUB_STATE_DIR/db-source-monitor-stream-completed" \
    "$STUB_STATE_DIR/db-source-monitor-stream-pid" \
    "$STUB_STATE_DIR/db-source-monitor-inflight-observed" \
    "$STUB_STATE_DIR/db-source-monitor-observer-pid" \
    "$STUB_STATE_DIR/restore-db-stream-started" \
    "$STUB_STATE_DIR/restore-db-stream-terminated" \
    "$STUB_STATE_DIR/restore-db-stream-completed" \
    "$STUB_STATE_DIR/restore-db-stream-pid" \
    "$STUB_STATE_DIR/restore-db-stream-pgid" \
    "$STUB_STATE_DIR/restore-db-stream-grandchild-pid" \
    "$STUB_STATE_DIR/restore-db-monitor-inflight-observed" \
    "$STUB_STATE_DIR/restore-db-monitor-observer-pid" \
    "$STUB_STATE_DIR/restore-storage-stream-started" \
    "$STUB_STATE_DIR/restore-storage-stream-terminated" \
    "$STUB_STATE_DIR/restore-storage-stream-completed" \
    "$STUB_STATE_DIR/restore-storage-stream-pid" \
    "$STUB_STATE_DIR/restore-storage-stream-pgid" \
    "$STUB_STATE_DIR/restore-storage-stream-grandchild-pid" \
    "$STUB_STATE_DIR/restore-storage-monitor-inflight-observed" \
    "$STUB_STATE_DIR/restore-storage-monitor-observer-pid" \
    "$STUB_STATE_DIR/backup-monitor-stream-started" \
    "$STUB_STATE_DIR/checkpoint-backup-complete" \
    "$STUB_STATE_DIR/durable-fence-disappears-observed" \
    "$STUB_STATE_DIR/durable-fence-replaced-observed" \
    "$STUB_STATE_DIR/durable-fence-terminating-observed" \
    "$STUB_STATE_DIR/checkpoint-dormant-fence-aba-before-first-resume-observed" \
    "$STUB_STATE_DIR/checkpoint-dormant-fence-aba-before-lock-release-observed" \
    "$STUB_STATE_DIR/checkpoint-dormant-fence-post-resume-read-count" \
    "$STUB_STATE_DIR/checkpoint-writer-post-ready-emitted" \
    "$STUB_STATE_DIR/checkpoint-writer-final-boundary-read" \
    "$STUB_STATE_DIR/checkpoint-writer-final-event-emitted" \
    "$STUB_STATE_DIR/checkpoint-writer-terminal-watch-seen" \
    "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-started" \
    "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-closed" \
    "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-stopped" \
    "$STUB_STATE_DIR/checkpoint-writer-terminal-w2-deployments-started" \
    "$STUB_STATE_DIR/checkpoint-writer-terminal-list-gap-excursion" \
    "$STUB_STATE_DIR/checkpoint-writer-terminal-control-delay" \
    "$STUB_STATE_DIR/checkpoint-writer-terminal-control-gap-excursion" \
    "$STUB_STATE_DIR/checkpoint-writer-post-join-transient" \
    "$STUB_STATE_DIR/checkpoint-writer-post-join-rewait" \
    "$STUB_STATE_DIR/recovery-operation-fence-policy-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-state" \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count" \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-payload.json" \
    "$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-queried" \
    "$STUB_STATE_DIR/checkpoint-quiesce-bot-lost-response" \
    "$STUB_STATE_DIR/checkpoint-quiesce-reticulum-lost-response" \
    "$STUB_STATE_DIR/checkpoint-resume-lost-response" \
    "$STUB_STATE_DIR/checkpoint-resume-postcheck-pending" \
    "$STUB_STATE_DIR/checkpoint-resume-postcheck-lost" \
    "$STUB_STATE_DIR/checkpoint-resume-external-emitted" \
    "$STUB_STATE_DIR/checkpoint-resume-wrong-emitted" \
    "$STUB_STATE_DIR/checkpoint-resume-cleanup-lost-response" \
    "$STUB_STATE_DIR/rolling-resume-reconcile-pending" \
    "$STUB_STATE_DIR/rolling-resume-reconcile-seen" \
    "$STUB_STATE_DIR/rolling-resume-uncommitted-lost" \
    "$STUB_STATE_DIR/rolling-resume-ambiguous-lost" \
    "$STUB_STATE_DIR/checkpoint-lock-create-lost-response" \
    "$STUB_STATE_DIR/checkpoint-lock-create-wrong-token" \
    "$STUB_STATE_DIR/checkpoint-lock-create-competitor" \
    "$STUB_STATE_DIR/preflight-active-source-count" \
    "$STUB_STATE_DIR/preflight-final-revalidation-complete" \
    "$STUB_STATE_DIR/preflight-date-count" \
    "$STUB_STATE_DIR/preflight-curl.log" \
    "$STUB_STATE_DIR/checkpoint-orphan-runner-deleted" \
    "$STUB_STATE_DIR/runner-control-plane-verifier-count" \
    "$STUB_STATE_DIR/runner-control-plane-verifier.log" \
    "$STUB_STATE_DIR/generated-manifest-verifier-count" \
    "$STUB_STATE_DIR/live-reactivation-verifier-count" \
    "$STUB_STATE_DIR/clear-stale-post-helper-evidence-count" \
    "$STUB_STATE_DIR/finalizer-failclose-triggered" \
    "$STUB_STATE_DIR/finalizer-role-cas-triggered" \
    "$STUB_STATE_DIR/finalizer-role-lost-response" \
    "$STUB_STATE_DIR/runner-role-replace-payload.json" \
    "$STUB_STATE_DIR/restore-lock-replace-payload.json" \
    "$STUB_STATE_DIR/lock-replaced-after-quiesce" \
    "$STUB_STATE_DIR/role-replace-failed-once" \
    "$STUB_STATE_DIR/runner-list-count" "$STUB_STATE_DIR/runner-reappear" \
    "$STUB_STATE_DIR/runner-profile-list-count" \
    "$STUB_STATE_DIR/runner-profile-deleted" \
    "$STUB_STATE_DIR/runner-fence-delete-attempted" \
    "$STUB_STATE_DIR/runner-watch-transient-emitted" \
    "$STUB_STATE_DIR/max-pods-bot-orchestrator" \
    "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" \
    "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" \
    "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.deleted" \
    "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.deleted" \
    "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.lost" \
    "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.lost" \
    "$STUB_STATE_DIR/freeze-fence-create-signal-ready" \
    "$STUB_STATE_DIR/freeze-fence-delete-signal-ready" \
    "$STUB_STATE_DIR/freeze-fence-create-signal-sent" \
    "$STUB_STATE_DIR/freeze-fence-delete-signal-sent" \
    "$STUB_STATE_DIR/freeze-fence-watcher-node.log" \
    "$STUB_STATE_DIR/freeze-fence-policy-create-count" \
    "$STUB_STATE_DIR/freeze-fence-binding-create-count" \
    "$STUB_STATE_DIR/freeze-fence-policy-live-get-count" \
    "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.next" \
    "$STUB_STATE_DIR/freeze-fence-capability-issued"
  rm -f -- "$STUB_STATE_DIR/recovery-phase" "$STUB_STATE_DIR/recovery-epoch"
  find "$STUB_STATE_DIR" -maxdepth 1 -type f \
    \( -name 'replicas-*' -o -name 'rv-*' -o -name 'generation-*' \
       -o -name 'create-payload-*' \
       -o -name 'storage-helper-pod-live.json.next.*' \
       -o -name 'checkpoint-resume-receipt-*' \
       -o -name 'delete-options-*' -o -name 'delete-path-*' \
       -o -name 'runner-watch-count-*' \
       -o -name 'runner-final-watch-count-*' \
       -o -name 'runner-watch-event-*' -o -name 'replace-payload.*' \
       -o -name 'recovery-operation-fence-*-count-*' \) -delete
  find "$STUB_STATE_DIR" -maxdepth 1 -type d \
    \( -name 'consumer-count.*' -o -name 'runner-list-count.*' \
       -o -name 'restore-pod-get-count.*' -o -name 'writer-watch-*' \
       -o -name 'preflight-deployment-list-count.*' \
       -o -name 'preflight-reticulum-pod-list-count.*' \
       -o -name 'preflight-reticulum-uid-count.*' \
       -o -name 'rolling-preflight-deployment-get.*' \
       -o -name 'helper-policy-get-count.*' \
       -o -name 'checkpoint-writer-lease-read-count.*' \
       -o -name 'checkpoint-writer-post-join-lock-read.*' \
       -o -name 'checkpoint-receipt-*' \) \
    -exec rmdir {} +
}

seed_recovery_operation_fence_binding_state() {
  local state="$1" resource_version="${2:-recovery-operation-fence-binding-rv-1}"
  [[ "$state" == dormant || "$state" == active ]] || return 2
  printf '%s' "$state" \
    >"$STUB_STATE_DIR/recovery-operation-fence-binding-state"
  printf '%s' "$resource_version" \
    >"$STUB_STATE_DIR/recovery-operation-fence-binding-rv"
  chmod 600 \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-state" \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-rv"
}

recovery_operation_fence_binding_state_is() {
  local expected_state="$1" expected_resource_version="$2"
  [[ -f "$STUB_STATE_DIR/recovery-operation-fence-binding-state" &&
     -f "$STUB_STATE_DIR/recovery-operation-fence-binding-rv" &&
     "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")" == \
       "$expected_state" &&
     "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")" == \
       "$expected_resource_version" ]]
}

recovery_operation_fence_binding_was_not_replaced() {
  [[ ! -e "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count" &&
     ! -e \
       "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-payload.json" ]]
}

restore_lock_state_is() {
  local expected_state="$1" expected_resource_version="$2"
  [[ -f "$STUB_STATE_DIR/restore-lock.yaml" &&
     -f "$STUB_STATE_DIR/restore-lock-rv" &&
     "$(test_yaml_field 'yenhubs.org/recovery-state:' \
       "$STUB_STATE_DIR/restore-lock.yaml")" == "$expected_state" &&
     "$(cat "$STUB_STATE_DIR/restore-lock-rv")" == \
       "$expected_resource_version" ]]
}

run_checkpoint_local_input_preflight_tests() {
  local output_root="$1" output
  mkdir -p "$output_root"
  output="$output_root/missing-cutover-key"
  reset_stub
  expect_failure 'durable checkpoint requires its cutover key before any Kubernetes read' \
    'PROCESS_LOCAL_CUTOVER_KEY_PATH is required for a durable checkpoint.' \
    env -u PROCESS_LOCAL_CUTOVER_KEY_PATH \
    ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"
  if [[ ! -s "$KUBECTL_LOG" && ! -e "$output" &&
        ! -e "$output.yenhubs-publish-lock" ]]; then
    pass 'missing durable cutover key leaves Kubernetes and publication state untouched'
  else
    fail 'missing durable cutover key zero-mutation boundary' "$(cat "$KUBECTL_LOG")"
  fi
}

run_checkpoint_input_snapshot_test() {
  local checkpoint_output="$1"
  local mutable_values="$TMP_DIR/checkpoint-mutable-values.yaml"
  local mutable_manifest="$TMP_DIR/checkpoint-mutable-manifest.yaml"
  local mutable_key="$TMP_DIR/checkpoint-mutable-cutover.key"
  local binding_log="$STUB_STATE_DIR/checkpoint-local-input-binding.log"
  local triple_count values_snapshot manifest_snapshot key_snapshot
  local first_manifest_snapshot first_key_snapshot manifest_a_sha manifest_b_sha
  local key_a_sha key_b_sha
  cp "$VALUES_FIXTURE" "$mutable_values"
  cp "$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" "$mutable_manifest"
  cp "$PROCESS_LOCAL_CUTOVER_KEY_PATH" "$mutable_key"
  chmod 600 "$mutable_values" "$mutable_manifest" "$mutable_key"
  manifest_a_sha="$(sha256_digest "$mutable_manifest")"
  key_a_sha="$(sha256_digest "$mutable_key")"
  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  : >"$binding_log"
  expect_success 'checkpoint resume is independent of local input rotation after fencing' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$mutable_values" HCCE_MANIFEST_PATH="$mutable_manifest" \
    PROCESS_LOCAL_CUTOVER_KEY_PATH="$mutable_key" \
    STUB_MODE=checkpoint-local-input-mutation \
    STUB_MUTABLE_VALUES_PATH="$mutable_values" \
    STUB_MUTABLE_MANIFEST_PATH="$mutable_manifest" \
    STUB_MUTABLE_KEY_PATH="$mutable_key" \
    STUB_LOCAL_INPUT_BINDING_LOG="$binding_log" \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_MONITOR_WATCH_PACE=1 \
    RECOVERY_STREAM_POLL_SECONDS=1 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$checkpoint_output"
  triple_count=0
  values_snapshot=""
  manifest_snapshot=""
  key_snapshot=""
  first_manifest_snapshot=""
  first_key_snapshot=""
  if [[ -s "$STUB_STATE_DIR/runner-control-plane-verifier.log" ]]; then
    triple_count="$(awk -F '\t' '{print $2 "\t" $3 "\t" $4}' \
      "$STUB_STATE_DIR/runner-control-plane-verifier.log" |
      LC_ALL=C sort -u | wc -l | tr -d ' ')"
    IFS=$'\t' read -r values_snapshot manifest_snapshot key_snapshot < <(
      awk -F '\t' 'NR == 1 {print $2 "\t" $3 "\t" $4}' \
        "$STUB_STATE_DIR/runner-control-plane-verifier.log"
    )
  fi
  if [[ -s "$binding_log" ]]; then
    IFS=$'\t' read -r first_manifest_snapshot first_key_snapshot <"$binding_log"
  fi
  if [[ "$triple_count" == 1 && -n "$values_snapshot" &&
        -n "$manifest_snapshot" && -n "$key_snapshot" &&
        "$values_snapshot" != "$mutable_values" &&
        "$manifest_snapshot" != "$mutable_manifest" &&
        "$key_snapshot" != "$mutable_key" &&
        "$first_manifest_snapshot" == "$manifest_snapshot" &&
        "$first_key_snapshot" == "$key_snapshot" &&
        ! -e "$values_snapshot" && ! -e "$manifest_snapshot" &&
        ! -e "$key_snapshot" ]] &&
     grep -q '^invalid: \[$' "$mutable_values" &&
     grep -q '^tampered-after-fence$' "$mutable_manifest"; then
    pass 'checkpoint binds values, manifest and key before its first Kubernetes read'
  else
    fail 'checkpoint immutable local-input binding' \
      "triples=$triple_count values=$values_snapshot manifest=$manifest_snapshot key=$key_snapshot first_manifest=$first_manifest_snapshot first_key=$first_key_snapshot"
  fi
  manifest_b_sha="$(sha256_digest "$mutable_manifest")"
  key_b_sha="$(sha256_digest "$mutable_key")"
  if [[ "$manifest_a_sha" != "$manifest_b_sha" &&
        "$manifest_a_sha" != "$RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_SHA" ]] &&
     [[ "$key_a_sha" != "$key_b_sha" ]] &&
     jq -e --arg historical "$RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_SHA" \
       --arg active "$manifest_a_sha" '
       .runtime_generation == "durable-v2" and
       .journal.state == "present" and
       .journal.hmac_verification == "verified-owner-key" and
       .journal.contract.manifest_sha256 == $historical and
       .journal.contract.manifest_sha256 != $active
     ' "$checkpoint_output/runner-cutover-evidence.json" >/dev/null; then
    pass 'checkpoint preserves signed bootstrap history while active manifest and key snapshots rotate'
  else
    fail 'checkpoint update-friendly journal history and active snapshot binding' \
      "historical=$RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_SHA active_a=$manifest_a_sha active_b=$manifest_b_sha key_a=$key_a_sha key_b=$key_b_sha"
  fi
}

run_durable_runner_fence_drift_checkpoint_tests() {
  local output_root="$1" profile output expected writer drift_marker
  local failure_state_exact

  mkdir -p "$output_root"
  for profile in fence-disappears fence-replaced fence-terminating; do
    output="$output_root/$profile"
    drift_marker="$STUB_STATE_DIR/durable-$profile-observed"
    reset_stub
    seed_recovery_operation_fence_binding_state dormant
    case "$profile" in
      fence-terminating)
        expected='runner_cutover_checkpoint_evidence_failed:runner_namespace_pod_identity_invalid'
        ;;
      *)
        expected='Permanent runner-fence inventory changed during checkpoint backup.'
        ;;
    esac
    expect_failure "durable checkpoint fails when its permanent fence becomes $profile" \
      "$expected" \
      env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
      EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
      VALUES_FILE="$VALUES_FIXTURE" STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
      STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE="$profile" \
      STUB_MONITOR_WATCH_PACE=1 RECOVERY_STREAM_POLL_SECONDS=1 \
      "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"
    failure_state_exact=true
    for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
      if [[ "$(cat "$STUB_STATE_DIR/replicas-$writer" 2>/dev/null || :)" != 0 ||
            "$(deployment_patch_count "$writer" 1)" != 0 ]]; then
        failure_state_exact=false
      fi
    done
    if [[ "$failure_state_exact" == true && -e "$drift_marker" &&
          ! -e "$output" && ! -e "$output.yenhubs-publish-lock" &&
          -e "$STUB_STATE_DIR/restore-lock.yaml" &&
          ! -e "$STUB_STATE_DIR/runner-fence-delete-attempted" ]] &&
       ! grep -q "/namespaces/hcce-bot-runners/pods/$RUNNER_FIXTURE_NAME" \
         "$KUBECTL_LOG" &&
       ! grep -q \
         'delete --raw=/api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock' \
         "$KUBECTL_LOG"; then
      pass "$profile is observed and retains lock and every writer at zero without publishing or deleting the fence"
    else
      fail "$profile exact observed fail-closed checkpoint state" \
        "observed=$([[ -e "$drift_marker" ]] && printf yes || printf no) log=$(cat "$KUBECTL_LOG")"
    fi
  done
}

run_checkpoint_finalization_diagnostic_tests() {
  local output_root="$1" output diagnostic_bin real_mv diagnostic_line
  mkdir -p "$output_root"
  output="$output_root/checksum-commit"
  diagnostic_bin="$output_root/bin"
  mkdir -p "$diagnostic_bin"
  real_mv="$(command -v mv)"
  cat >"$diagnostic_bin/mv" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == */.yenhubs-checksums.next &&
      "${2:-}" == */SHA256SUMS ]]; then
  exit 73
fi
exec "$REAL_MV_BIN" "$@"
STUB
  chmod 700 "$diagnostic_bin/mv"

  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  expect_failure_status 'checkpoint preserves a safe exact diagnostic and status for checksum publication failure' \
    'Checkpoint failure: stage=checksum-manifest code=commit status=73.' 73 \
    env PATH="$diagnostic_bin:$PATH" REAL_MV_BIN="$real_mv" \
      ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
      EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
      VALUES_FILE="$VALUES_FIXTURE" \
      STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
      STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
      STUB_MONITOR_WATCH_PACE=1 RECOVERY_STREAM_POLL_SECONDS=1 \
      "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"
  diagnostic_line="$(printf '%s\n' "$LAST_OUTPUT" |
    grep '^Checkpoint failure:' || :)"
  if [[ "$diagnostic_line" == \
        'Checkpoint failure: stage=checksum-manifest code=commit status=73.' &&
        "$(printf '%s\n' "$LAST_OUTPUT" | grep -c '^Checkpoint failure:' || :)" == 1 &&
        ! -e "$output" && ! -e "$output.yenhubs-publish-lock" ]] &&
     { { [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
           checkpoint_all_writers_at 1; } ||
       { [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
           checkpoint_all_writers_at 0 &&
           checkpoint_resume_receipts_absent; }; }; then
    pass 'checkpoint diagnostic is singular and leaves exact rollback or fail-closed authority without publication'
  else
    fail 'checkpoint diagnostic redaction or rollback contract' \
      "diagnostic=$diagnostic_line output=$LAST_OUTPUT"
  fi
}

run_checkpoint_dormant_fence_aba_tests() {
  local output_root="$1" only_mode="${2:-}" mode output expected marker checkpoint_stamp
  local all_zero published_valid resume_patch_count lock_delete_count
  local -a modes=(checkpoint-dormant-fence-aba-before-first-resume
    checkpoint-dormant-fence-aba-before-lock-release)
  mkdir -p "$output_root"
  if [[ -n "$only_mode" ]]; then
    case "$only_mode" in
      checkpoint-dormant-fence-aba-before-first-resume|\
      checkpoint-dormant-fence-aba-before-lock-release)
        modes=("$only_mode")
        ;;
      *) return 2 ;;
    esac
  fi

  for mode in "${modes[@]}"; do
    output="$output_root/$mode"
    marker="$STUB_STATE_DIR/$mode-observed"
    reset_stub
    seed_recovery_operation_fence_binding_state dormant
    if [[ "$mode" == checkpoint-dormant-fence-aba-before-first-resume ]]; then
      expected='Checkpoint failure: stage=resume code=fence-continuity status=1.'
    else
      expected='Checkpoint failure: stage=lock-release code=fence-continuity status=1.'
    fi
    expect_failure "$mode is rejected by the pinned dormant fence identity" \
      "$expected" \
      env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$VALUES_FIXTURE" \
        STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
        STUB_MODE="$mode" STUB_MONITOR_WATCH_PACE=1 \
        RECOVERY_STREAM_POLL_SECONDS=1 \
        "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"

    published_valid=false
    checkpoint_stamp="$(jq -er '.stamp' "$output/checkpoint-metadata.json" 2>/dev/null || :)"
    if [[ -n "$checkpoint_stamp" && ! -e "$output/.yenhubs-incomplete" ]] &&
       bash -c 'source "$1"; recovery_verify_checkpoint_directory "$2" "$3"' \
         _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$output" \
         "$checkpoint_stamp" >/dev/null 2>&1; then
      published_valid=true
    fi
    all_zero=true
    for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
      [[ "$(cat "$STUB_STATE_DIR/replicas-$writer" 2>/dev/null || :)" == 0 ]] ||
        all_zero=false
    done
    resume_patch_count="$(grep -Ec \
      'patch deployment .*"op":"replace","path":"/spec/replicas","value":1' \
      "$KUBECTL_LOG" || :)"
    lock_delete_count="$(grep -Ec \
      'delete --raw=/api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock' \
      "$KUBECTL_LOG" || :)"

    if [[ -e "$marker" && "$published_valid" == true &&
          -e "$STUB_STATE_DIR/restore-lock.yaml" && "$lock_delete_count" == 0 ]] &&
       recovery_operation_fence_binding_state_is dormant \
         recovery-operation-fence-binding-rv-5 &&
       [[ "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count" 2>/dev/null || :)" == 2 ]] &&
       { { [[ "$mode" == checkpoint-dormant-fence-aba-before-first-resume &&
              "$all_zero" == true && "$resume_patch_count" == 0 ]]; } ||
         { [[ "$mode" == checkpoint-dormant-fence-aba-before-lock-release ]] &&
              checkpoint_all_writers_at 1 &&
              [[ "$resume_patch_count" == 5 ]]; }; }; then
      pass "$mode retains the exact published checkpoint and lock at its safe writer boundary"
    else
      fail "$mode dormant ABA fail-closed state" \
        "observed=$([[ -e "$marker" ]] && printf yes || printf no) published=$published_valid zero=$all_zero resumes=$resume_patch_count lock_deletes=$lock_delete_count output=$LAST_OUTPUT"
    fi
  done
}

run_durable_reconciled_profile_checkpoint_test() {
  local output_root="$1" profile="$2" output expected_name expected_uid expected_rv
  local expected_path path_file path_value delete_index="" delete_payload=""
  local runner_delete_count=0 expected_delete_count=0 writer
  local delete_contract=false exact_writer_transitions=true
  local serialization_lease_released=false staging_absent=true
  [[ "$profile" == runner || "$profile" == intent ]] || return 2
  if [[ "$profile" == runner ]]; then
    expected_name="$RUNNER_FIXTURE_NAME"
    expected_uid=runner-uid-1
    expected_rv=pod-rv-12
  else
    expected_name="$RUNNER_INTENT_FIXTURE_NAME"
    expected_uid=intent-uid-1
    expected_rv=pod-rv-11
  fi
  expected_path="/api/v1/namespaces/hcce-bot-runners/pods/$expected_name"
  output="$output_root/$profile"
  mkdir -p "$output_root"
  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  expect_success "durable checkpoint reconciles an exact $profile with UID and resourceVersion" \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE="$profile" \
    STUB_MONITOR_WATCH_PACE=1 RECOVERY_STREAM_POLL_SECONDS=1 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"

  while IFS= read -r path_file; do
    path_value="$(cat "$path_file")"
    case "$path_value" in
      /api/v1/namespaces/hcce-bot-runners/pods/*)
        runner_delete_count=$((runner_delete_count + 1))
        if [[ "$path_value" == "$expected_path" ]]; then
          expected_delete_count=$((expected_delete_count + 1))
          delete_index="${path_file##*-}"
        fi
        ;;
    esac
  done < <(find "$STUB_STATE_DIR" -maxdepth 1 -type f \
    -name 'delete-path-*' -print | LC_ALL=C sort)
  if [[ "$runner_delete_count" == 1 && "$expected_delete_count" == 1 &&
        -n "$delete_index" ]]; then
    delete_payload="$STUB_STATE_DIR/delete-options-$delete_index.json"
  fi
  # shellcheck disable=SC2016 # jq program consumes --arg values, not shell variables.
  if [[ -n "$delete_payload" && -f "$delete_payload" ]] &&
     jq -e --arg uid "$expected_uid" --arg rv "$expected_rv" '
       (keys | sort) == ["apiVersion","gracePeriodSeconds","kind","preconditions","propagationPolicy"] and
       .apiVersion == "v1" and .kind == "DeleteOptions" and
       .preconditions == {resourceVersion:$rv,uid:$uid} and
       .gracePeriodSeconds == 0 and .propagationPolicy == "Background"
     ' "$delete_payload" >/dev/null 2>&1; then
    delete_contract=true
  fi
  for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ "$(deployment_patch_count "$writer" 0)" != 1 ||
          "$(deployment_patch_count "$writer" 1)" != 1 ]]; then
      exact_writer_transitions=false
    fi
  done
  if jq -e '
      .metadata.uid == "serialization-lease-uid" and
      (.metadata | has("deletionTimestamp") | not) and
      (.spec | keys | sort) == ["leaseDurationSeconds","leaseTransitions"]
    ' "$STUB_STATE_DIR/serialization-lease.json" >/dev/null 2>&1; then
    serialization_lease_released=true
  fi
  if find "$output_root" -maxdepth 1 -type d \
      -name '.yenhubs-checkpoint-*' -print -quit | grep -q .; then
    staging_absent=false
  fi

  if [[ "$delete_contract" == true && "$runner_delete_count" == 1 &&
        "$expected_delete_count" == 1 &&
        "$exact_writer_transitions" == true &&
        "$serialization_lease_released" == true &&
        "$staging_absent" == true &&
        -e "$STUB_STATE_DIR/runner-profile-deleted" &&
        ! -e "$STUB_STATE_DIR/runner-fence-delete-attempted" &&
        ! -e "$STUB_STATE_DIR/restore-lock.yaml" &&
        ! -e "$output/.yenhubs-incomplete" &&
        ! -e "$output.yenhubs-publish-lock" ]] &&
     checkpoint_output_is_valid "$output" >/dev/null 2>&1 &&
     checkpoint_all_writers_at 1 && checkpoint_all_writer_rollouts_observed &&
     checkpoint_resume_receipts_absent &&
     recovery_operation_fence_binding_state_is dormant \
       recovery-operation-fence-binding-rv-3 &&
     [[ "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count" \
          2>/dev/null || :)" == 2 ]] &&
     jq -e '.quiescence == {runners:0,intents:0,fences:[]}' \
       "$output/runner-cutover-evidence.json" >/dev/null; then
    pass "durable $profile deletion is exact and finalizes every authority boundary"
  else
    fail "durable $profile exact deletion and finalization contract" \
      "runner-deletes=$runner_delete_count expected-deletes=$expected_delete_count payload=$delete_payload writer-transitions=$exact_writer_transitions lease-released=$serialization_lease_released staging-absent=$staging_absent log=$(cat "$KUBECTL_LOG")"
  fi
}

run_durable_runner_profile_checkpoint_tests() {
  local output_root="$1" profile output
  local evidence_hmac fixture_secret manifest_body_sentinel
  mkdir -p "$output_root"

  output="$output_root/fence-stable"
  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  expect_success 'durable checkpoint preserves one exact permanent fence' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
    STUB_MONITOR_WATCH_PACE=1 RECOVERY_STREAM_POLL_SECONDS=1 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"
  if jq -e --arg name "$RUNNER_FIXTURE_NAME" '
      .schema_version == 3 and .runtime_generation == "durable-v2" and
      .recovery_operation_fence_state == "active" and
      .quiescence.runners == 0 and .quiescence.intents == 0 and
      .quiescence.fences == [{name:$name,uid:"fence-uid-1",
        resource_version:"pod-rv-10",room_key:"aaaaaaaaaaaaaaaaaaaa",
        process_generation:"11111111-1111-4111-8111-111111111111",
        state:"fenced"}] and
      .admission.state == "present" and
      .admission.parent_resources.state == "present"
    ' "$output/runner-cutover-evidence.json" >/dev/null &&
     ! grep -q "/namespaces/hcce-bot-runners/pods/$RUNNER_FIXTURE_NAME" \
       "$KUBECTL_LOG" &&
     [[ ! -e "$STUB_STATE_DIR/runner-fence-delete-attempted" &&
        ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     checkpoint_all_writers_at 1 &&
     recovery_operation_fence_binding_state_is dormant \
       recovery-operation-fence-binding-rv-3 &&
     [[ "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-replace-count" 2>/dev/null || :)" == 2 ]]; then
    pass 'durable fence UID and resourceVersion survive every quiescence gate'
  else
    fail 'durable fence preservation and complete evidence' "$(cat "$KUBECTL_LOG")"
  fi
  fixture_secret='fixture-rotated-orchestrator-key-at-least-32-chars'
  manifest_body_sentinel='hubs-ci.invalid'
  evidence_hmac=""
  if evidence_hmac="$(jq -er '.journal.canonical_json | fromjson | .hmacSha256' \
      "$output/runner-cutover-evidence.json" 2>/dev/null)" &&
     [[ "$LAST_OUTPUT" != *"$evidence_hmac"* &&
        "$LAST_OUTPUT" != *"$fixture_secret"* &&
        "$LAST_OUTPUT" != *"$manifest_body_sentinel"* ]] &&
     ! grep -Fq "$evidence_hmac" "$KUBECTL_LOG" &&
     ! grep -Fq "$fixture_secret" "$KUBECTL_LOG" &&
     ! grep -Fq "$manifest_body_sentinel" "$KUBECTL_LOG"; then
    pass 'checkpoint logs contain no secret, manifest body or cutover HMAC'
  else
    fail 'checkpoint log redaction for evidence and manifest inputs' \
      'sensitive fixture content reached command output or kubectl logs'
  fi

  for profile in runner intent; do
    run_durable_reconciled_profile_checkpoint_test "$output_root" "$profile"
    if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-durable &&
          "${YENHUBS_RECOVERY_TEST_CASE:-}" == stable-runner ]]; then
      return
    fi
  done

  output="$output_root/unknown"
  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  expect_failure 'durable checkpoint rejects an unknown runner-namespace Pod' \
    'runner_cutover_checkpoint_evidence_failed:' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=unknown \
    STUB_MONITOR_WATCH_PACE=1 RECOVERY_STREAM_POLL_SECONDS=1 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"
  if [[ ! -e "$output" ]] && ! grep -q \
      '/namespaces/hcce-bot-runners/pods/' "$KUBECTL_LOG"; then
    pass 'unknown durable Pod fails without any runner-namespace deletion'
  else
    fail 'unknown durable Pod no-delete fail-close' "$(cat "$KUBECTL_LOG")"
  fi

  run_durable_runner_fence_drift_checkpoint_tests "$output_root"
}

DURABLE_RESTORE_CHECKPOINT="$TMP_DIR/restore-fixtures/durable-v2"
SCHEMA3_LEGACY_RESTORE_CHECKPOINT="$TMP_DIR/restore-fixtures/legacy-absent-v3"

initialize_durable_restore_fixture() {
  if [[ ! -d "$DURABLE_RESTORE_CHECKPOINT" ]]; then
    mkdir -p "$(dirname "$DURABLE_RESTORE_CHECKPOINT")"
    reset_stub
    seed_recovery_operation_fence_binding_state dormant
    if LAST_OUTPUT="$(
      env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$VALUES_FIXTURE" \
        STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
        STUB_MONITOR_WATCH_PACE=1 \
        STUB_ARCHIVE_DELAY_SECONDS=1 \
        RECOVERY_STREAM_POLL_SECONDS=1 \
        "$ROOT_DIR/deployment/create-checkpoint.sh" \
        "$DURABLE_RESTORE_CHECKPOINT" 2>&1
    )"; then
      if [[ -f "$DURABLE_RESTORE_CHECKPOINT/checkpoint-metadata.json" &&
            -f "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" &&
            -f "$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json" ]]; then
        pass 'durable restore fixture is produced by the real checkpoint path'
      else
        fail 'durable restore fixture is produced by the real checkpoint path' \
          "command exited zero without the exact checkpoint layout: $LAST_OUTPUT"
        return 1
      fi
    else
      fail 'durable restore fixture is produced by the real checkpoint path' "$LAST_OUTPUT"
      return 1
    fi
    if ! grep -R -Eq \
        'yenhubs.org/(runner-cutover-evidence-sha256|runner-runtime-generation)' \
        "$STUB_STATE_DIR"/create-payload-*.yaml; then
      pass 'checkpoint-backup lock predates and omits restore-only evidence annotations'
    else
      fail 'checkpoint-backup lock omits restore-only evidence annotations' \
        "$(cat "$STUB_STATE_DIR"/create-payload-*.yaml)"
    fi
    if jq -e \
        --arg historical "$RUNNER_JOURNAL_BOOTSTRAP_MANIFEST_SHA" \
        --arg active "$RUNNER_ACTIVE_MANIFEST_SHA" \
        --argjson signed "$(jq -r '.data["journal.json"]' \
          "$RUNNER_EVIDENCE_LIVE_DIR/cutover-journal.json")" '
        .runtime_generation == "durable-v2" and
        .journal.state == "present" and
        .journal.hmac_verification == "verified-owner-key" and
        .journal.contract.manifest_sha256 == $historical and
        .journal.contract.manifest_sha256 == $signed.manifestSha256 and
        .journal.contract.manifest_sha256 != $active and
        .journal.contract.target_hashes == {
          journal_policy:$signed.targetHashes.journalPolicy,
          journal_binding:$signed.targetHashes.journalBinding,
          parent_policy:$signed.targetHashes.parentPolicy,
          parent_binding:$signed.targetHashes.parentBinding,
          parent_deployment:$signed.targetHashes.parentDeployment
        }
      ' "$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json" >/dev/null; then
      pass 'durable checkpoint preserves signed terminal bootstrap history under a different active manifest'
    else
      fail 'update-friendly historical journal preservation' \
        "$(jq -c '.journal' "$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json")"
    fi
  fi
  [[ -f "$DURABLE_RESTORE_CHECKPOINT/checkpoint-metadata.json" &&
     -f "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" &&
     -f "$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json" ]] || return 1
  DURABLE_RESTORE_DUMP_SHA="$(sha256_digest \
    "$DURABLE_RESTORE_CHECKPOINT/retdb-$STAMP.sql.gz")"
  DURABLE_RESTORE_STORAGE_SHA="$(sha256_digest \
    "$DURABLE_RESTORE_CHECKPOINT/ret-storage-$STAMP.tar.gz")"
  DURABLE_RESTORE_INVENTORY_SHA="$(sha256_digest \
    "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json")"
  DURABLE_RESTORE_EVIDENCE_SHA="$(sha256_digest \
    "$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json")"
}

initialize_schema3_legacy_restore_fixture() {
  if [[ ! -d "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT" ]]; then
    mkdir -p "$(dirname "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT")"
    reset_stub
    if LAST_OUTPUT="$(
      env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
        STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
        STUB_ARCHIVE_DELAY_SECONDS=1 \
        RECOVERY_STREAM_POLL_SECONDS=0.01 \
        "$ROOT_DIR/deployment/create-checkpoint.sh" \
        "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT" 2>&1
    )"; then
      pass 'schema-3 legacy restore fixture is produced by the real checkpoint path'
    else
      fail 'schema-3 legacy restore fixture is produced by the real checkpoint path' \
        "$LAST_OUTPUT"
      return 1
    fi
  fi
  [[ -f "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/checkpoint-metadata.json" &&
     -f "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/deployment-images.json" &&
     -f "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/runner-cutover-evidence.json" ]] || return 1
  SCHEMA3_LEGACY_DUMP_SHA="$(sha256_digest \
    "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/retdb-$STAMP.sql.gz")"
  SCHEMA3_LEGACY_STORAGE_SHA="$(sha256_digest \
    "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/ret-storage-$STAMP.tar.gz")"
  SCHEMA3_LEGACY_INVENTORY_SHA="$(sha256_digest \
    "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/deployment-images.json")"
  SCHEMA3_LEGACY_EVIDENCE_SHA="$(sha256_digest \
    "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/runner-cutover-evidence.json")"
}

start_checkpoint_backup_writer_guard() {
  local mode="$1" generation="$2" durable_baseline_path="$3"
  local durable_baseline_sha256="$4"
  local operation_owner="${5:-checkpoint-backup}"
  local guard_dump_sha256="${6:-$DUMP_SHA}"
  local guard_storage_sha256="${7:-$STORAGE_SHA}" _
  local checkpoint_metadata_schema="${RECOVERY_CHECKPOINT_METADATA_SCHEMA:-}"
  local checkpoint_metadata_copy="${RECOVERY_CHECKPOINT_METADATA_COPY:-}"
  local deployment_inventory_copy="${RECOVERY_DEPLOYMENT_INVENTORY_COPY:-}"
  local runner_cutover_evidence_copy="${RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY:-}"
  local deployment_inventory_sha256="${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}"
  local runner_cutover_evidence_sha256="${RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256:-}"
  local runner_runtime_generation="${RECOVERY_RUNNER_RUNTIME_GENERATION:-}"
  local info_path supervisor_log
  CHECKPOINT_BACKUP_WRITER_GUARD_DIR="$(mktemp -d \
    "$TMP_DIR/parent-writer-monitor.XXXXXX")" || return 1
  chmod 700 "$CHECKPOINT_BACKUP_WRITER_GUARD_DIR" || return 1
  CHECKPOINT_BACKUP_WRITER_GUARD_STOP="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/supervisor-stop"
  info_path="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/info.json"
  supervisor_log="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/supervisor.log"
  : >"$CHECKPOINT_BACKUP_WRITER_GUARD_STOP"
  chmod 600 "$CHECKPOINT_BACKUP_WRITER_GUARD_STOP"
  (
    set -euo pipefail
    writer_contract="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/writer-contract.json"
    writer_baseline="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/writer-baseline.json"
    writer_stop="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/writer-stop"
    writer_failure="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/writer-failure"
    writer_ready="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/writer-ready"
    writer_progress="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/writer-progress"
    writer_final="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/writer-final"
    durable_stop="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/durable-stop"
    durable_failure="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/durable-failure"
    durable_ready="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/durable-ready"
    durable_progress="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/durable-progress"
    durable_final="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/durable-final"
    writer_pid="" writer_identity="" writer_baseline_sha="" writer_authority_sha=""
    durable_pid="" durable_identity="" durable_capability_sha=""
    durable_authority_sha="" active_identity=""
    # shellcheck disable=SC2317,SC2329 # Invoked indirectly by EXIT/INT/TERM traps.
    cleanup_parent_monitor_fixture() {
      if [[ "${durable_pid:-}" =~ ^[1-9][0-9]*$ ]]; then
        kill -CONT "$durable_pid" 2>/dev/null || :
        recovery_discard_durable_runner_quiescence_monitor \
          "$durable_stop" "$durable_pid" "${durable_identity:-}" || :
      fi
      if [[ "${writer_pid:-}" =~ ^[1-9][0-9]*$ ]]; then
        kill -CONT "$writer_pid" 2>/dev/null || :
        recovery_discard_checkpoint_writer_monitor \
          "$writer_stop" "$writer_pid" "${writer_identity:-}" || :
      fi
      if [[ "${RECOVERY_SERIALIZATION_HEARTBEAT_PID:-}" =~ ^[1-9][0-9]*$ ]]; then
        printf 'stop\n' >"$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" \
          2>/dev/null || :
        if recovery_process_identity_is_live \
            "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" \
            "$RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY"; then
          kill -TERM "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null || :
          wait "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null || :
        elif ! kill -0 "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null; then
          wait "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null || :
        fi
        rm -f -- "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" \
          "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
        RECOVERY_SERIALIZATION_HEARTBEAT_PID=""
        RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY=""
      fi
    }
    trap cleanup_parent_monitor_fixture EXIT INT TERM
    printf '%s\n' "$RECOVERY_CONSUMER_CONTRACT_JSON" >"$writer_contract"
    : >"$writer_baseline"
    for marker in "$writer_stop" "$writer_failure" "$writer_ready" \
      "$writer_progress" "$writer_final"; do : >"$marker"; done
    chmod 600 "$writer_contract" "$writer_baseline" "$writer_stop" \
      "$writer_failure" "$writer_ready" "$writer_progress" "$writer_final"
    if [[ "$generation" == durable-v2 ]]; then
      for marker in "$durable_stop" "$durable_failure" "$durable_ready" \
        "$durable_progress" "$durable_final"; do : >"$marker"; done
      chmod 600 "$durable_stop" "$durable_failure" "$durable_ready" \
        "$durable_progress" "$durable_final"
    fi
    writer_contract_sha="$(sha256_digest "$writer_contract")"
    NAMESPACE=hcce
    EXPECTED_KUBE_CONTEXT=fixture-context
    EXPECTED_NAMESPACE_UID=fixture-uid
    # shellcheck disable=SC2030 # Set and consumed inside this supervisor subshell.
    EXPECTED_RET_PVC_UID=fixture-pvc-uid
    export NAMESPACE EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID \
      EXPECTED_RET_PVC_UID
    # shellcheck source=deployment/lib/recovery-safety.sh
    source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
    RECOVERY_NAMESPACE_UID=fixture-uid
    RECOVERY_PVC_UID=fixture-pvc-uid
    RECOVERY_CHECKPOINT_STAMP="$STAMP"
    RECOVERY_DUMP_SHA256="$guard_dump_sha256"
    RECOVERY_STORAGE_SHA256="$guard_storage_sha256"
    RECOVERY_CHECKPOINT_RUNNER_GENERATION="$generation"
    RECOVERY_CHECKPOINT_METADATA_SCHEMA="$checkpoint_metadata_schema"
    RECOVERY_CHECKPOINT_METADATA_COPY="$checkpoint_metadata_copy"
    RECOVERY_DEPLOYMENT_INVENTORY_COPY="$deployment_inventory_copy"
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY="$runner_cutover_evidence_copy"
    RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$deployment_inventory_sha256"
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256="$runner_cutover_evidence_sha256"
    RECOVERY_RUNNER_RUNTIME_GENERATION="$runner_runtime_generation"
    # shellcheck disable=SC2030 # Set and consumed inside this supervisor subshell.
    KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer"
    export RECOVERY_NAMESPACE_UID RECOVERY_PVC_UID RECOVERY_CHECKPOINT_STAMP \
      RECOVERY_DUMP_SHA256 RECOVERY_STORAGE_SHA256 \
      RECOVERY_CHECKPOINT_RUNNER_GENERATION RECOVERY_CHECKPOINT_METADATA_SCHEMA \
      RECOVERY_CHECKPOINT_METADATA_COPY RECOVERY_DEPLOYMENT_INVENTORY_COPY \
      RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY \
      RECOVERY_DEPLOYMENT_INVENTORY_SHA256 \
      RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256 \
      RECOVERY_RUNNER_RUNTIME_GENERATION KUBECTL_BIN \
      STUB_CHECKPOINT_WRITER_OPERATION_OWNER="$operation_owner"
    recovery_adopt_parent_operation_serialization \
      "$YENHUBS_PARENT_LEASE_HOLDER" "$YENHUBS_PARENT_LEASE_UID" \
      "$YENHUBS_PARENT_PROCESS_PID" \
      "$YENHUBS_PARENT_PROCESS_START_IDENTITY"
    RECOVERY_SERIALIZATION_PARENT_PID="$YENHUBS_PARENT_PROCESS_PID"
    RECOVERY_SERIALIZATION_PARENT_START_IDENTITY="$YENHUBS_PARENT_PROCESS_START_IDENTITY"
    # shellcheck disable=SC2030 # Set and consumed inside this supervisor subshell.
    RECOVERY_LEASE_HEARTBEAT_SECONDS=10
    export RECOVERY_SERIALIZATION_PARENT_PID \
      RECOVERY_SERIALIZATION_PARENT_START_IDENTITY \
      RECOVERY_LEASE_HEARTBEAT_SECONDS
    recovery_start_operation_serialization_heartbeat || exit 1
    recovery_start_checkpoint_writer_monitor \
      "$writer_contract" "$writer_contract_sha" "$writer_baseline" \
      "$writer_stop" "$writer_failure" "$writer_ready" "$writer_progress" \
      "$writer_final" writer_pid writer_identity writer_baseline_sha \
      "$generation" "$operation_owner" || exit 1
    writer_authority_sha="$(recovery_monitor_authority_sha256_for_ready \
      "$writer_ready")"
    if [[ "$generation" == durable-v2 ]]; then
      active_identity="$(recovery_read_recovery_operation_fence_state active)"
      recovery_start_durable_runner_quiescence_monitor \
        "$durable_baseline_path" "$durable_baseline_sha256" \
        "$writer_baseline" "$writer_baseline_sha" "$durable_stop" \
        "$durable_failure" "$durable_ready" "$durable_progress" \
        "$durable_final" durable_pid durable_identity durable_capability_sha \
        "$operation_owner" || exit 1
      durable_authority_sha="$(recovery_monitor_authority_sha256_for_ready \
        "$durable_ready")"
    fi
    jq -cn \
      --arg writer_contract "$writer_contract" \
      --arg writer_contract_sha "$writer_contract_sha" \
      --arg writer_baseline "$writer_baseline" \
      --arg writer_baseline_sha "$writer_baseline_sha" \
      --arg writer_pid "$writer_pid" --arg writer_identity "$writer_identity" \
      --arg writer_failure "$writer_failure" --arg writer_ready "$writer_ready" \
      --arg writer_progress "$writer_progress" \
      --arg writer_authority_sha "$writer_authority_sha" \
      --arg durable_pid "$durable_pid" --arg durable_identity "$durable_identity" \
      --arg durable_failure "$durable_failure" --arg durable_ready "$durable_ready" \
      --arg durable_progress "$durable_progress" \
      --arg durable_capability_sha "$durable_capability_sha" \
      --arg durable_authority_sha "$durable_authority_sha" \
      --arg active_identity "$active_identity" '
      {writer_contract:$writer_contract,writer_contract_sha:$writer_contract_sha,
       writer_baseline:$writer_baseline,writer_baseline_sha:$writer_baseline_sha,
       writer_pid:$writer_pid,writer_identity:$writer_identity,
       writer_failure:$writer_failure,writer_ready:$writer_ready,
       writer_progress:$writer_progress,writer_authority_sha:$writer_authority_sha,
       durable_pid:$durable_pid,durable_identity:$durable_identity,
       durable_failure:$durable_failure,durable_ready:$durable_ready,
       durable_progress:$durable_progress,
       durable_capability_sha:$durable_capability_sha,
       durable_authority_sha:$durable_authority_sha,
       active_identity:$active_identity}
    ' >"$info_path.next"
    chmod 600 "$info_path.next"
    mv "$info_path.next" "$info_path"
    while [[ ! -s "$CHECKPOINT_BACKUP_WRITER_GUARD_STOP" ]]; do sleep 0.01; done
  ) >"$supervisor_log" 2>&1 &
  # shellcheck disable=SC2031 # This shell owns the background supervisor PID.
  CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID=$!
  for _ in {1..2000}; do
    [[ -s "$info_path" ]] && break
    kill -0 "$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID" 2>/dev/null || {
      cat "$supervisor_log" >&2
      wait "$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID" 2>/dev/null || :
      rm -rf -- "$CHECKPOINT_BACKUP_WRITER_GUARD_DIR"
      CHECKPOINT_BACKUP_WRITER_GUARD_DIR=""
      CHECKPOINT_BACKUP_WRITER_GUARD_STOP=""
      CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID=""
      return 1
    }
    sleep 0.01
  done
  if [[ ! -s "$info_path" ]]; then
    cat "$supervisor_log" >&2
    kill -TERM "$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID" 2>/dev/null || :
    wait "$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID" 2>/dev/null || :
    rm -rf -- "$CHECKPOINT_BACKUP_WRITER_GUARD_DIR"
    CHECKPOINT_BACKUP_WRITER_GUARD_DIR=""
    CHECKPOINT_BACKUP_WRITER_GUARD_STOP=""
    CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID=""
    return 1
  fi
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$(jq -er '.writer_contract' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$(jq -er '.writer_contract_sha' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$(jq -er '.writer_baseline' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$(jq -er '.writer_baseline_sha' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_PID="$(jq -er '.writer_pid' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$(jq -er '.writer_identity' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$(jq -er '.writer_failure' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$(jq -er '.writer_ready' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$(jq -er '.writer_progress' "$info_path")"
  YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$(jq -er '.writer_authority_sha' "$info_path")"
  export YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256 \
    YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256 \
    YENHUBS_PARENT_WRITER_MONITOR_PID \
    YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY \
    YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_READY_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256
  # shellcheck disable=SC2031 # Outer function state is intentionally used after the child.
  if [[ "$generation" == durable-v2 ]]; then
    export YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH="$YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH"
    export YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256="$YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256"
    YENHUBS_PARENT_DURABLE_MONITOR_PID="$(jq -er '.durable_pid' "$info_path")"
    YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY="$(jq -er '.durable_identity' "$info_path")"
    YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH="$(jq -er '.durable_failure' "$info_path")"
    YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH="$(jq -er '.durable_ready' "$info_path")"
    YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH="$(jq -er '.durable_progress' "$info_path")"
    YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="$(jq -er '.durable_capability_sha' "$info_path")"
    YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$(jq -er '.durable_authority_sha' "$info_path")"
    YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY="$(jq -c '.active_identity | fromjson' "$info_path")"
    export YENHUBS_PARENT_DURABLE_MONITOR_PID \
      YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY \
      YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH \
      YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH \
      YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH \
      YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256 \
      YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256 \
      YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY
  fi
  # shellcheck disable=SC2031 # Outer function state is intentionally used after the child.
  if [[ "$mode" == stale ]]; then
    (
      while [[ ! -e "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-started" ]]; do
        kill -0 "$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID" 2>/dev/null || exit
        sleep 0.01
      done
      kill -STOP "$YENHUBS_PARENT_WRITER_MONITOR_PID"
    ) &
    # shellcheck disable=SC2031 # This shell owns the background helper PID.
    CHECKPOINT_BACKUP_WRITER_GUARD_STALE_HELPER_PID=$!
  fi
}

stop_checkpoint_backup_writer_guard() {
  if [[ "${YENHUBS_PARENT_WRITER_MONITOR_PID:-}" =~ ^[1-9][0-9]*$ ]]; then
    kill -CONT "$YENHUBS_PARENT_WRITER_MONITOR_PID" 2>/dev/null || :
  fi
  if [[ -n "${CHECKPOINT_BACKUP_WRITER_GUARD_STOP:-}" ]]; then
    printf 'stop\n' >"$CHECKPOINT_BACKUP_WRITER_GUARD_STOP" 2>/dev/null || :
  fi
  if [[ "${CHECKPOINT_BACKUP_WRITER_GUARD_STALE_HELPER_PID:-}" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$CHECKPOINT_BACKUP_WRITER_GUARD_STALE_HELPER_PID" 2>/dev/null || :
    wait "$CHECKPOINT_BACKUP_WRITER_GUARD_STALE_HELPER_PID" 2>/dev/null || :
  fi
  if [[ "${CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID:-}" =~ ^[1-9][0-9]*$ ]]; then
    wait "$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID" 2>/dev/null || :
  fi
  unset YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256 \
    YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256 \
    YENHUBS_PARENT_WRITER_MONITOR_PID \
    YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY \
    YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_READY_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH \
    YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256 \
    YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH \
    YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256 \
    YENHUBS_PARENT_DURABLE_MONITOR_PID \
    YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY \
    YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH \
    YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH \
    YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH \
    YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256 \
    YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256 \
    YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY
  if [[ -n "${CHECKPOINT_BACKUP_WRITER_GUARD_DIR:-}" ]]; then
    rm -rf -- "$CHECKPOINT_BACKUP_WRITER_GUARD_DIR"
  fi
  CHECKPOINT_BACKUP_WRITER_GUARD_DIR=""
  CHECKPOINT_BACKUP_WRITER_GUARD_STOP=""
  CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID=""
  CHECKPOINT_BACKUP_WRITER_GUARD_STALE_HELPER_PID=""
}

run_checkpoint_backup_child() {
  local child="$1" output_root="$2" generation="$3" baseline_path="$4"
  local baseline_sha="$5" profile="$6" inventory_path="$7"
  local writer_guard_mode="${8:-healthy}" child_status=0
  local expected_pvc_uid="${9:-fixture-pvc-uid}"
  local runner_namespace="" deployments_json="$LEGACY_DEPLOYMENTS_JSON"
  local child_stub_mode="${STUB_MODE:-}" guard_max_stale_seconds=""
  local db_dump_delay_seconds=0.2
  local writer_pid="" writer_identity="" writer_progress="" writer_authority=""
  if [[ "$generation" == durable-v2 ]]; then
    runner_namespace=present
    deployments_json="$KUBERNETES_DEPLOYMENTS_JSON"
    seed_recovery_operation_fence_binding_state active
  fi
  case "$child_stub_mode" in
    db-source-monitor-uid-drift|db-source-monitor-replacement|\
      db-source-monitor-stall)
      db_dump_delay_seconds=10
      guard_max_stale_seconds=10
      ;;
  esac
  case "$writer_guard_mode" in
    healthy)
      STUB_DEPLOYMENTS_JSON="$deployments_json" \
        STUB_RUNNER_NAMESPACE="$runner_namespace" \
        STUB_RUNNER_POD_PROFILE="$profile" \
        start_checkpoint_backup_writer_guard healthy "$generation" \
          "$baseline_path" "$baseline_sha" || return 1
      ;;
    stale)
      STUB_DEPLOYMENTS_JSON="$deployments_json" \
        STUB_RUNNER_NAMESPACE="$runner_namespace" \
        STUB_RUNNER_POD_PROFILE="$profile" \
        start_checkpoint_backup_writer_guard stale "$generation" \
          "$baseline_path" "$baseline_sha" || return 1
      child_stub_mode='checkpoint-parent-writer-guard-stale'
      # Exercise the production ten-second budget. The stream reserves two
      # seconds for revocation/reaping and includes the whole-second Lease
      # request in that budget before deliberately becoming stale.
      guard_max_stale_seconds=10
      ;;
    partial-pid|partial-start|partial-failure|partial-ready|partial-progress|partial-authority|generic-pid|swap-pids|swap-progress|swap-authority|authority-tamper|dead-writer)
      STUB_DEPLOYMENTS_JSON="$deployments_json" \
        STUB_RUNNER_NAMESPACE="$runner_namespace" \
        STUB_RUNNER_POD_PROFILE="$profile" \
        start_checkpoint_backup_writer_guard healthy "$generation" \
          "$baseline_path" "$baseline_sha" || return 1
      case "$writer_guard_mode" in
        partial-pid) unset YENHUBS_PARENT_WRITER_MONITOR_PID ;;
        partial-start) unset YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY ;;
        partial-failure) unset YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH ;;
        partial-ready) unset YENHUBS_PARENT_WRITER_MONITOR_READY_PATH ;;
        partial-progress) unset YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH ;;
        partial-authority) unset YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256 ;;
        generic-pid)
          YENHUBS_PARENT_WRITER_MONITOR_PID="$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID"
          YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$(
            # shellcheck disable=SC2016 # Positional arguments expand in the isolated Bash process.
            bash -c 'source "$1"; recovery_process_start_identity "$2"' _ \
              "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
              "$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID"
          )"
          export YENHUBS_PARENT_WRITER_MONITOR_PID \
            YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY
          ;;
        swap-pids)
          [[ "$generation" == durable-v2 ]] || return 2
          writer_pid="$YENHUBS_PARENT_WRITER_MONITOR_PID"
          writer_identity="$YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY"
          YENHUBS_PARENT_WRITER_MONITOR_PID="$YENHUBS_PARENT_DURABLE_MONITOR_PID"
          YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY"
          YENHUBS_PARENT_DURABLE_MONITOR_PID="$writer_pid"
          YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY="$writer_identity"
          export YENHUBS_PARENT_WRITER_MONITOR_PID \
            YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY \
            YENHUBS_PARENT_DURABLE_MONITOR_PID \
            YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY
          ;;
        swap-progress)
          [[ "$generation" == durable-v2 ]] || return 2
          writer_progress="$YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH"
          YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH"
          YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH="$writer_progress"
          export YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH \
            YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH
          ;;
        swap-authority)
          [[ "$generation" == durable-v2 ]] || return 2
          writer_authority="$YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256"
          YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256"
          YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$writer_authority"
          export YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256 \
            YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256
          ;;
        authority-tamper)
          printf '\n' >>"${YENHUBS_PARENT_WRITER_MONITOR_READY_PATH}.authority.json"
          ;;
        dead-writer)
          kill -TERM "$YENHUBS_PARENT_WRITER_MONITOR_PID" 2>/dev/null || :
          for _ in {1..200}; do
            kill -0 "$YENHUBS_PARENT_WRITER_MONITOR_PID" 2>/dev/null || break
            sleep 0.01
          done
          ;;
      esac
      ;;
    missing)
      unset YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH \
        YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256 \
        YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH \
        YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256 \
        YENHUBS_PARENT_WRITER_MONITOR_PID \
        YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY \
        YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH \
        YENHUBS_PARENT_WRITER_MONITOR_READY_PATH \
        YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH \
        YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256 \
        YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH \
        YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256 \
        YENHUBS_PARENT_DURABLE_MONITOR_PID \
        YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY \
        YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH \
        YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH \
        YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH \
        YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256 \
        YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256 \
        YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY
      ;;
    *) return 2 ;;
  esac
  mkdir -p "$output_root"
  case "$child" in
    db)
      if env BACKUP_COORDINATED=1 EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID="$expected_pvc_uid" \
        RECOVERY_CHECKPOINT_STAMP="$STAMP" RECOVERY_DUMP_SHA256="$DUMP_SHA" \
        RECOVERY_STORAGE_SHA256="$STORAGE_SHA" \
        RECOVERY_NAMESPACE_UID=fixture-uid RECOVERY_PVC_UID=fixture-pvc-uid \
        CHECKPOINT_RUNNER_GENERATION="$generation" \
        CHECKPOINT_DURABLE_FENCE_BASELINE_PATH="$baseline_path" \
        CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256="$baseline_sha" \
        RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
        STUB_DEPLOYMENTS_JSON="$deployments_json" \
        STUB_RUNNER_NAMESPACE="$runner_namespace" \
        STUB_RUNNER_POD_PROFILE="$profile" \
        STUB_MODE="$child_stub_mode" \
        STUB_DB_DUMP_DELAY_SECONDS="$db_dump_delay_seconds" \
        RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS="$guard_max_stale_seconds" \
        "$ROOT_DIR/deployment/backup-retdb.sh" \
        "$output_root/retdb-$STAMP.sql.gz"; then
        child_status=0
      else
        child_status=$?
      fi
      ;;
    storage)
      if env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
        EXPECTED_RET_PVC_UID="$expected_pvc_uid" \
        RECOVERY_CHECKPOINT_STAMP="$STAMP" RECOVERY_DUMP_SHA256="$DUMP_SHA" \
        RECOVERY_STORAGE_SHA256="$STORAGE_SHA" \
        RECOVERY_NAMESPACE_UID=fixture-uid RECOVERY_PVC_UID=fixture-pvc-uid \
        CHECKPOINT_RUNNER_GENERATION="$generation" \
        CHECKPOINT_DURABLE_FENCE_BASELINE_PATH="$baseline_path" \
        CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256="$baseline_sha" \
        RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
        STUB_DEPLOYMENTS_JSON="$deployments_json" \
        STUB_RUNNER_NAMESPACE="$runner_namespace" \
        STUB_RUNNER_POD_PROFILE="$profile" \
        STUB_MODE="$child_stub_mode" \
        RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS="$guard_max_stale_seconds" \
        STUB_ARCHIVE_DELAY_SECONDS=1 \
        RECOVERY_STREAM_POLL_SECONDS=0.01 \
        "$ROOT_DIR/deployment/backup-ret-storage-quiesced.sh" \
        "$output_root/ret-storage-$STAMP.tar.gz" "$inventory_path"; then
        child_status=0
      else
        child_status=$?
      fi
      ;;
    *) return 2 ;;
  esac
  [[ "$writer_guard_mode" == missing ]] || stop_checkpoint_backup_writer_guard
  return "$child_status"
}

seed_already_fenced_legacy_restore_lock() {
  local deployment
  seed_restore_lock adopted || return 1
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '%s' 0 >"$STUB_STATE_DIR/replicas-$deployment"
    printf '%s' 2 >"$STUB_STATE_DIR/rv-$deployment"
  done
}

run_guarded_legacy_restore_child() {
  local child="$1" input_path="$2" child_status=0
  local child_stub_mode="${3:-${STUB_MODE:-}}"
  local child_db_contract="${4:-$STUB_DB_CONTRACT}"
  local writer_guard_mode="${5:-healthy}" guard_max_stale_seconds=""
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    seed_already_fenced_legacy_restore_lock || return 1
  RECOVERY_CHECKPOINT_METADATA_SCHEMA=2
  RECOVERY_CHECKPOINT_METADATA_COPY="$GOOD_CHECKPOINT/checkpoint-metadata.json"
  RECOVERY_DEPLOYMENT_INVENTORY_COPY="$GOOD_CHECKPOINT/deployment-images.json"
  RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY=""
  export RECOVERY_CHECKPOINT_METADATA_SCHEMA RECOVERY_CHECKPOINT_METADATA_COPY \
    RECOVERY_DEPLOYMENT_INVENTORY_COPY RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY
  case "$child_stub_mode" in
    restore-db-monitor-exit|restore-db-monitor-stall|\
      restore-storage-monitor-exit|restore-storage-monitor-stall|\
      checkpoint-parent-writer-guard-stale)
      guard_max_stale_seconds=9
      ;;
  esac
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
    start_checkpoint_backup_writer_guard "$writer_guard_mode" legacy-absent '' '' \
      checkpoint-restore || return 1
  case "$child" in
    db)
      if env EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
        KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
        STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
        STUB_MODE="$child_stub_mode" STUB_DB_CONTRACT="$child_db_contract" \
        RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS="$guard_max_stale_seconds" \
        RESTORE_COORDINATED=1 \
        RESTORE_ALREADY_FENCED=1 CONFIRM_RESTORE="$CONFIRM_DB" \
        RECOVERY_STREAM_POLL_SECONDS=0.01 \
        "$ROOT_DIR/deployment/restore-retdb.sh" "$input_path"; then
        child_status=0
      else
        child_status=$?
      fi
      ;;
    storage)
      if env EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
        KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
        STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
        STUB_MODE="$child_stub_mode" STUB_DB_CONTRACT="$child_db_contract" \
        RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS="$guard_max_stale_seconds" \
        RESTORE_COORDINATED=1 \
        CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" \
        RECOVERY_STREAM_POLL_SECONDS=0.01 \
        "$ROOT_DIR/deployment/restore-ret-storage.sh" "$input_path"; then
        child_status=0
      else
        child_status=$?
      fi
      ;;
    *)
      stop_checkpoint_backup_writer_guard
      return 2
      ;;
  esac
  stop_checkpoint_backup_writer_guard
  return "$child_status"
}

restore_stream_group_is_reaped() {
  local marker_prefix="$1" observer_prefix="$2"
  local stream_pid stream_pgid grandchild_pid observer_pid
  local group_state="" grandchild_state="" observer_state="" _
  stream_pid="$(cat "$STUB_STATE_DIR/$marker_prefix-pid" 2>/dev/null || :)"
  stream_pgid="$(cat "$STUB_STATE_DIR/$marker_prefix-pgid" 2>/dev/null || :)"
  grandchild_pid="$(cat \
    "$STUB_STATE_DIR/$marker_prefix-grandchild-pid" 2>/dev/null || :)"
  observer_pid="$(cat \
    "$STUB_STATE_DIR/$observer_prefix-observer-pid" 2>/dev/null || :)"
  for _ in {1..400}; do
    group_state="$(
      ps -axo pgid=,stat=,pid= 2>/dev/null |
        awk -v pgid="$stream_pgid" \
          '$1 == pgid && $2 !~ /^Z/ {print $2 ":" $3; exit}' || :
    )"
    grandchild_state="$(
      ps -o stat= -p "$grandchild_pid" 2>/dev/null |
        awk '{$1=$1; print}' || :
    )"
    observer_state="$(
      ps -o stat= -p "$observer_pid" 2>/dev/null |
        awk '{$1=$1; print}' || :
    )"
    if [[ -z "$group_state" &&
          ( -z "$grandchild_state" || "$grandchild_state" == Z* ) &&
          ( -z "$observer_state" || "$observer_state" == Z* ) ]]; then
      break
    fi
    sleep 0.01
  done
  [[ "$stream_pid" =~ ^[1-9][0-9]*$ &&
     "$stream_pgid" =~ ^[1-9][0-9]*$ &&
     "$grandchild_pid" =~ ^[1-9][0-9]*$ &&
     -e "$STUB_STATE_DIR/$marker_prefix-started" &&
     -e "$STUB_STATE_DIR/$marker_prefix-terminated" &&
     ! -e "$STUB_STATE_DIR/$marker_prefix-completed" &&
     -z "$group_state" &&
     ( -z "$grandchild_state" || "$grandchild_state" == Z* ) &&
     ( -z "$observer_state" || "$observer_state" == Z* ) ]]
}

write_monotonic_ns_marker() {
  python3 -I -c 'import time; print(time.time_ns())' >"$1"
}

restore_stream_revocation_is_under_seconds() {
  local start_marker="$1" end_marker="$2" maximum_seconds="$3"
  local started_at ended_at
  started_at="$(cat "$start_marker" 2>/dev/null || :)"
  ended_at="$(cat "$end_marker" 2>/dev/null || :)"
  [[ "$started_at" =~ ^[1-9][0-9]*$ &&
     "$ended_at" =~ ^[1-9][0-9]*$ &&
     "$maximum_seconds" =~ ^[1-9][0-9]*$ ]] || return 1
  ((ended_at >= started_at &&
    ended_at - started_at < maximum_seconds * 1000000000))
}

legacy_restore_failure_retains_authority() {
  local deployment
  [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] || return 1
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    [[ "$(cat "$STUB_STATE_DIR/replicas-$deployment" 2>/dev/null || :)" == 0 ]] ||
      return 1
  done
  ! grep -Eq \
    'patch deployment .*"op":"replace","path":"/spec/replicas","value":1|delete --raw=.*/configmaps/yenhubs-recovery-operation-lock' \
    "$KUBECTL_LOG"
}

run_legacy_restore_lock_contract_probe() {
  reset_stub
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    seed_already_fenced_legacy_restore_lock || return 1
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  env EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    bash -c '
      set -euo pipefail
      NAMESPACE=hcce
      source "$1"
      cleanup_probe() {
        status=$?
        trap - EXIT
        recovery_cleanup_materialized_checkpoint >/dev/null 2>&1 || :
        exit "$status"
      }
      probe() {
        label="$1"
        shift
        if "$@"; then
          printf "probe_ok:%s\n" "$label"
        else
          printf "probe_failed:%s\n" "$label" >&2
          exit 1
        fi
      }
      json_value_is() {
        path="$1"
        expected="$2"
        jq -e --arg expected "$expected" "$path == \$expected" \
          >/dev/null <<<"$lock_json"
      }
      trap cleanup_probe EXIT
      probe materialization recovery_materialize_checkpoint "$2" "$3"
      probe cluster-identity recovery_require_cluster_identity
      probe pvc-identity recovery_require_pvc_identity ret-pvc
      probe target-binding recovery_require_restore_target_binding
      probe metadata-schema test "$RECOVERY_CHECKPOINT_METADATA_SCHEMA" = 2
      probe runner-generation test "$RECOVERY_RUNNER_RUNTIME_GENERATION" = legacy-absent
      probe operation-state test "$RECOVERY_OPERATION_STATE" = legacy-in-place
      probe operation-binding-empty test -z "${RECOVERY_OPERATION_BINDING_SHA256:-}"
      probe inventory-binding test "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" = \
        "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256"
      probe materialized-runner-binding \
        recovery_materialized_legacy_runner_binding_is_valid
      probe runner-operation-contract \
        recovery_operation_runner_contract_is_valid checkpoint-restore
      recovery_adopt_parent_operation_serialization \
        "$YENHUBS_PARENT_LEASE_HOLDER" "$YENHUBS_PARENT_LEASE_UID" \
        "$YENHUBS_PARENT_PROCESS_PID" \
        "$YENHUBS_PARENT_PROCESS_START_IDENTITY"
      lock_json="$(recovery_kubectl get configmap \
        "$RECOVERY_OPERATION_LOCK_NAME" -n "$NAMESPACE" -o json)"
      probe api-version json_value_is ".apiVersion" v1
      probe kind json_value_is ".kind" ConfigMap
      probe name json_value_is ".metadata.name" "$RECOVERY_OPERATION_LOCK_NAME"
      probe namespace json_value_is ".metadata.namespace" "$NAMESPACE"
      probe uid json_value_is ".metadata.uid" "$RECOVERY_OPERATION_LOCK_UID"
      probe resource-version json_value_is ".metadata.resourceVersion" \
        "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION"
      probe owner json_value_is \
        ".metadata.labels[\"yenhubs.org/recovery-owner\"]" \
        "$RECOVERY_OPERATION_OWNER"
      probe operation-id json_value_is \
        ".metadata.annotations[\"yenhubs.org/operation-id\"]" \
        "$RECOVERY_OPERATION_ID"
      probe token json_value_is \
        ".metadata.annotations[\"yenhubs.org/recovery-token\"]" \
        "$RECOVERY_OPERATION_TOKEN"
      probe namespace-uid json_value_is \
        ".metadata.annotations[\"yenhubs.org/namespace-uid\"]" \
        "$RECOVERY_NAMESPACE_UID"
      probe pvc-uid json_value_is \
        ".metadata.annotations[\"yenhubs.org/pvc-uid\"]" \
        "$RECOVERY_PVC_UID"
      probe stamp json_value_is \
        ".metadata.annotations[\"yenhubs.org/checkpoint-stamp\"]" \
        "$RECOVERY_CHECKPOINT_STAMP"
      probe dump-sha json_value_is \
        ".metadata.annotations[\"yenhubs.org/dump-sha256\"]" \
        "$RECOVERY_DUMP_SHA256"
      probe storage-sha json_value_is \
        ".metadata.annotations[\"yenhubs.org/storage-sha256\"]" \
        "$RECOVERY_STORAGE_SHA256"
      probe inventory-sha json_value_is \
        ".metadata.annotations[\"yenhubs.org/deployment-inventory-sha256\"]" \
        "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256"
      probe recovery-state json_value_is \
        ".metadata.annotations[\"yenhubs.org/recovery-state\"]" \
        "$RECOVERY_OPERATION_STATE"
      probe runner-evidence json_value_is \
        ".metadata.annotations[\"yenhubs.org/runner-cutover-evidence-sha256\"]" \
        "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256"
      probe runner-runtime json_value_is \
        ".metadata.annotations[\"yenhubs.org/runner-runtime-generation\"]" \
        "$RECOVERY_RUNNER_RUNTIME_GENERATION"
      probe annotation-keyset jq -e \
        "(.metadata.annotations | keys | sort) == ([\"yenhubs.org/checkpoint-stamp\",\"yenhubs.org/deployment-inventory-sha256\",\"yenhubs.org/dump-sha256\",\"yenhubs.org/namespace-uid\",\"yenhubs.org/operation-id\",\"yenhubs.org/pvc-uid\",\"yenhubs.org/recovery-state\",\"yenhubs.org/recovery-token\",\"yenhubs.org/runner-cutover-evidence-sha256\",\"yenhubs.org/runner-runtime-generation\",\"yenhubs.org/storage-sha256\"] | sort)" \
        >/dev/null <<<"$lock_json"
      probe immutable jq -e ".immutable == true" >/dev/null <<<"$lock_json"
      probe exact-lock recovery_operation_lock_json_is_exact "$lock_json"
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
    "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" \
    "$ROOT_DIR/deployment/validate-checkpoint.sh"
}

run_restore_child_stream_guard_tests() {
  local child input_path mode marker_prefix observer_prefix total_elapsed
  for child in db storage; do
    if [[ "$child" == db ]]; then
      input_path="$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
      marker_prefix=restore-db-stream
      observer_prefix=restore-db-monitor
    else
      input_path="$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
      marker_prefix=restore-storage-stream
      observer_prefix=restore-storage-monitor
    fi
    for mode in exit stall; do
      reset_stub
      total_elapsed=$SECONDS
      expect_failure "$child restore aborts on local monitor $mode during its destructive stream" '' \
        run_guarded_legacy_restore_child "$child" "$input_path" \
        "restore-$child-monitor-$mode"
      total_elapsed=$((SECONDS - total_elapsed))
      if restore_stream_revocation_is_under_seconds \
           "$STUB_STATE_DIR/$observer_prefix-inflight-observed" \
           "$STUB_STATE_DIR/$marker_prefix-terminated" 10 &&
         restore_stream_group_is_reaped "$marker_prefix" "$observer_prefix" &&
         legacy_restore_failure_retains_authority; then
        pass "$child local monitor $mode reaps the exact stream group under ten seconds and retains the lock"
      else
        fail "$child local monitor $mode exact cancellation boundary" \
          "total_elapsed=$total_elapsed output=$LAST_OUTPUT group=$(cat "$STUB_STATE_DIR/$marker_prefix-pgid" 2>/dev/null || printf missing) observed=$(cat "$STUB_STATE_DIR/$observer_prefix-inflight-observed" 2>/dev/null || printf missing) terminated=$(cat "$STUB_STATE_DIR/$marker_prefix-terminated" 2>/dev/null || printf missing) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
      fi
    done

    reset_stub
    total_elapsed=$SECONDS
    expect_failure "$child restore aborts when its parent writer capability becomes stale in-flight" '' \
      run_guarded_legacy_restore_child "$child" "$input_path" \
      checkpoint-parent-writer-guard-stale "$STUB_DB_CONTRACT" stale
    total_elapsed=$((SECONDS - total_elapsed))
    if restore_stream_revocation_is_under_seconds \
         "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-started" \
         "$STUB_STATE_DIR/$marker_prefix-terminated" 10 &&
       restore_stream_group_is_reaped "$marker_prefix" "$observer_prefix" &&
       legacy_restore_failure_retains_authority; then
      pass "$child stale parent writer capability reaps the stream group and retains authority"
    else
      fail "$child stale parent writer capability exact cancellation boundary" \
        "total_elapsed=$total_elapsed output=$LAST_OUTPUT started=$(cat "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-started" 2>/dev/null || printf missing) terminated=$(cat "$STUB_STATE_DIR/$marker_prefix-terminated" 2>/dev/null || printf missing) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
    fi
  done
}

run_legacy_restore_runner_reappearance_tests() {
  reset_stub
  expect_failure 'residual managed bot-runner blocks DB restore before drop' \
    'Pods still remain for managed bot-runner' \
    run_guarded_legacy_restore_child db \
    "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" runner-reappears
  if [[ "$LAST_OUTPUT" == *'database_restore_stage:quiescence'* &&
        "$LAST_OUTPUT" == *'database_restore_quiescence_guard:runner-absence'* ]]; then
    pass 'runner residual emits only the closed quiescence guard diagnostic'
  else
    fail 'runner residual reports its exact closed quiescence guard' "$LAST_OUTPUT"
  fi
  if grep -q dropdb "$KUBECTL_LOG"; then
    fail 'runner residual performs no DB drop' "$(cat "$KUBECTL_LOG")"
  else
    pass 'runner residual performs no DB drop'
  fi

  reset_stub
  expect_failure 'managed bot-runner timeout blocks DB restore before drop' \
    'Timed out waiting for managed bot-runner pods' \
    run_guarded_legacy_restore_child db \
    "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" runner-reappears-timeout
  if [[ "$LAST_OUTPUT" == *'database_restore_stage:quiescence'* &&
        "$LAST_OUTPUT" == *'database_restore_quiescence_guard:runner-absence'* ]]; then
    pass 'runner timeout emits only the closed quiescence guard diagnostic'
  else
    fail 'runner timeout reports its exact closed quiescence guard' "$LAST_OUTPUT"
  fi
  if grep -q dropdb "$KUBECTL_LOG"; then
    fail 'runner timeout performs no DB drop' "$(cat "$KUBECTL_LOG")"
  else
    pass 'runner timeout performs no DB drop'
  fi
}

run_checkpoint_backup_child_guard_tests() {
  local child case_name case_root baseline_path baseline_sha profile
  local sequence=0 inventory_path output_path started_at
  local focused_case="${YENHUBS_RECOVERY_TEST_CASE:-}"
  initialize_durable_restore_fixture || return 1
  initialize_schema3_legacy_restore_fixture || return 1
  if [[ "$focused_case" != db-source-monitor-abort ]]; then
  for child in db storage; do
    sequence=$((sequence + 1))
    case_root="$TMP_DIR/backup-child-$child-$sequence-missing-writer-guard"
    baseline_path="$case_root/fences.json"
    mkdir -p "$case_root"
    cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
    chmod 600 "$baseline_path"
    baseline_sha="$(sha256_digest "$baseline_path")"
    reset_stub
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
      seed_checkpoint_backup_guard
    expect_failure "$child child rejects a missing parent writer-monitor guard" \
      'parent writer monitor guard' \
      run_checkpoint_backup_child "$child" "$case_root/output" durable-v2 \
        "$baseline_path" "$baseline_sha" fence-stable \
        "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" missing
    if ! grep -Eq 'pg_dump -U|tar -C /storage -cf - owned' "$KUBECTL_LOG"; then
      pass "$child missing writer guard is rejected before backup streaming"
    else
      fail "$child missing writer guard crossed the stream boundary" \
        "$(cat "$KUBECTL_LOG")"
    fi

    for case_name in partial-pid partial-start partial-failure partial-ready \
      partial-progress partial-authority generic-pid swap-pids swap-progress \
      swap-authority authority-tamper dead-writer; do
      sequence=$((sequence + 1))
      case_root="$TMP_DIR/backup-child-$child-$sequence-$case_name-writer-guard"
      baseline_path="$case_root/fences.json"
      mkdir -p "$case_root"
      cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
      chmod 600 "$baseline_path"
      baseline_sha="$(sha256_digest "$baseline_path")"
      reset_stub
      STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
        seed_checkpoint_backup_guard
      expect_failure "$child child rejects writer-monitor guard $case_name" \
        'parent writer monitor guard' \
        run_checkpoint_backup_child "$child" "$case_root/output" durable-v2 \
          "$baseline_path" "$baseline_sha" fence-stable \
          "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" "$case_name"
      if ! grep -Eq 'pg_dump -U|tar -C /storage -cf - owned' "$KUBECTL_LOG"; then
        pass "$child writer guard $case_name is rejected before backup streaming"
      else
        fail "$child writer guard $case_name crossed the stream boundary" \
          "$(cat "$KUBECTL_LOG")"
      fi
    done

    sequence=$((sequence + 1))
    case_root="$TMP_DIR/backup-child-$child-$sequence-stable"
    baseline_path="$case_root/fences.json"
    mkdir -p "$case_root"
    cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
    chmod 600 "$baseline_path"
    baseline_sha="$(sha256_digest "$baseline_path")"
    reset_stub
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
      seed_checkpoint_backup_guard
    expect_success "$child child accepts the exact immutable durable fence baseline" \
      run_checkpoint_backup_child "$child" "$case_root/output" durable-v2 \
        "$baseline_path" "$baseline_sha" fence-stable \
        "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json"
    if [[ "$child" != db ]]; then
      :
    elif [[ -e "$STUB_STATE_DIR/db-source-monitor-inflight-observed" &&
            -e "$STUB_STATE_DIR/db-source-monitor-stream-completed" &&
            -f "$case_root/output/retdb-$STAMP.sql.gz" &&
            -f "$case_root/output/database-contract.json" ]]; then
      pass 'durable DB source monitor sweeps the exact PostgreSQL identity in flight'
    else
      fail 'durable DB source monitor positive in-flight sweep' \
        "$(cat "$KUBECTL_LOG")"
    fi
    if ! grep -q 'yenhubs.org/deployment-inventory-sha256:' \
        "$STUB_STATE_DIR/restore-lock.yaml"; then
      pass "$child checkpoint-backup lock omits restore-only inventory SHA"
    else
      fail "$child checkpoint-backup lock contains restore inventory SHA" \
        "$(cat "$STUB_STATE_DIR/restore-lock.yaml")"
    fi

    sequence=$((sequence + 1))
    case_root="$TMP_DIR/backup-child-$child-$sequence-stale-writer-guard"
    baseline_path="$case_root/fences.json"
    mkdir -p "$case_root"
    cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
    chmod 600 "$baseline_path"
    baseline_sha="$(sha256_digest "$baseline_path")"
    reset_stub
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
      seed_checkpoint_backup_guard
    started_at="$SECONDS"
    expect_failure "$child child aborts when the parent writer monitor becomes stale" '' \
      run_checkpoint_backup_child "$child" "$case_root/output" durable-v2 \
        "$baseline_path" "$baseline_sha" fence-stable \
        "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" stale
    output_path="$case_root/output/$([[ "$child" == db ]] && \
      printf 'retdb-%s.sql.gz' "$STAMP" || \
      printf 'ret-storage-%s.tar.gz' "$STAMP")"
    if [[ -e "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-started" &&
          ! -e "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-completed" &&
          ! -e "$output_path" ]]; then
      pass "$child stale parent writer guard revokes the in-flight stream"
    else
      fail "$child stale parent writer guard did not revoke the in-flight stream" \
        "elapsed=$((SECONDS - started_at)) completed=$([[ -e "$STUB_STATE_DIR/checkpoint-parent-writer-guard-stream-completed" ]] && printf yes || printf no) output=$([[ -e "$output_path" ]] && printf present || printf absent) child=${LAST_OUTPUT:-empty} log=$(cat "$KUBECTL_LOG")"
    fi

    for case_name in missing symlink non-0600 wrong-sha same-size-mutated \
      same-size-replaced; do
      sequence=$((sequence + 1))
      case_root="$TMP_DIR/backup-child-$child-$sequence-$case_name"
      baseline_path="$case_root/fences.json"
      mkdir -p "$case_root"
      baseline_sha="$DURABLE_FENCE_BASELINE_SHA"
      case "$case_name" in
        missing) ;;
        symlink)
          ln -s "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
          ;;
        non-0600)
          cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
          chmod 644 "$baseline_path"
          ;;
        wrong-sha)
          cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
          chmod 600 "$baseline_path"
          baseline_sha="$(printf '0%.0s' {1..64})"
          ;;
        same-size-mutated)
          sed 's/fence-uid-1/fence-uid-2/' \
            "$DURABLE_FENCE_BASELINE_FIXTURE" >"$baseline_path"
          chmod 600 "$baseline_path"
          ;;
        same-size-replaced)
          cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
          rm "$baseline_path"
          sed 's/aaaaaaaaaaaaaaaaaaaa/caaaaaaaaaaaaaaaaaaa/' \
            "$DURABLE_FENCE_BASELINE_FIXTURE" >"$baseline_path"
          chmod 600 "$baseline_path"
          ;;
      esac
      reset_stub
      STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
        seed_checkpoint_backup_guard
      expect_failure "$child child rejects durable baseline $case_name" '' \
        run_checkpoint_backup_child "$child" "$case_root/output" durable-v2 \
          "$baseline_path" "$baseline_sha" fence-stable \
          "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json"
      output_path="$case_root/output/$([[ "$child" == db ]] && \
        printf 'retdb-%s.sql.gz' "$STAMP" || \
        printf 'ret-storage-%s.tar.gz' "$STAMP")"
      if [[ ! -e "$output_path" ]] &&
         ! grep -Eq 'pg_dump -U|tar -C /storage -cf - owned' "$KUBECTL_LOG"; then
        pass "$child $case_name baseline rejection emits no backup bytes"
      else
        fail "$child $case_name baseline rejection crossed the stream boundary" \
          "$(cat "$KUBECTL_LOG")"
      fi
    done

    for profile in empty historical-fence-replaced intent runner unknown; do
      sequence=$((sequence + 1))
      case_root="$TMP_DIR/backup-child-$child-$sequence-live-$profile"
      baseline_path="$case_root/fences.json"
      mkdir -p "$case_root"
      cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
      chmod 600 "$baseline_path"
      baseline_sha="$(sha256_digest "$baseline_path")"
      reset_stub
      STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
        seed_checkpoint_backup_guard
      expect_failure "$child child rejects durable live fence state $profile" '' \
        run_checkpoint_backup_child "$child" "$case_root/output" durable-v2 \
          "$baseline_path" "$baseline_sha" "$profile" \
          "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json"
    done

    sequence=$((sequence + 1))
    case_root="$TMP_DIR/backup-child-$child-$sequence-legacy-zero"
    reset_stub
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
      seed_checkpoint_backup_guard
    expect_success "$child legacy child retains strict zero-Pod absence semantics" \
      run_checkpoint_backup_child "$child" "$case_root/output" legacy-absent \
        "" "" "" "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/deployment-images.json"
    if [[ "$child" != db ]]; then
      :
    elif [[ -e "$STUB_STATE_DIR/db-source-monitor-inflight-observed" &&
            -e "$STUB_STATE_DIR/db-source-monitor-stream-completed" &&
            -f "$case_root/output/retdb-$STAMP.sql.gz" &&
            -f "$case_root/output/database-contract.json" ]]; then
      pass 'legacy DB source monitor sweeps the exact PostgreSQL identity in flight'
    else
      fail 'legacy DB source monitor positive in-flight sweep' \
        "$(cat "$KUBECTL_LOG")"
    fi
  done
  fi

  local generation deployments_json generation_profile generation_inventory
  local stream_pid observer_pid
  for generation in legacy-absent durable-v2; do
    if [[ "$generation" == durable-v2 ]]; then
      deployments_json="$KUBERNETES_DEPLOYMENTS_JSON"
      generation_profile=fence-stable
      generation_inventory="$DURABLE_RESTORE_CHECKPOINT/deployment-images.json"
    else
      deployments_json="$LEGACY_DEPLOYMENTS_JSON"
      generation_profile=""
      generation_inventory="$SCHEMA3_LEGACY_RESTORE_CHECKPOINT/deployment-images.json"
    fi
    for case_name in db-source-monitor-uid-drift \
      db-source-monitor-replacement db-source-monitor-stall; do
      sequence=$((sequence + 1))
      case_root="$TMP_DIR/backup-child-db-$sequence-$generation-$case_name"
      baseline_path=""
      baseline_sha=""
      mkdir -p "$case_root"
      if [[ "$generation" == durable-v2 ]]; then
        baseline_path="$case_root/fences.json"
        cp "$DURABLE_FENCE_BASELINE_FIXTURE" "$baseline_path"
        chmod 600 "$baseline_path"
        baseline_sha="$(sha256_digest "$baseline_path")"
      fi
      reset_stub
      STUB_DEPLOYMENTS_JSON="$deployments_json" seed_checkpoint_backup_guard
      STUB_MODE="$case_name"
      export STUB_MODE
      expect_failure "$generation DB backup aborts on $case_name during pg_dump" \
        'Database dump stream or its exact PostgreSQL source monitor failed' \
        run_checkpoint_backup_child db "$case_root/output" "$generation" \
          "$baseline_path" "$baseline_sha" "$generation_profile" \
          "$generation_inventory"
      unset STUB_MODE
      stream_pid="$(cat "$STUB_STATE_DIR/db-source-monitor-stream-pid" \
        2>/dev/null || :)"
      observer_pid="$(cat "$STUB_STATE_DIR/db-source-monitor-observer-pid" \
        2>/dev/null || :)"
      if [[ -e "$STUB_STATE_DIR/db-source-monitor-stream-started" &&
            -e "$STUB_STATE_DIR/db-source-monitor-inflight-observed" &&
            ! -e "$STUB_STATE_DIR/db-source-monitor-stream-completed" &&
            "$stream_pid" =~ ^[1-9][0-9]*$ &&
            "$observer_pid" =~ ^[1-9][0-9]*$ ]] &&
         ! kill -0 "$stream_pid" 2>/dev/null &&
         ! kill -0 "$observer_pid" 2>/dev/null &&
         [[ ! -e "$case_root/output/retdb-$STAMP.sql.gz" &&
            ! -e "$case_root/output/database-contract.json" &&
            -z "$(find "$case_root/output" -maxdepth 1 -type f -print -quit \
              2>/dev/null)" ]]; then
        pass "$generation $case_name revokes and reaps the stream with no output"
      else
        fail "$generation $case_name exact in-flight abort boundary" \
          "stream_pid=${stream_pid:-missing} observer_pid=${observer_pid:-missing} files=$(find "$case_root/output" -maxdepth 1 -type f -print 2>/dev/null | paste -sd, -)"
      fi
    done
  done

  reset_stub
  case_root="$TMP_DIR/backup-child-db-$sequence-standalone-partial-ambient-guard"
  expect_failure 'standalone DB backup rejects even an ambient partial writer guard' \
    'Standalone database backup is superseded' \
    env BACKUP_COORDINATED=0 EXPECTED_KUBE_CONTEXT=fixture-context \
      EXPECTED_NAMESPACE_UID=fixture-uid \
      YENHUBS_PARENT_WRITER_MONITOR_PID=999999 \
      "$ROOT_DIR/deployment/backup-retdb.sh" \
      "$case_root/retdb-$STAMP.sql.gz"
  if [[ ! -e "$case_root/retdb-$STAMP.sql.gz" &&
        ! -e "$case_root/database-contract.json" && ! -s "$KUBECTL_LOG" ]]; then
    pass 'standalone DB backup rejects before Kubernetes or output with no capability adoption'
  else
    fail 'standalone DB backup crossed its fail-before-I/O boundary' \
      "$(cat "$KUBECTL_LOG")"
  fi
}

verify_durable_live_mode() {
  local mode="$1" profile="$2" checkpoint_operation_id="$3"
  local values_path="$4" manifest_path="$5" live_directory="$6"
  local recovery_operation_fence_state="$7"
  seed_recovery_operation_fence_binding_state \
    "$recovery_operation_fence_state" || return 1
  # shellcheck disable=SC2016 # Positional arguments expand in the isolated Bash process.
  env -u RECOVERY_OPERATION_ID \
    EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid NAMESPACE=hcce \
    RECOVERY_NAMESPACE_UID=fixture-uid \
    RUNNER_EVIDENCE_LIVE_DIR="$live_directory" \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE="$profile" \
    bash -c '
      set -euo pipefail
      source "$1"
      RECOVERY_NAMESPACE_UID=fixture-uid
      RECOVERY_CHECKPOINT_OPERATION_ID="$8"
      recovery_verify_runner_cutover_evidence_live \
        "$2" "$3" "$4" "$5" "$6" "$7"
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
      "$values_path" \
      "$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json" \
      "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" \
      "$recovery_operation_fence_state" "$manifest_path" "$mode" \
      "$checkpoint_operation_id"
}

verify_durable_source_mode() {
  verify_durable_live_mode "$1" "$2" "$3" \
    "$VALUES_FIXTURE" "" "$RUNNER_EVIDENCE_LIVE_DIR" dormant
}

verify_durable_live_mode_with_residual() {
  local residual="$1"
  shift
  STUB_RUNNER_RESIDUAL="$residual" verify_durable_live_mode "$@"
}

set_durable_live_state() {
  local phase="$1" epoch="$2" replicas="$3" deployment
  printf '%s' "$phase" >"$STUB_STATE_DIR/recovery-phase"
  printf '%s' "$epoch" >"$STUB_STATE_DIR/recovery-epoch"
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '%s' "$replicas" >"$STUB_STATE_DIR/replicas-$deployment"
    printf '%s' 2 >"$STUB_STATE_DIR/rv-$deployment"
  done
  printf '%s' runner-role-uid >"$STUB_STATE_DIR/runner-role-uid"
  printf '%s' 1 >"$STUB_STATE_DIR/runner-role-rv"
  if [[ "$replicas" == 0 ]]; then
    printf '%s' restore-fence >"$STUB_STATE_DIR/runner-role-phase"
    printf '%s' '[]' >"$STUB_STATE_DIR/runner-role-rules.json"
  else
    printf '%s' "$phase" >"$STUB_STATE_DIR/runner-role-phase"
    printf '%s' \
      '[{"apiGroups":[""],"resources":["pods"],"verbs":["create","delete","get","list","patch"]}]' \
      >"$STUB_STATE_DIR/runner-role-rules.json"
  fi
}

assert_runner_evidence_read_only() {
  local name="$1"
  if [[ -s "$KUBECTL_LOG" ]] && ! any_deployment_replica_mutation &&
     ! grep -Eq 'create -f -|replace -f -|delete --raw=' "$KUBECTL_LOG"; then
    pass "$name"
  else
    fail "$name" "$(cat "$KUBECTL_LOG")"
  fi
}

make_runner_journal_tamper_fixture() {
  local mode="$1" destination="$2"
  rm -rf -- "$destination"
  cp -R "$RUNNER_EVIDENCE_LIVE_DIR" "$destination"
  node - "$ROOT_DIR/hubs-cloud/community-edition/apply/cutover-journal.js" \
    "$destination/cutover-journal.json" "$PROCESS_LOCAL_CUTOVER_KEY_PATH" \
    "$mode" <<'NODE'
const fs = require("node:fs");
const { canonicalJson, journalHmac } = require(process.argv[2]);
const path = process.argv[3];
const key = fs.readFileSync(process.argv[4]);
const mode = process.argv[5];
const configMap = JSON.parse(fs.readFileSync(path, "utf8"));
const journal = JSON.parse(configMap.data["journal.json"]);
if (mode === "canonical") {
  configMap.data["journal.json"] += " ";
} else if (mode === "hmac") {
  journal.hmacSha256 = `${journal.hmacSha256[0] === "0" ? "1" : "0"}` +
    journal.hmacSha256.slice(1);
  configMap.data["journal.json"] = canonicalJson(journal);
} else if (mode === "target-hash") {
  journal.targetHashes.parentDeployment = "f".repeat(64);
  const unsigned = structuredClone(journal);
  delete unsigned.hmacSha256;
  journal.hmacSha256 = journalHmac(unsigned, key);
  configMap.data["journal.json"] = canonicalJson(journal);
} else {
  throw new Error("journal_tamper_mode_invalid");
}
fs.writeFileSync(path, `${JSON.stringify(configMap)}\n`, { mode: 0o600 });
key.fill(0);
NODE
}

run_runner_source_evidence_tests() {
  local checkpoint_operation_id profile expected
  initialize_durable_restore_fixture || return 1
  checkpoint_operation_id="$(jq -er '.checkpoint_operation_id' \
    "$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json")"

  reset_stub
  expect_success 'active-source accepts classified runner and intent while preserving its historical fence' \
    verify_durable_source_mode active-source active-valid "$checkpoint_operation_id"
  if [[ -s "$KUBECTL_LOG" ]] && ! any_deployment_replica_mutation &&
     ! grep -q 'delete --raw=' "$KUBECTL_LOG"; then
    pass 'active-source CLI works without RECOVERY_OPERATION_ID and remains read-only'
  else
    fail 'active-source source-only operation binding and read-only contract' \
      "$(cat "$KUBECTL_LOG")"
  fi

  for profile in active-unknown active-malformed; do
    reset_stub
    expect_failure "active-source rejects $profile runner namespace content" \
      'runner_cutover_checkpoint_evidence_failed:' \
      verify_durable_source_mode active-source "$profile" "$checkpoint_operation_id"
    if ! any_deployment_replica_mutation &&
       ! grep -q 'delete --raw=' "$KUBECTL_LOG"; then
      pass "$profile active-source rejection is read-only"
    else
      fail "$profile active-source rejection mutated Kubernetes" \
        "$(cat "$KUBECTL_LOG")"
    fi
  done

  for profile in empty historical-fence-replaced; do
    if [[ "$profile" == empty ]]; then
      expected='historical_live_mismatch'
    else
      expected='historical_live_mismatch'
    fi
    reset_stub
    expect_failure "active-source rejects $profile historical fence state" \
      "$expected" \
      verify_durable_source_mode active-source "$profile" "$checkpoint_operation_id"
  done

  reset_stub
  set_durable_live_state restore-fence "$LIVE_RUNNER_EPOCH" 0
  expect_success 'quiesced-source accepts the unchanged historical fence with zero runner and intent' \
    verify_durable_source_mode quiesced-source fence-stable "$checkpoint_operation_id"

  reset_stub
  set_durable_live_state restore-fence "$LIVE_RUNNER_EPOCH" 0
  expect_failure 'quiesced-source still rejects otherwise valid active runner and intent' \
    'runner_cutover_checkpoint_evidence_failed:' \
    verify_durable_source_mode quiesced-source active-valid "$checkpoint_operation_id"

  for expected in checkpoint capture; do
    reset_stub
    if [[ "$expected" == checkpoint ]]; then
      expect_failure 'checkpoint verification CLI still requires RECOVERY_OPERATION_ID' \
        'checkpoint_operation_id_missing' env -u RECOVERY_OPERATION_ID \
        EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
        EXPECTED_NAMESPACE_UID=fixture-uid \
        node "$ROOT_DIR/deployment/runner-cutover-checkpoint-evidence.mjs" \
        verify --values "$VALUES_FIXTURE" \
        --evidence "$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json" \
        --inventory "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" \
        --manifest "$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" \
        --live-mode checkpoint --recovery-operation-fence-state dormant
    else
      expect_failure 'checkpoint capture CLI still requires RECOVERY_OPERATION_ID' \
        'checkpoint_operation_id_missing' env -u RECOVERY_OPERATION_ID \
        EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
        EXPECTED_NAMESPACE_UID=fixture-uid \
        node "$ROOT_DIR/deployment/runner-cutover-checkpoint-evidence.mjs" \
        capture --values "$VALUES_FIXTURE" \
        --output "$TMP_DIR/source-mode-capture-without-operation.json" \
        --inventory "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" \
        --manifest "$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" \
        --recovery-operation-fence-state dormant
    fi
    if [[ ! -s "$KUBECTL_LOG" ]]; then
      pass "$expected missing operation binding fails before live reads"
    else
      fail "$expected missing operation binding performed live reads" \
        "$(cat "$KUBECTL_LOG")"
    fi
  done

  reset_stub
  set_durable_live_state restore-fence "$TARGET_RUNNER_EPOCH" 0
  expect_success 'quiesced-target accepts target epoch B and restore-fence manifest while preserving source evidence A' \
    verify_durable_live_mode quiesced-target fence-stable \
      "$checkpoint_operation_id" "$RESTORE_FENCE_VALUES_FIXTURE" \
      "$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
      "$RUNNER_RESTORE_FENCE_LIVE_DIR" active
  assert_runner_evidence_read_only \
    'quiesced-target verification is read-only'

  reset_stub
  set_durable_live_state active "$TARGET_RUNNER_EPOCH" 0
  expect_success 'quiesced-active-target accepts completed target epoch B with zero runner and intent' \
    verify_durable_live_mode quiesced-active-target fence-stable \
      "$checkpoint_operation_id" "$RESTORE_VALUES_FIXTURE" \
      "$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
      "$RUNNER_ACTIVE_TARGET_LIVE_DIR" dormant
  assert_runner_evidence_read_only \
    'quiesced-active-target verification is read-only'

  reset_stub
  set_durable_live_state active "$TARGET_RUNNER_EPOCH" 1
  expect_success 'active-target accepts target epoch B after the parent is active' \
    verify_durable_live_mode active-target active-valid \
      "$checkpoint_operation_id" "$RESTORE_VALUES_FIXTURE" \
      "$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
      "$RUNNER_ACTIVE_TARGET_LIVE_DIR" dormant
  assert_runner_evidence_read_only 'active-target verification is read-only'

  reset_stub
  expect_failure 'source modes reject a target manifest before live reads' '' \
    verify_durable_live_mode active-source active-valid \
      "$checkpoint_operation_id" "$VALUES_FIXTURE" \
      "$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" "$RUNNER_EVIDENCE_LIVE_DIR" \
      dormant
  if [[ ! -s "$KUBECTL_LOG" ]]; then
    pass 'source mode with a target manifest fails before Kubernetes'
  else
    fail 'source mode with a target manifest performed live reads' \
      "$(cat "$KUBECTL_LOG")"
  fi

  reset_stub
  set_durable_live_state active "$LIVE_RUNNER_EPOCH" 1
  expect_failure 'target mode rejects source manifest epoch A as its own candidate epoch' \
    'checkpoint_manifest_recovery_epoch_binding_invalid' \
    verify_durable_live_mode active-target fence-stable \
      "$checkpoint_operation_id" "$VALUES_FIXTURE" \
      "$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" "$RUNNER_EVIDENCE_LIVE_DIR" \
      dormant

  reset_stub
  set_durable_live_state active "$TARGET_RUNNER_EPOCH" 0
  expect_failure 'quiesced-target rejects an active target manifest' \
    'checkpoint_manifest' \
    verify_durable_live_mode quiesced-target fence-stable \
      "$checkpoint_operation_id" "$RESTORE_VALUES_FIXTURE" \
      "$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
      "$RUNNER_ACTIVE_TARGET_LIVE_DIR" dormant

  reset_stub
  set_durable_live_state restore-fence "$TARGET_RUNNER_EPOCH" 0
  expect_failure 'quiesced-active-target rejects a restore-fence target manifest' \
    'checkpoint_manifest' \
    verify_durable_live_mode quiesced-active-target fence-stable \
      "$checkpoint_operation_id" "$RESTORE_FENCE_VALUES_FIXTURE" \
      "$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
      "$RUNNER_RESTORE_FENCE_LIVE_DIR" active

  for profile in empty historical-fence-replaced active-valid; do
    reset_stub
    set_durable_live_state active "$TARGET_RUNNER_EPOCH" 0
    expected=checkpoint_evidence_historical_live_mismatch
    [[ "$profile" != active-valid ]] || expected=runner_namespace_not_quiescent
    expect_failure "quiesced-active-target rejects $profile runner state" \
      "$expected" \
      verify_durable_live_mode quiesced-active-target "$profile" \
        "$checkpoint_operation_id" "$RESTORE_VALUES_FIXTURE" \
        "$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
        "$RUNNER_ACTIVE_TARGET_LIVE_DIR" dormant
  done

  reset_stub
  set_durable_live_state restore-fence "$TARGET_RUNNER_EPOCH" 0
  expect_failure 'target verification rejects target control-plane replacement' \
    'admission_pair_not_exact' \
    verify_durable_live_mode_with_residual policy-pods \
      quiesced-target fence-stable "$checkpoint_operation_id" \
      "$RESTORE_FENCE_VALUES_FIXTURE" \
      "$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
      "$RUNNER_RESTORE_FENCE_LIVE_DIR" active

  reset_stub
  expect_failure 'source verification rejects cutover journal identity drift' \
    'durable_cutover_journal_invalid' \
    verify_durable_live_mode_with_residual cutover-journal \
      active-source active-valid "$checkpoint_operation_id" \
      "$VALUES_FIXTURE" "" "$RUNNER_EVIDENCE_LIVE_DIR" dormant

  for profile in canonical hmac target-hash; do
    local tampered_live="$TMP_DIR/runner-journal-$profile-live"
    make_runner_journal_tamper_fixture "$profile" "$tampered_live"
    reset_stub
    expect_failure "active-source rejects signed journal $profile tampering" \
      'durable_cutover_journal_invalid' \
      verify_durable_live_mode active-source active-valid \
        "$checkpoint_operation_id" "$VALUES_FIXTURE" "" "$tampered_live" \
        dormant
  done

  reset_stub
  expect_failure 'active-source rejects drift in the current active control plane' \
    'admission_policy_not_observed_or_exact' \
    verify_durable_live_mode_with_residual policy-pods \
      active-source active-valid "$checkpoint_operation_id" \
      "$VALUES_FIXTURE" "" "$RUNNER_EVIDENCE_LIVE_DIR" dormant
}

run_restore_role_retry_test() {
  local confirmation retry_consumer retry_exact=true
  initialize_durable_restore_fixture || return 1
  confirmation="prepare-fence:fixture-context:hcce:fixture-uid:fixture-pvc-uid:$STAMP:$DURABLE_RESTORE_DUMP_SHA:$DURABLE_RESTORE_STORAGE_SHA:$DURABLE_RESTORE_INVENTORY_SHA:$LIVE_RUNNER_EPOCH:$TARGET_RUNNER_EPOCH:$DURABLE_RESTORE_EVIDENCE_SHA:durable-v2"
  reset_stub
  seed_recovery_operation_fence_binding_state dormant \
    recovery-operation-fence-binding-rv-1
  expect_success 'prepare-fence retries one Role CAS failure only in the main driver' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
    RESTORE_CHECKPOINT_PREPARE_FENCE=1 \
    CONFIRM_PREPARE_RESTORE_FENCE="$confirmation" \
    STUB_MODE=restore-role-replace-retry \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  for retry_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ "$(deployment_patch_count "$retry_consumer" 0)" != 1 ]]; then
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

reset_stub
# shellcheck disable=SC2016 # Expanded by the isolated Bash process.
expect_failure 'UID-delete never treats a post-delete GET error as confirmed absence' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
  STUB_MODE=delete-poll-get-error bash -c '
    set -Eeuo pipefail
    source "$1"
    recovery_kubectl_mutate() { recovery_kubectl "$@"; }
    recovery_delete_namespaced_with_uid_in_namespace \
      hcce-bot-runners pod bot-runner-fixture runner-pod-uid 1
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
if [[ -f "$STUB_STATE_DIR/delete-options-1.json" ]] &&
   jq -e '.preconditions == {uid:"runner-pod-uid"}' \
     "$STUB_STATE_DIR/delete-options-1.json" >/dev/null &&
   grep -q \
     'get pod bot-runner-fixture -n hcce-bot-runners --ignore-not-found -o json' \
     "$KUBECTL_LOG"; then
  pass 'post-delete API failure occurs after the exact UID delete and remains failure'
else
  fail 'post-delete API failure is not a false-success path' "$(cat "$KUBECTL_LOG")"
fi

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
  local deployment entry consumers='[]' fingerprint inventory_sha
  inventory_sha="$(sha256_digest "$GOOD_CHECKPOINT/deployment-images.json")"
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
    yenhubs.org/deployment-inventory-sha256: "$inventory_sha"
    yenhubs.org/recovery-state: "legacy-in-place"
    yenhubs.org/runner-cutover-evidence-sha256: "$inventory_sha"
    yenhubs.org/runner-runtime-generation: "legacy-absent"
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
      # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
      bash -c 'source "$1"; recovery_process_start_identity "$2"' _ \
        "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$$"
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
      .spec.strategy = (.spec.strategy // {}) |
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
  # shellcheck disable=SC2031 # The caller subshell intentionally consumes this fixture state.
  export EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    RECOVERY_OPERATION_OWNER=checkpoint-restore \
    RECOVERY_OPERATION_LOCK_NAME=yenhubs-recovery-operation-lock \
    RECOVERY_OPERATION_LOCK_UID=restore-lock-uid \
    RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=lock-rv-1 \
    RECOVERY_OPERATION_TOKEN="$operation_token" \
    RECOVERY_OPERATION_ID="$operation_id" \
    RECOVERY_CONSUMER_CONTRACT_JSON \
    RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$inventory_sha" \
    RECOVERY_OPERATION_STATE=legacy-in-place \
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256="$inventory_sha" \
    RECOVERY_RUNNER_RUNTIME_GENERATION=legacy-absent
}

seed_durable_restore_child_lock() {
  STUB_DEPLOYMENTS_JSON="$DURABLE_RESTORE_CHILD_DEPLOYMENTS_JSON" \
    seed_restore_lock adopted || return 1
  set_durable_live_state restore-fence "$TARGET_RUNNER_EPOCH" 0
  seed_recovery_operation_fence_binding_state active \
    recovery-operation-fence-binding-rv-1
  cat >"$STUB_STATE_DIR/restore-lock.yaml" <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: yenhubs-recovery-operation-lock
  namespace: hcce
  labels:
    yenhubs.org/recovery-owner: checkpoint-restore
  annotations:
    yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
    yenhubs.org/recovery-token: "$RECOVERY_OPERATION_TOKEN"
    yenhubs.org/namespace-uid: "fixture-uid"
    yenhubs.org/pvc-uid: "fixture-pvc-uid"
    yenhubs.org/checkpoint-stamp: "$STAMP"
    yenhubs.org/dump-sha256: "$DURABLE_RESTORE_DUMP_SHA"
    yenhubs.org/storage-sha256: "$DURABLE_RESTORE_STORAGE_SHA"
    yenhubs.org/deployment-inventory-sha256: "$DURABLE_RESTORE_INVENTORY_SHA"
    yenhubs.org/pre-fence-epoch: "$LIVE_RUNNER_EPOCH"
    yenhubs.org/restore-fence-epoch: "$TARGET_RUNNER_EPOCH"
    yenhubs.org/recovery-state: "restore-fence-prepared"
    yenhubs.org/runner-cutover-evidence-sha256: "$DURABLE_RESTORE_EVIDENCE_SHA"
    yenhubs.org/runner-runtime-generation: "durable-v2"
immutable: true
EOF
  RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$DURABLE_RESTORE_INVENTORY_SHA"
  RECOVERY_OPERATION_STATE=restore-fence-prepared
  RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256="$DURABLE_RESTORE_EVIDENCE_SHA"
  RECOVERY_RUNNER_RUNTIME_GENERATION=durable-v2
  RECOVERY_FENCE_PRE_EPOCH="$LIVE_RUNNER_EPOCH"
  RECOVERY_FENCE_TARGET_EPOCH="$TARGET_RUNNER_EPOCH"
  RECOVERY_CHECKPOINT_METADATA_SCHEMA=3
  RECOVERY_CHECKPOINT_METADATA_COPY="$DURABLE_RESTORE_CHECKPOINT/checkpoint-metadata.json"
  RECOVERY_DEPLOYMENT_INVENTORY_COPY="$DURABLE_RESTORE_CHECKPOINT/deployment-images.json"
  RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY="$DURABLE_RESTORE_CHECKPOINT/runner-cutover-evidence.json"
  export RECOVERY_DEPLOYMENT_INVENTORY_SHA256 RECOVERY_OPERATION_STATE \
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256 \
    RECOVERY_RUNNER_RUNTIME_GENERATION RECOVERY_FENCE_PRE_EPOCH \
    RECOVERY_FENCE_TARGET_EPOCH RECOVERY_CHECKPOINT_METADATA_SCHEMA \
    RECOVERY_CHECKPOINT_METADATA_COPY RECOVERY_DEPLOYMENT_INVENTORY_COPY \
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY
}

run_guarded_durable_restore_child() {
  local child="$1" input_path="$2" swap_mode="$3" child_status=0
  local writer_pid writer_identity writer_progress writer_authority
  local child_stub_mode="" guard_max_stale_seconds=""
  local mutation_pid="" mutation_status=0
  local child_finished_marker="" stream_deadline=0
  local db_confirmation storage_confirmation
  seed_durable_restore_child_lock || return 1
  STUB_DEPLOYMENTS_JSON="$DURABLE_RESTORE_CHILD_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
    STUB_MONITOR_WATCH_PACE=1 \
    start_checkpoint_backup_writer_guard healthy durable-v2 \
      "$DURABLE_FENCE_BASELINE_FIXTURE" "$DURABLE_FENCE_BASELINE_SHA" \
      checkpoint-restore "$DURABLE_RESTORE_DUMP_SHA" \
      "$DURABLE_RESTORE_STORAGE_SHA" || return 1
  export YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_PATH="$DURABLE_FENCE_BASELINE_FIXTURE"
  export YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_SHA256="$DURABLE_FENCE_BASELINE_SHA"
  case "$swap_mode" in
    swap-pids)
      writer_pid="$YENHUBS_PARENT_WRITER_MONITOR_PID"
      writer_identity="$YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY"
      YENHUBS_PARENT_WRITER_MONITOR_PID="$YENHUBS_PARENT_DURABLE_MONITOR_PID"
      YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY"
      YENHUBS_PARENT_DURABLE_MONITOR_PID="$writer_pid"
      YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY="$writer_identity"
      export YENHUBS_PARENT_WRITER_MONITOR_PID \
        YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY \
        YENHUBS_PARENT_DURABLE_MONITOR_PID \
        YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY
      ;;
    swap-progress)
      writer_progress="$YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH"
      YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH"
      YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH="$writer_progress"
      export YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH \
        YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH
      ;;
    swap-authority)
      writer_authority="$YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256"
      YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256"
      YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$writer_authority"
      export YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256 \
        YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256
      ;;
    inflight-pid|inflight-progress|inflight-authority)
      child_stub_mode="restore-$child-durable-capability-stream"
      # The durable local quiescence sweep validates both parent capabilities,
      # the signed fence and the full DB consumer/source boundary. Exercise the
      # exact production budget; the deliberate stalled fixtures remain at
      # twelve seconds and therefore still cross this ten-second limit.
      guard_max_stale_seconds=10
      child_finished_marker="$CHECKPOINT_BACKUP_WRITER_GUARD_DIR/restore-child-finished"
      (
        local stream_marker="$STUB_STATE_DIR/restore-$child-stream-started"
        local mutation_marker="$STUB_STATE_DIR/restore-$child-$swap_mode-mutated"
        local writer_ready_authority \
          durable_ready_authority writer_next durable_next _
        stream_deadline=$((SECONDS + 90))
        while (( SECONDS < stream_deadline )); do
          [[ -e "$stream_marker" ]] && break
          if [[ -s "$child_finished_marker" ]]; then
            printf 'fixture mutator stopped before stream: restore child exited with status %s\n' \
              "$(cat "$child_finished_marker")" >&2
            exit 3
          fi
          kill -0 "$CHECKPOINT_BACKUP_WRITER_GUARD_SUPERVISOR_PID" \
            2>/dev/null || exit 1
          sleep 0.01
        done
        if [[ ! -e "$stream_marker" ]]; then
          printf 'fixture mutator timed out after 90 seconds waiting for %s\n' \
            "$stream_marker" >&2
          exit 4
        fi
        case "$swap_mode" in
          inflight-pid)
            kill -TERM "$YENHUBS_PARENT_WRITER_MONITOR_PID" || exit 1
            ;;
          inflight-progress)
            # Freeze both publishers before exchanging their private marker
            # bytes, otherwise either monitor could immediately overwrite the
            # injected cross-capability value before the stream supervisor
            # observes it.
            kill -STOP "$YENHUBS_PARENT_WRITER_MONITOR_PID" \
              "$YENHUBS_PARENT_DURABLE_MONITOR_PID" || exit 1
            writer_next="${YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH}.fixture-next"
            durable_next="${YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH}.fixture-next"
            cp -- "$YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH" \
              "$writer_next" || exit 1
            cp -- "$YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH" \
              "$durable_next" || exit 1
            chmod 600 "$writer_next" "$durable_next" || exit 1
            mv -f -- "$writer_next" \
              "$YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH" || exit 1
            mv -f -- "$durable_next" \
              "$YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH" || exit 1
            ;;
          inflight-authority)
            writer_ready_authority="${YENHUBS_PARENT_WRITER_MONITOR_READY_PATH}.authority.json"
            durable_ready_authority="${YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH}.authority.json"
            writer_next="${writer_ready_authority}.fixture-next"
            durable_next="${durable_ready_authority}.fixture-next"
            cp -- "$durable_ready_authority" "$writer_next" || exit 1
            cp -- "$writer_ready_authority" "$durable_next" || exit 1
            chmod 600 "$writer_next" "$durable_next" || exit 1
            mv -f -- "$writer_next" "$writer_ready_authority" || exit 1
            mv -f -- "$durable_next" "$durable_ready_authority" || exit 1
            ;;
        esac
        write_monotonic_ns_marker "$mutation_marker"
      ) &
      # shellcheck disable=SC2031 # This shell owns the background mutation PID.
      mutation_pid=$!
      ;;
    *)
      stop_checkpoint_backup_writer_guard
      return 2
      ;;
  esac
  db_confirmation="retdb:fixture-context:hcce:fixture-uid:$STAMP:$DURABLE_RESTORE_DUMP_SHA:$DURABLE_RESTORE_STORAGE_SHA:$DURABLE_RESTORE_EVIDENCE_SHA:durable-v2"
  storage_confirmation="ret-pvc:fixture-context:hcce:fixture-uid:$STAMP:$DURABLE_RESTORE_DUMP_SHA:$DURABLE_RESTORE_STORAGE_SHA:fixture-pvc-uid:$DURABLE_RESTORE_EVIDENCE_SHA:durable-v2"
  case "$child" in
    db)
      if env EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
        HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
        RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
        STUB_DEPLOYMENTS_JSON="$DURABLE_RESTORE_CHILD_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
        STUB_MODE="$child_stub_mode" \
        RESTORE_COORDINATED=1 RESTORE_ALREADY_FENCED=1 \
        CONFIRM_RESTORE="$db_confirmation" RECOVERY_STREAM_POLL_SECONDS=0.1 \
        RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=120 \
        RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS="$guard_max_stale_seconds" \
        "$ROOT_DIR/deployment/restore-retdb.sh" "$input_path"; then
        child_status=0
      else
        child_status=$?
      fi
      ;;
    storage)
      if env EXPECTED_KUBE_CONTEXT=fixture-context \
        EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
        VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
        HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
        RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
        STUB_DEPLOYMENTS_JSON="$DURABLE_RESTORE_CHILD_DEPLOYMENTS_JSON" \
        STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
        STUB_MODE="$child_stub_mode" \
        RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$storage_confirmation" \
        RECOVERY_STREAM_POLL_SECONDS=0.1 \
        RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=120 \
        RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS="$guard_max_stale_seconds" \
        "$ROOT_DIR/deployment/restore-ret-storage.sh" "$input_path"; then
        child_status=0
      else
        child_status=$?
      fi
      ;;
    *)
      stop_checkpoint_backup_writer_guard
      return 2
      ;;
  esac
  if [[ -n "$child_finished_marker" ]]; then
    printf '%s\n' "$child_status" >"$child_finished_marker"
    chmod 600 "$child_finished_marker"
  fi
  if [[ "$mutation_pid" =~ ^[1-9][0-9]*$ ]]; then
    if wait "$mutation_pid"; then
      mutation_status=0
    else
      mutation_status=$?
    fi
  fi
  stop_checkpoint_backup_writer_guard
  [[ "$mutation_status" == 0 ]] || return "$mutation_status"
  return "$child_status"
}

run_durable_restore_child_capability_swap_tests() {
  local child input_path swap_mode all_zero deployment
  local total_elapsed marker_prefix
  local only_child="${1:-}" only_swap_mode="${2:-}"
  [[ -z "$only_child" || "$only_child" == db || "$only_child" == storage ]] ||
    return 2
  [[ -z "$only_swap_mode" ||
     "$only_swap_mode" =~ ^(swap-pids|swap-progress|swap-authority|inflight-pid|inflight-progress|inflight-authority)$ ]] ||
    return 2
  initialize_durable_restore_fixture || return 1
  for child in db storage; do
    [[ -z "$only_child" || "$child" == "$only_child" ]] || continue
    if [[ "$child" == db ]]; then
      input_path="$DURABLE_RESTORE_CHECKPOINT/retdb-$STAMP.sql.gz"
    else
      input_path="$DURABLE_RESTORE_CHECKPOINT/ret-storage-$STAMP.tar.gz"
    fi
    for swap_mode in swap-pids swap-progress swap-authority; do
      [[ -z "$only_swap_mode" || "$swap_mode" == "$only_swap_mode" ]] ||
        continue
      reset_stub
      expect_failure "$child restore rejects $swap_mode across its two parent capabilities" \
        'exact parent monitor capabilities' run_guarded_durable_restore_child \
        "$child" "$input_path" "$swap_mode"
      all_zero=true
      for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
        [[ "$(cat "$STUB_STATE_DIR/replicas-$deployment" 2>/dev/null || :)" == 0 ]] ||
          all_zero=false
      done
      if [[ "$all_zero" == true && -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
         recovery_operation_fence_binding_state_is active \
           recovery-operation-fence-binding-rv-1 &&
         recovery_operation_fence_binding_was_not_replaced &&
         ! grep -Eq 'dropdb|tar -C /storage -xf -|create -f -|patch deployment ' \
           "$KUBECTL_LOG"; then
        pass "$child $swap_mode rejection preserves the exact lock, active fence and zero boundary"
      else
        fail "$child $swap_mode crossed its pre-mutation capability boundary" \
          "output=$LAST_OUTPUT lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) fence=$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state" 2>/dev/null || printf missing)"
      fi
    done

    marker_prefix="restore-$child-stream"
    for swap_mode in inflight-pid inflight-progress inflight-authority; do
      [[ -z "$only_swap_mode" || "$swap_mode" == "$only_swap_mode" ]] ||
        continue
      reset_stub
      total_elapsed=$SECONDS
      expect_failure "$child restore aborts on $swap_mode after its destructive stream starts" \
        '' run_guarded_durable_restore_child \
        "$child" "$input_path" "$swap_mode"
      total_elapsed=$((SECONDS - total_elapsed))
      all_zero=true
      for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
        [[ "$(cat "$STUB_STATE_DIR/replicas-$deployment" 2>/dev/null || :)" == 0 ]] ||
          all_zero=false
      done
      if [[ "$all_zero" == true &&
            -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
         restore_stream_revocation_is_under_seconds \
           "$STUB_STATE_DIR/restore-$child-$swap_mode-mutated" \
           "$STUB_STATE_DIR/$marker_prefix-terminated" 10 &&
         restore_stream_group_is_reaped "$marker_prefix" \
           "restore-$child-durable-capability" &&
         recovery_operation_fence_binding_state_is active \
           recovery-operation-fence-binding-rv-1 &&
         recovery_operation_fence_binding_was_not_replaced &&
         ! grep -Eq \
           'patch deployment .*"op":"replace","path":"/spec/replicas","value":1|delete --raw=.*/configmaps/yenhubs-recovery-operation-lock' \
           "$KUBECTL_LOG"; then
        pass "$child $swap_mode reaps the stream under ten seconds and preserves the lock, fence and zero boundary"
      else
        fail "$child $swap_mode exact in-flight revocation boundary" \
          "total_elapsed=$total_elapsed output=$LAST_OUTPUT mutated=$(cat "$STUB_STATE_DIR/restore-$child-$swap_mode-mutated" 2>/dev/null || printf missing) terminated=$(cat "$STUB_STATE_DIR/$marker_prefix-terminated" 2>/dev/null || printf missing) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) fence=$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state" 2>/dev/null || printf missing)"
      fi
    done
  done
}

corrupt_restore_lock_inventory() {
  local wrong_inventory
  wrong_inventory="$(printf 'f%.0s' {1..64})"
  sed -E \
    "s#(yenhubs.org/deployment-inventory-sha256: )\"[a-f0-9]{64}\"#\1\"$wrong_inventory\"#" \
    "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
  mv "$STUB_STATE_DIR/restore-lock.next" "$STUB_STATE_DIR/restore-lock.yaml"
}

seed_schema2_legacy_stale_restore_lock() {
  local lease_mode="${1:-available}"
  seed_restore_lock "$lease_mode"
}

seed_checkpoint_backup_guard() {
  local deployment
  seed_restore_lock adopted
  sed -e 's/checkpoint-restore/checkpoint-backup/g' \
    -e '/yenhubs.org\/deployment-inventory-sha256:/d' \
    -e '/yenhubs.org\/recovery-state:/d' \
    -e '/yenhubs.org\/runner-cutover-evidence-sha256:/d' \
    -e '/yenhubs.org\/runner-runtime-generation:/d' \
    "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
  mv "$STUB_STATE_DIR/restore-lock.next" "$STUB_STATE_DIR/restore-lock.yaml"
  RECOVERY_OPERATION_OWNER='checkpoint-backup'
  unset RECOVERY_DEPLOYMENT_INVENTORY_SHA256 \
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256 RECOVERY_RUNNER_RUNTIME_GENERATION \
    RECOVERY_OPERATION_STATE RECOVERY_FENCE_PRE_EPOCH RECOVERY_FENCE_TARGET_EPOCH
  export RECOVERY_OPERATION_OWNER
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '%s' 0 >"$STUB_STATE_DIR/replicas-$deployment"
    printf '%s' 2 >"$STUB_STATE_DIR/rv-$deployment"
  done
}
seed_stale_restore_helper() {
  local operation_id="${1:-88888888888888888888888888888888}"
  local operation_token="${2:-77777777777777777777777777777777}"
  local image="ghcr.io/yengalvez/reticulum@sha256:6666666666666666666666666666666666666666666666666666666666666666"
  local pod_name="ret-storage-restore-${operation_id:0:12}"
  local snapshot="$STUB_STATE_DIR/storage-helper-pod-live.json"
  local snapshot_next="$snapshot.next.$$"
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
  printf '%s' network-policy-rv-1 >"$STUB_STATE_DIR/network-policy-rv"
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
  terminationGracePeriodSeconds: 1
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
  printf '%s' "$pod_name" >"$STUB_STATE_DIR/pod-name"
  printf '%s' restore-pod-uid >"$STUB_STATE_DIR/pod-uid"
  printf '%s' restore-pod-rv-1 >"$STUB_STATE_DIR/pod-rv"
  jq -cn --arg name "$pod_name" --arg operation_id "$operation_id" \
    --arg operation_token "$operation_token" --arg image "$image" '
    {apiVersion:"v1",kind:"Pod",metadata:{name:$name,uid:"restore-pod-uid",
      resourceVersion:"restore-pod-rv-1",namespace:"hcce",
      labels:{"yenhubs.org/recovery-owner":"ret-storage-restore",
        "yenhubs.org/operation-id":$operation_id},
      annotations:{"yenhubs.org/operation-lock-uid":"restore-lock-uid",
        "yenhubs.org/operation-token":$operation_token}},
      spec:{automountServiceAccountToken:false,enableServiceLinks:false,
        restartPolicy:"Never",terminationGracePeriodSeconds:1,
        activeDeadlineSeconds:3600,
        securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,
          fsGroup:1000,fsGroupChangePolicy:"OnRootMismatch",
          seccompProfile:{type:"RuntimeDefault"}},
        volumes:[{name:"storage",persistentVolumeClaim:
          {claimName:"ret-pvc",readOnly:false}}],
        containers:[{name:"helper",image:$image,
          command:["sh","-c","sleep 3600"],
          securityContext:{allowPrivilegeEscalation:false,
            readOnlyRootFilesystem:true,capabilities:{drop:["ALL"]}},
          volumeMounts:[{name:"storage",mountPath:"/storage",readOnly:false}]}]}}
  ' >"$snapshot_next"
  chmod 600 "$snapshot_next"
  mv "$snapshot_next" "$snapshot"
  : >"$STUB_STATE_DIR/pod-created"
  for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf 0 >"$STUB_STATE_DIR/replicas-$writer"
    printf 2 >"$STUB_STATE_DIR/rv-$writer"
  done
}
assert_no_kube() { if [[ -s "$KUBECTL_LOG" ]]; then fail "$1" "$(cat "$KUBECTL_LOG")"; else pass "$1"; fi; }

deployment_patch_count() {
  local deployment="$1" replicas="$2"
  grep -Ec "patch deployment $deployment .*--type=json --patch=.*\"op\":\"replace\",\"path\":\"/spec/replicas\",\"value\":$replicas" \
    "$KUBECTL_LOG" || :
}

checkpoint_process_local_pre_watcher_outcome_is_safe() {
  local parent_replicas parent_resume_count lock_state
  parent_replicas="$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || printf 1)"
  parent_resume_count="$(deployment_patch_count bot-orchestrator 1)"
  lock_state=absent
  [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && lock_state=present

  # An exact rollback is ideal. If Linux cannot prove that the pre-watcher
  # boundary is safe to resume, retaining the sole lock with the parent fenced
  # is the intended fail-closed result; accepting any other combination would
  # hide a stranded or concurrently mutable workload.
  [[ "$parent_replicas:$parent_resume_count:$lock_state" == 1:1:absent ||
     "$parent_replicas:$parent_resume_count:$lock_state" == 0:0:present ]]
}

deployment_patch_first_line() {
  local deployment="$1" replicas="$2"
  grep -En "patch deployment $deployment .*--type=json --patch=.*\"op\":\"replace\",\"path\":\"/spec/replicas\",\"value\":$replicas" \
    "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :
}

deployment_resume_receipt_cleanup_count() {
  local deployment="$1"
  grep -Ec "patch deployment $deployment .*--type=json --patch=.*\"op\":\"remove\",\"path\":\"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation\"" \
    "$KUBECTL_LOG" || :
}

any_deployment_replica_mutation() {
  grep -Eq 'patch deployment .*--type=json --patch=.*"op":"replace","path":"/spec/replicas","value":[0-9]+' \
    "$KUBECTL_LOG"
}

run_stale_helper_cleanup_tests() {
  local confirmation evidence_sha lease_failure_mode terminating_lock_mode
  evidence_sha="$(sha256_digest "$GOOD_CHECKPOINT/deployment-images.json")"
  confirmation="restore-lock:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:restore-lock-uid:fixture-pvc-uid:$evidence_sha:legacy-absent"

  reset_stub
  seed_checkpoint_backup_guard
  # shellcheck disable=SC2016 # Expanded by the isolated Bash process.
  expect_success 'exact operation-lock control fixture is accepted' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid NAMESPACE=hcce bash -c '
      set -Eeuo pipefail
      source "$1"
      RECOVERY_CHECKPOINT_STAMP="$2"
      RECOVERY_DUMP_SHA256="$3"
      RECOVERY_STORAGE_SHA256="$4"
      recovery_require_operation_lock
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
      "$STAMP" "$DUMP_SHA" "$STORAGE_SHA"

  for terminating_lock_mode in \
    restore-lock-deletion-timestamp \
    restore-lock-deletion-grace \
    restore-lock-finalizer \
    restore-lock-owner-reference; do
    reset_stub
    seed_checkpoint_backup_guard
    # shellcheck disable=SC2016 # Expanded by the isolated Bash process.
    expect_failure "exact operation lock rejects $terminating_lock_mode" \
      'coordinated recovery lock identity or operation binding changed' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_MODE="$terminating_lock_mode" \
      NAMESPACE=hcce bash -c '
        set -Eeuo pipefail
        source "$1"
        RECOVERY_CHECKPOINT_STAMP="$2"
        RECOVERY_DUMP_SHA256="$3"
        RECOVERY_STORAGE_SHA256="$4"
        recovery_require_operation_lock
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
        "$STAMP" "$DUMP_SHA" "$STORAGE_SHA"
    if grep -q \
         'get configmap yenhubs-recovery-operation-lock -n hcce -o json' \
         "$KUBECTL_LOG" &&
       ! grep -Eq 'create -f|patch |replace |delete --raw=' "$KUBECTL_LOG"; then
      pass "$terminating_lock_mode is rejected read-only before mutation"
    else
      fail "$terminating_lock_mode exact-lock fail-closed boundary" \
        "$(cat "$KUBECTL_LOG")"
    fi
  done

  reset_stub
  seed_schema2_legacy_stale_restore_lock available
  seed_stale_restore_helper
  expect_success 'stale-lock recovery removes its exact operation-bound helper before the lock' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
    STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
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
     jq -e '.preconditions == {uid:"restore-lock-uid",resourceVersion:"lock-rv-1"}' \
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
    seed_schema2_legacy_stale_restore_lock available
    seed_stale_restore_helper
    expect_failure "stale helper cleanup rejects $lease_failure_mode" '' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
      STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
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
  seed_schema2_legacy_stale_restore_lock available
  seed_stale_restore_helper
  expect_failure 'stale helper same-name replacement is never adopted or deleted' \
    'identity/spec changed' env EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
    STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
    CONFIRM_CLEAR_RESTORE_LOCK="$confirmation" \
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

prepare_reactivation_preflight_fixtures() {
  local source_parent_mode
  [[ -n "${PREFLIGHT_FIXTURES_READY:-}" ]] && return 0
  initialize_durable_restore_fixture || return 1
  initialize_schema3_legacy_restore_fixture || return 1

  PREFLIGHT_SOURCE_DIR="$TMP_DIR/preflight-public-parent"
  PREFLIGHT_BIN="$TMP_DIR/preflight-bin"
  PREFLIGHT_VALUES_DURABLE="$PREFLIGHT_SOURCE_DIR/values-durable.yaml"
  PREFLIGHT_VALUES_LEGACY="$PREFLIGHT_SOURCE_DIR/values-legacy.yaml"
  PREFLIGHT_KEY="$PREFLIGHT_SOURCE_DIR/cutover-owner.key"
  PREFLIGHT_WRONG_KEY="$PREFLIGHT_SOURCE_DIR/cutover-owner-wrong.key"
  PREFLIGHT_DURABLE_DEPLOYMENTS="$TMP_DIR/preflight-durable-deployments.json"
  PREFLIGHT_LEGACY_DEPLOYMENTS="$TMP_DIR/preflight-legacy-deployments.json"
  mkdir -p "$PREFLIGHT_SOURCE_DIR" "$PREFLIGHT_BIN"
  chmod 755 "$PREFLIGHT_SOURCE_DIR"
  chmod 700 "$PREFLIGHT_BIN"

  cp "$VALUES_FIXTURE" "$PREFLIGHT_VALUES_DURABLE"
  cat >>"$PREFLIGHT_VALUES_DURABLE" <<'YAML'
HUB_DOMAIN: hubs.fixture.invalid
ADM_EMAIL: fixture@example.invalid
DB_USER: fixture-db-user
DB_PASS: fixture-db-password-not-a-secret
SMTP_SERVER: smtp.fixture.invalid
SMTP_PORT: 2525
SMTP_USER: fixture-smtp-user
SMTP_PASS: fixture-smtp-password-not-a-secret
NODE_COOKIE: fixture-node-cookie-at-least-32-characters
GUARDIAN_KEY: fixture-guardian-key-at-least-32-characters
PHX_KEY: fixture-value-aaaaaaaaaaaaaaaaaaaaaaaa
PERMS_KEY: fixture-value-bbbbbbbbbbbbbbbbbbbbbbbb
BOT_ACCESS_KEY: fixture-bot-key-domain-at-least-32-characters
BOT_RUNNER_ACCESS_KEY: fixture-runner-key-domain-at-least-32-characters
DASHBOARD_ACCESS_KEY: fixture-dashboard-key-domain-at-least-32-characters
OPENAI_API_KEY: fixture-openai-key-not-a-secret
GENERATE_PERSISTENT_VOLUMES: true
PERSISTENT_VOLUME_STORAGE_CLASS: do-block-storage
PERSISTENT_VOLUME_SIZE: 10Gi
YAML
  sed 's|^OVERRIDE_BOT_RUNNER_IMAGE:.*$|OVERRIDE_BOT_RUNNER_IMAGE: No|' \
    "$PREFLIGHT_VALUES_DURABLE" >"$PREFLIGHT_VALUES_LEGACY"
  cp "$PROCESS_LOCAL_CUTOVER_KEY_PATH" "$PREFLIGHT_KEY"
  printf '%s\n' 'fixture-wrong-cutover-owner-key-material' >"$PREFLIGHT_WRONG_KEY"
  chmod 600 "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_VALUES_LEGACY" \
    "$PREFLIGHT_KEY" "$PREFLIGHT_WRONG_KEY"
  source_parent_mode="$(file_mode "$PREFLIGHT_SOURCE_DIR")" || return 1
  [[ "$source_parent_mode" == 755 ]] || return 1

  jq '
    (.items[] | select(.metadata.name == "reticulum" or
      .metadata.name == "coturn" or .metadata.name == "dialog" or
      .metadata.name == "pgsql") | .spec.strategy) = {type:"Recreate"}
  ' "$KUBERNETES_DEPLOYMENTS_JSON" >"$PREFLIGHT_DURABLE_DEPLOYMENTS"
  jq '
    (.items[] | select(.metadata.name == "reticulum" or
      .metadata.name == "coturn" or .metadata.name == "dialog" or
      .metadata.name == "pgsql") | .spec.strategy) = {type:"Recreate"}
  ' "$LEGACY_DEPLOYMENTS_JSON" >"$PREFLIGHT_LEGACY_DEPLOYMENTS"

  REAL_NODE_BIN="$(command -v node)" || return 1
  REAL_DATE_BIN="$(command -v date)" || return 1
  export REAL_NODE_BIN REAL_DATE_BIN
  cat >"$PREFLIGHT_BIN/node" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == */verify-bot-image-pull-config.mjs ]]; then
  printf '%s\n' "$*" >>"$STUB_STATE_DIR/preflight-bot-pull-verifier.log"
  exit 0
fi
exec "$REAL_NODE_BIN" "$@"
STUB
  cat >"$PREFLIGHT_BIN/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
working_directory=""
if [[ "${1:-}" == -C ]]; then working_directory="$2"; shift 2; fi
case "${1:-}" in
  branch)
    [[ "${2:-}" == --show-current ]] || exit 2
    printf 'main\n'
    ;;
  ls-tree)
    case "${3:-}" in
      hubs) printf '160000 commit %040d\thubs\n' 1 ;;
      hubs-cloud) printf '160000 commit %040d\thubs-cloud\n' 2 ;;
      *) exit 2 ;;
    esac
    ;;
  rev-parse)
    case "$working_directory" in
      */hubs) printf '%040d\n' 1 ;;
      */hubs-cloud) printf '%040d\n' 2 ;;
      *) exit 2 ;;
    esac
    ;;
  status) : ;;
  *) exit 2 ;;
esac
STUB
  cat >"$PREFLIGHT_BIN/doctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'account get --context yenhubs') printf '{}\n' ;;
  'kubernetes cluster list --context yenhubs -o json')
    printf '%s\n' '[{"id":"fixture-cluster-id","name":"hubs-ce","region":"ams3","status":{"state":"running"},"ha":false,"node_pools":[{"size":"s-4vcpu-8gb","count":1}]}]'
    ;;
  'compute volume list --context yenhubs -o json')
    printf '%s\n' '[{"size_gigabytes":10,"tags":["k8s:fixture-cluster-id"]},{"size_gigabytes":10,"tags":["k8s:fixture-cluster-id"]}]'
    ;;
  'compute load-balancer list --context yenhubs -o json')
    printf '%s\n' '[{"ip":"203.0.113.10"}]'
    ;;
  *) exit 2 ;;
esac
STUB
  cat >"$PREFLIGHT_BIN/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$STUB_STATE_DIR/preflight-curl.log"
if [[ "$*" == *'/token?'* ]]; then
  printf '%s\n' '{"token":"fixture-registry-bearer"}'
else
  printf '200'
fi
STUB
  cat >"$PREFLIGHT_BIN/helm" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat >"$PREFLIGHT_BIN/date" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${STUB_MODE:-}" == preflight-ttl-final && "$*" == '-u +%s' ]]; then
  count=1
  [[ ! -f "$STUB_STATE_DIR/preflight-date-count" ]] ||
    count=$(( $(cat "$STUB_STATE_DIR/preflight-date-count") + 1 ))
  printf '%s' "$count" >"$STUB_STATE_DIR/preflight-date-count"
  if [[ -e "$STUB_STATE_DIR/preflight-final-revalidation-complete" ]]; then
    printf '%s\n' "$((PREFLIGHT_CHECKPOINT_EPOCH + 2))"
  else
    printf '%s\n' "$PREFLIGHT_CHECKPOINT_EPOCH"
  fi
  exit 0
fi
exec "$REAL_DATE_BIN" "$@"
STUB
  chmod 700 "$PREFLIGHT_BIN/node" "$PREFLIGHT_BIN/git" \
    "$PREFLIGHT_BIN/doctl" "$PREFLIGHT_BIN/curl" "$PREFLIGHT_BIN/helm" \
    "$PREFLIGHT_BIN/date"
  PREFLIGHT_FIXTURES_READY=1
}

run_reactivation_preflight_fixture() {
  local checkpoint="$1" values="$2" deployments="$3" key="$4"
  local runner_namespace="$5" pod_profile="$6"
  local checkpoint_runner_generation
  shift 6
  checkpoint_runner_generation="$(
    jq -er '.runtime_generation |
      select(. == "legacy-absent" or . == "durable-v2")' \
      "$checkpoint/checkpoint-metadata.json"
  )" || return 1
  if [[ "$checkpoint_runner_generation" == durable-v2 ]]; then
    # A live/active application source has the recovery-only admission fence
    # present but dormant. reset_stub deliberately removes that mutable state.
    seed_recovery_operation_fence_binding_state dormant || return 1
  fi
  local -a common=(
    PATH="$PREFLIGHT_BIN:$PATH"
    TMPDIR="$TMP_DIR"
    BACKUP_DIR="$checkpoint"
    VALUES_FILE="$values"
    EXPECTED_KUBE_CONTEXT=fixture-context
    EXPECTED_NAMESPACE_UID=fixture-uid
    EXPECTED_RET_PVC_UID=fixture-pvc-uid
    STUB_DEPLOYMENTS_JSON="$deployments"
    STUB_RUNNER_NAMESPACE="$runner_namespace"
    STUB_RUNNER_POD_PROFILE="$pod_profile"
  )
  if [[ "$key" == absent ]]; then
    env -u PROCESS_LOCAL_CUTOVER_KEY_PATH "${common[@]}" "$@" \
      "$ROOT_DIR/deployment/preflight-reactivation.sh"
  else
    env "${common[@]}" PROCESS_LOCAL_CUTOVER_KEY_PATH="$key" "$@" \
      "$ROOT_DIR/deployment/preflight-reactivation.sh"
  fi
}

run_reactivation_preflight_tests() {
  local first_values_snapshot first_key_snapshot source_parent_mode
  local values_snapshot_parent_mode key_snapshot_parent_mode checkpoint_epoch
  local reticulum_drift_mode
  prepare_reactivation_preflight_fixtures || return 1

  reset_stub
  expect_success 'durable reactivation preflight uses private snapshots from a 0755 source parent' \
    run_reactivation_preflight_fixture "$DURABLE_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_DURABLE_DEPLOYMENTS" \
      "$PREFLIGHT_KEY" present active-valid
  source_parent_mode="$(file_mode "$PREFLIGHT_SOURCE_DIR")"
  first_values_snapshot="$(awk -F '\t' 'NR == 1 {print $2}' \
    "$STUB_STATE_DIR/runner-control-plane-verifier.log" 2>/dev/null || :)"
  first_key_snapshot="$(awk -F '\t' 'NR == 1 {print $4}' \
    "$STUB_STATE_DIR/runner-control-plane-verifier.log" 2>/dev/null || :)"
  values_snapshot_parent_mode="$(awk -F '\t' 'NR == 1 {print $5}' \
    "$STUB_STATE_DIR/runner-control-plane-verifier.log" 2>/dev/null || :)"
  key_snapshot_parent_mode="$(awk -F '\t' 'NR == 1 {print $6}' \
    "$STUB_STATE_DIR/runner-control-plane-verifier.log" 2>/dev/null || :)"
  if [[ "$source_parent_mode" == 755 &&
        "$first_values_snapshot" != "$PREFLIGHT_VALUES_DURABLE" &&
        "$first_key_snapshot" != "$PREFLIGHT_KEY" &&
        "$values_snapshot_parent_mode" == 700 &&
        "$key_snapshot_parent_mode" == 700 &&
        "$LAST_OUTPUT" == *'PASS  Contrato final live sigue ligado al checkpoint privado'* ]]; then
    pass 'durable preflight binds only private 0700 snapshot parents before final PASS'
  else
    fail 'durable preflight private snapshot binding' "$LAST_OUTPUT"
  fi

  reset_stub
  expect_failure 'durable reactivation preflight rejects a missing cutover key before PASS' \
    'PROCESS_LOCAL_CUTOVER_KEY_PATH es obligatorio' \
    run_reactivation_preflight_fixture "$DURABLE_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_DURABLE_DEPLOYMENTS" \
      absent present active-valid
  if [[ "$LAST_OUTPUT" != *'PASS  Evidencia durable, journal, RBAC y fences'* &&
        "$LAST_OUTPUT" != *'PASS  Contrato final live sigue ligado'* ]]; then
    pass 'missing durable key emits no evidence or final live PASS'
  else
    fail 'missing durable key PASS suppression' "$LAST_OUTPUT"
  fi

  reset_stub
  expect_failure 'durable reactivation preflight rejects a drifted cutover key before PASS' \
    'La evidencia durable live no coincide' \
    run_reactivation_preflight_fixture "$DURABLE_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_DURABLE_DEPLOYMENTS" \
      "$PREFLIGHT_WRONG_KEY" present active-valid
  if [[ "$LAST_OUTPUT" == *'runner_cutover_checkpoint_evidence_failed:durable_cutover_journal_invalid'* &&
        "$LAST_OUTPUT" != *'PASS  Evidencia durable, journal, RBAC y fences'* &&
        "$LAST_OUTPUT" != *'PASS  Contrato final live sigue ligado'* ]]; then
    pass 'drifted durable key emits no evidence or final live PASS'
  else
    fail 'drifted durable key PASS suppression' "$LAST_OUTPUT"
  fi

  reset_stub
  expect_failure 'durable reactivation preflight blocks live control-plane drift' \
    'Cruce o deriva de generacion runner' \
    run_reactivation_preflight_fixture "$DURABLE_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_DURABLE_DEPLOYMENTS" \
      "$PREFLIGHT_KEY" present active-valid \
      STUB_RUNNER_RESOURCE_DRIFT=bot-runner-guard

  reset_stub
  expect_failure 'reactivation final second read blocks live image drift' \
    'El destino live cambió durante el preflight' \
    run_reactivation_preflight_fixture "$DURABLE_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_DURABLE_DEPLOYMENTS" \
      "$PREFLIGHT_KEY" present active-valid STUB_MODE=preflight-final-image-drift
  if [[ "$LAST_OUTPUT" == *'PASS  Imagenes live coinciden exactamente con el checkpoint'* &&
        "$LAST_OUTPUT" != *'PASS  Contrato final live sigue ligado'* ]]; then
    pass 'final image drift occurs only after the initial live PASS and suppresses final PASS'
  else
    fail 'reactivation second-read drift sequencing' "$LAST_OUTPUT"
  fi

  reset_stub
  expect_failure 'reactivation final second read blocks Reticulum Pod disappearance' \
    'Reticulum no conserva su contrato singleton/Recreate/HPA/Ready al final' \
    run_reactivation_preflight_fixture "$DURABLE_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_DURABLE_DEPLOYMENTS" \
      "$PREFLIGHT_KEY" present active-valid \
      STUB_MODE=preflight-final-reticulum-pod-drift
  if [[ "$LAST_OUTPUT" == *'PASS  Reticulum preflight: exactamente un pod Ready'* &&
        "$LAST_OUTPUT" != *'PASS  Reticulum conserva al final Deployment, HPA y Pod Ready'* &&
        "$LAST_OUTPUT" != *'PASS  Contrato final live sigue ligado'* ]]; then
    pass 'final Reticulum Pod drift occurs after initial identity PASS and suppresses final PASS'
  else
    fail 'reactivation final Reticulum identity sequencing' "$LAST_OUTPUT"
  fi

  for reticulum_drift_mode in owner uid; do
    reset_stub
    expect_failure "reactivation final second read blocks Reticulum $reticulum_drift_mode drift" \
      'Reticulum cambio de Pod o autoridad durante la revalidacion final' \
      run_reactivation_preflight_fixture "$DURABLE_RESTORE_CHECKPOINT" \
        "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_DURABLE_DEPLOYMENTS" \
        "$PREFLIGHT_KEY" present active-valid \
        STUB_MODE="preflight-final-reticulum-$reticulum_drift_mode-drift"
    if [[ "$LAST_OUTPUT" == *'PASS  Reticulum preflight: exactamente un pod Ready'* &&
          "$LAST_OUTPUT" != *'PASS  Contrato final live sigue ligado'* ]]; then
      pass "final Reticulum $reticulum_drift_mode drift suppresses combined final PASS"
    else
      fail "reactivation final Reticulum $reticulum_drift_mode sequencing" \
        "$LAST_OUTPUT"
    fi
  done

  reset_stub
  expect_success 'legacy reactivation preflight accepts No with pgsql/postgresql' \
    run_reactivation_preflight_fixture "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_LEGACY" "$PREFLIGHT_LEGACY_DEPLOYMENTS" \
      absent '' ''
  if [[ "$LAST_OUTPUT" == *'PASS  Runtime legacy conserva OVERRIDE_BOT_RUNNER_IMAGE=No'* &&
        "$LAST_OUTPUT" == *'PASS  Inventario ligado a 13 Deployments'* &&
        "$LAST_OUTPUT" == *'PASS  Contrato final live sigue ligado al checkpoint privado'* &&
        -s "$STUB_STATE_DIR/preflight-curl.log" ]] &&
     grep -q '/v2/yengalvez/bot-orchestrator/manifests/sha256:' \
       "$STUB_STATE_DIR/preflight-curl.log"; then
    pass 'legacy preflight probes the bot-orchestrator digest in the registry'
  else
    fail 'legacy No/postgresql/registry contract' "$LAST_OUTPUT"
  fi

  reset_stub
  expect_failure 'legacy reactivation preflight blocks any durable runner residue' \
    'Cruce o deriva de generacion runner' \
    run_reactivation_preflight_fixture "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_LEGACY" "$PREFLIGHT_LEGACY_DEPLOYMENTS" \
      absent present fence-stable

  reset_stub
  checkpoint_epoch="$(jq -er '.created_at_epoch' \
    "$DURABLE_RESTORE_CHECKPOINT/checkpoint-metadata.json")"
  expect_failure 'checkpoint TTL expiration during final live revalidation blocks preflight' \
    'expir' run_reactivation_preflight_fixture "$DURABLE_RESTORE_CHECKPOINT" \
      "$PREFLIGHT_VALUES_DURABLE" "$PREFLIGHT_DURABLE_DEPLOYMENTS" \
      "$PREFLIGHT_KEY" present active-valid STUB_MODE=preflight-ttl-final \
      PREFLIGHT_CHECKPOINT_EPOCH="$checkpoint_epoch" MAX_CHECKPOINT_AGE_SECONDS=1
  if [[ -e "$STUB_STATE_DIR/preflight-final-revalidation-complete" &&
        "$LAST_OUTPUT" != *'PASS  Contrato final live sigue ligado'* ]]; then
    pass 'TTL failure is measured after the second durable evidence read'
  else
    fail 'final TTL sequencing' "$LAST_OUTPUT"
  fi
}

prepare_checkpoint_writer_monitor_fixture() {
  local runtime_generation="${1:-durable-v2}"
  local operation_owner="${2:-checkpoint-backup}"
  [[ "$runtime_generation" =~ ^(durable-v2|legacy-absent)$ ]] || return 2
  [[ "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ ]] || return 2
  reset_stub
  seed_checkpoint_backup_guard
  if [[ "$operation_owner" == checkpoint-restore ]]; then
    sed 's/checkpoint-backup/checkpoint-restore/g' \
      "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
    mv "$STUB_STATE_DIR/restore-lock.next" "$STUB_STATE_DIR/restore-lock.yaml"
    RECOVERY_OPERATION_OWNER='checkpoint-restore'
    export RECOVERY_OPERATION_OWNER
  fi
  STUB_CHECKPOINT_WRITER_OPERATION_OWNER="$operation_owner"
  export STUB_CHECKPOINT_WRITER_OPERATION_OWNER
  WRITER_TEST_DIR="$(mktemp -d "$TMP_DIR/checkpoint-writer-monitor.XXXXXX")" || return 1
  chmod 700 "$WRITER_TEST_DIR" || return 1
  WRITER_TEST_CONTRACT="$WRITER_TEST_DIR/consumer-contract.json"
  WRITER_TEST_BASELINE="$WRITER_TEST_DIR/baseline.json"
  WRITER_TEST_STOP="$WRITER_TEST_DIR/stop"
  WRITER_TEST_FAILURE="$WRITER_TEST_DIR/failure"
  WRITER_TEST_READY="$WRITER_TEST_DIR/ready"
  WRITER_TEST_PROGRESS="$WRITER_TEST_DIR/progress"
  WRITER_TEST_FINAL="$WRITER_TEST_DIR/final"
  printf '%s\n' "$RECOVERY_CONSUMER_CONTRACT_JSON" >"$WRITER_TEST_CONTRACT"
  : >"$WRITER_TEST_BASELINE"
  : >"$WRITER_TEST_STOP"
  : >"$WRITER_TEST_FAILURE"
  : >"$WRITER_TEST_READY"
  : >"$WRITER_TEST_PROGRESS"
  : >"$WRITER_TEST_FINAL"
  chmod 600 "$WRITER_TEST_CONTRACT" "$WRITER_TEST_BASELINE" \
    "$WRITER_TEST_STOP" "$WRITER_TEST_FAILURE" "$WRITER_TEST_READY" \
    "$WRITER_TEST_PROGRESS" "$WRITER_TEST_FINAL"
  WRITER_TEST_CONTRACT_SHA="$(sha256_digest "$WRITER_TEST_CONTRACT")" || return 1
  WRITER_TEST_COMMON_ARGS=(
    --context fixture-context
    --namespace hcce
    --namespace-uid fixture-uid
    --contract "$WRITER_TEST_CONTRACT"
    --contract-sha256 "$WRITER_TEST_CONTRACT_SHA"
    --baseline "$WRITER_TEST_BASELINE"
    --operation-lock-name yenhubs-recovery-operation-lock
    --operation-lock-uid restore-lock-uid
    --operation-lock-resource-version lock-rv-1
    --operation-owner "$operation_owner"
    --operation-id "$RECOVERY_OPERATION_ID"
    --lease-name yenhubs-operation-serialization
    --lease-uid serialization-lease-uid
    --lease-holder "$YENHUBS_PARENT_LEASE_HOLDER"
    --runtime-generation "$runtime_generation"
  )
}

start_checkpoint_writer_test_monitor() {
  local mode="$1" require_live_terminal="" terminal_timeout_seconds=""
  local authority_json authority_path gate_path monitor_log writer_identity=""
  case "$mode" in
    checkpoint-writer-terminal-live|checkpoint-writer-terminal-list-gap|\
      checkpoint-writer-terminal-control-gap)
      require_live_terminal=1
      ;;
  esac
  if [[ "$mode" == checkpoint-writer-terminal-list-gap ]]; then
    terminal_timeout_seconds=1
  fi
  authority_path="${WRITER_TEST_READY}.authority.json"
  gate_path="${WRITER_TEST_READY}.spawn-gate"
  monitor_log="${WRITER_TEST_READY}.monitor.log"
  : >"$gate_path"
  : >"$monitor_log"
  chmod 600 "$gate_path" "$monitor_log"
  env STUB_MODE="$mode" \
    KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
    YENHUBS_RECOVERY_TEST_MODE=local-fixture \
    YENHUBS_WATCH_TEST_REQUIRE_LIVE_TERMINAL="$require_live_terminal" \
    YENHUBS_WATCH_TEST_TERMINAL_TIMEOUT_SECONDS="$terminal_timeout_seconds" \
    RECOVERY_TEST_STABLE_ABSENCE_SECONDS=0 \
    python3 -I -c '
import os
import sys
import time
os.setsid()
gate_path = sys.argv[1]
while True:
    with open(gate_path, "rb") as gate:
        decision = gate.read(16)
    if decision == b"go\n":
        break
    if decision not in (b"",):
        sys.exit(1)
    time.sleep(0.01)
os.execvp(sys.argv[2], sys.argv[2:])
' "$gate_path" node "$ROOT_DIR/deployment/watch-checkpoint-writers.mjs" monitor \
      "${WRITER_TEST_COMMON_ARGS[@]}" \
      --stop "$WRITER_TEST_STOP" --failure "$WRITER_TEST_FAILURE" \
      --ready "$WRITER_TEST_READY" --progress "$WRITER_TEST_PROGRESS" \
      --final "$WRITER_TEST_FINAL" --authority "$authority_path" \
      >"$monitor_log" 2>&1 &
  # shellcheck disable=SC2031 # This shell owns the gated writer-monitor PID.
  WRITER_TEST_PID=$!
  writer_identity="$(
    # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
    bash -c 'source "$1"; recovery_process_start_identity "$2"' _ \
      "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$WRITER_TEST_PID"
  )" || return 1
  authority_json="$(jq -cnS \
    --argjson pid "$WRITER_TEST_PID" --arg start_identity "$writer_identity" \
    --arg owner "$STUB_CHECKPOINT_WRITER_OPERATION_OWNER" \
    --arg generation "${WRITER_TEST_COMMON_ARGS[29]}" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg lease_holder "$YENHUBS_PARENT_LEASE_HOLDER" \
    --arg authority "$authority_path" --arg contract "$WRITER_TEST_CONTRACT" \
    --arg baseline "$WRITER_TEST_BASELINE" --arg stop "$WRITER_TEST_STOP" \
    --arg failure "$WRITER_TEST_FAILURE" --arg ready "$WRITER_TEST_READY" \
    --arg progress "$WRITER_TEST_PROGRESS" --arg final "$WRITER_TEST_FINAL" \
    --arg contract_sha256 "$WRITER_TEST_CONTRACT_SHA" '
    {schema_version:1,kind:"checkpoint-writer-monitor",pid:$pid,
     start_identity:$start_identity,context:"fixture-context",namespace:"hcce",
     namespace_uid:"fixture-uid",operation_id:$operation_id,
     operation_owner:$owner,runtime_generation:$generation,
     operation_lock:{name:"yenhubs-recovery-operation-lock",uid:"restore-lock-uid",
       resource_version:"lock-rv-1"},
     lease:{name:"yenhubs-operation-serialization",uid:"serialization-lease-uid",
       holder:$lease_holder},
     paths:{authority:$authority,contract:$contract,baseline:$baseline,stop:$stop,
       failure:$failure,ready:$ready,progress:$progress,final:$final},
     hashes:{contract_sha256:$contract_sha256}}
  ')" || return 1
  printf '%s\n' "$authority_json" >"$authority_path"
  chmod 600 "$authority_path"
  printf 'go\n' >"$gate_path"
}

wait_checkpoint_writer_test_handoff() {
  local _
  for _ in {1..500}; do
    [[ ! -s "$WRITER_TEST_READY" && ! -s "$WRITER_TEST_FAILURE" ]] || return 0
    kill -0 "$WRITER_TEST_PID" 2>/dev/null || return 0
    sleep 0.01
  done
  if kill -0 "$WRITER_TEST_PID" 2>/dev/null; then
    # Reap the timed-out monitor so an inherited capture pipe cannot keep the
    # focused test alive after the causal failure has already been observed.
    kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
  fi
  wait "$WRITER_TEST_PID" 2>/dev/null || :
  return 1
}

checkpoint_writer_boundary() {
  local baseline_sha="$1" mode="${2:-}"
  env STUB_MODE="$mode" \
    KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
    YENHUBS_RECOVERY_TEST_MODE=local-fixture \
    RECOVERY_TEST_STABLE_ABSENCE_SECONDS=0 \
    node "$ROOT_DIR/deployment/watch-checkpoint-writers.mjs" boundary \
      "${WRITER_TEST_COMMON_ARGS[@]}" --baseline-sha256 "$baseline_sha"
}

trace_phases_are_ordered() {
  local trace_path="$1" phase line previous=0
  shift
  [[ -f "$trace_path" ]] || return 1
  for phase in "$@"; do
    line="$(awk -v phase="$phase" '$0 == phase {print NR; exit}' "$trace_path")"
    [[ "$line" =~ ^[1-9][0-9]*$ && "$line" -gt "$previous" ]] || return 1
    previous="$line"
  done
}

configure_legacy_receipt_monitor_library_context() {
  NAMESPACE=hcce
  EXPECTED_KUBE_CONTEXT=fixture-context
  EXPECTED_NAMESPACE_UID=fixture-uid
  EXPECTED_RET_PVC_UID=fixture-pvc-uid
  export NAMESPACE EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID \
    EXPECTED_RET_PVC_UID
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  seed_restore_lock adopted
  RECOVERY_NAMESPACE_UID=fixture-uid
  RECOVERY_PVC_UID=fixture-pvc-uid
  RECOVERY_CHECKPOINT_STAMP="$STAMP"
  RECOVERY_DUMP_SHA256="$DUMP_SHA"
  RECOVERY_STORAGE_SHA256="$STORAGE_SHA"
  RECOVERY_CHECKPOINT_RUNNER_GENERATION=legacy-absent
  RECOVERY_CHECKPOINT_METADATA_SCHEMA=2
  RECOVERY_CHECKPOINT_METADATA_COPY="$GOOD_CHECKPOINT/checkpoint-metadata.json"
  RECOVERY_DEPLOYMENT_INVENTORY_COPY="$GOOD_CHECKPOINT/deployment-images.json"
  RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY=""
  KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer"
  export RECOVERY_NAMESPACE_UID RECOVERY_PVC_UID RECOVERY_CHECKPOINT_STAMP \
    RECOVERY_DUMP_SHA256 RECOVERY_STORAGE_SHA256 \
    RECOVERY_CHECKPOINT_RUNNER_GENERATION RECOVERY_CHECKPOINT_METADATA_SCHEMA \
    RECOVERY_CHECKPOINT_METADATA_COPY RECOVERY_DEPLOYMENT_INVENTORY_COPY \
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY KUBECTL_BIN
  recovery_adopt_parent_operation_serialization \
    "$YENHUBS_PARENT_LEASE_HOLDER" "$YENHUBS_PARENT_LEASE_UID" \
    "$YENHUBS_PARENT_PROCESS_PID" \
    "$YENHUBS_PARENT_PROCESS_START_IDENTITY"
}

run_legacy_receipt_monitor_handoff_case() {
  local mode="$1" expected="$2" trace_path="$3"
  local ready baseline_sha authority_sha handoff_token="" armed_json=""
  local target_selector target_fingerprint patch_rv="" joined=0 ack_json=""
  local writer_identity="" arm_status=0 commit_status=0 monitor_status=0 _
  [[ "${YENHUBS_RECOVERY_TEST_DEBUG:-0}" != 1 ]] || set -x
  prepare_checkpoint_writer_monitor_fixture \
    legacy-absent checkpoint-restore || return 1
  configure_legacy_receipt_monitor_library_context || return 1
  STUB_CHECKPOINT_WRITER_MONITOR_DIR="$WRITER_TEST_DIR"
  STUB_CHECKPOINT_RECEIPT_TRACE="$trace_path"
  STUB_MODE="$mode"
  export STUB_CHECKPOINT_WRITER_MONITOR_DIR STUB_CHECKPOINT_RECEIPT_TRACE \
    STUB_MODE
  : >"$trace_path"
  start_checkpoint_writer_test_monitor "$mode"
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  [[ "$ready" =~ ^ready:([a-f0-9]{64}):([a-f0-9]{64})$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  authority_sha="${BASH_REMATCH[2]}"
  writer_identity="$(recovery_process_start_identity "$WRITER_TEST_PID")" || return 1
  target_selector="$(jq -er '
    [.consumers[] | select(.name == "reticulum")] |
    select(length == 1) | .[0].selector
  ' "$WRITER_TEST_CONTRACT")" || return 1
  target_fingerprint="$(jq -er '
    [.consumers[] | select(.name == "reticulum")] |
    select(length == 1) | .[0].fingerprint
  ' "$WRITER_TEST_CONTRACT")" || return 1

  if [[ "${YENHUBS_RECOVERY_TEST_DEBUG:-0}" == 1 ]]; then
    {
      printf 'owner=%s state=%s checkpoint_generation=%s runtime_generation=%s operation=%s lock=%s/%s/%s lease=%s/%s/%s watcher=%s/%s authority=%s\n' \
        "${RECOVERY_OPERATION_OWNER:-}" "${RECOVERY_OPERATION_STATE:-}" \
        "${RECOVERY_CHECKPOINT_RUNNER_GENERATION:-}" \
        "${RECOVERY_RUNNER_RUNTIME_GENERATION:-}" \
        "${RECOVERY_OPERATION_ID:-}" "${RECOVERY_OPERATION_LOCK_NAME:-}" \
        "${RECOVERY_OPERATION_LOCK_UID:-}" \
        "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" \
        "${RECOVERY_SERIALIZATION_LEASE_NAME:-}" \
        "${RECOVERY_SERIALIZATION_LEASE_UID:-}" \
        "${RECOVERY_SERIALIZATION_LEASE_HOLDER:-}" \
        "$WRITER_TEST_PID" "$writer_identity" "$authority_sha"
      for _ in mutation-context serialization operation-lock contract-file \
        baseline-file monitor-health authority-exact stop-marker failure-marker \
        final-marker; do
        case "$_" in
          mutation-context)
            recovery_require_legacy_checkpoint_receipt_mutation_context reticulum ;;
          serialization) recovery_require_operation_serialization ;;
          operation-lock) recovery_require_operation_lock ;;
          contract-file) recovery_checkpoint_writer_monitor_file_is_exact \
            "$WRITER_TEST_CONTRACT" "$WRITER_TEST_CONTRACT_SHA" 131072 ;;
          baseline-file) recovery_checkpoint_writer_monitor_file_is_exact \
            "$WRITER_TEST_BASELINE" "$baseline_sha" 2097152 ;;
          monitor-health) recovery_require_checkpoint_writer_monitor_healthy \
            "$WRITER_TEST_CONTRACT" "$WRITER_TEST_CONTRACT_SHA" \
            "$WRITER_TEST_BASELINE" "$baseline_sha" "$WRITER_TEST_FAILURE" \
            "$WRITER_TEST_READY" "$WRITER_TEST_PID" "$writer_identity" \
            legacy-absent checkpoint-restore ;;
          authority-exact) recovery_checkpoint_writer_monitor_authority_is_exact \
            "${WRITER_TEST_READY}.authority.json" "$authority_sha" \
            "$WRITER_TEST_CONTRACT" "$WRITER_TEST_CONTRACT_SHA" \
            "$WRITER_TEST_BASELINE" "$WRITER_TEST_STOP" "$WRITER_TEST_FAILURE" \
            "$WRITER_TEST_READY" "$WRITER_TEST_PROGRESS" "$WRITER_TEST_FINAL" \
            "$WRITER_TEST_PID" "$writer_identity" legacy-absent checkpoint-restore ;;
          stop-marker) recovery_runner_watch_marker_is_exact "$WRITER_TEST_STOP" ;;
          failure-marker) recovery_runner_watch_marker_is_exact "$WRITER_TEST_FAILURE" ;;
          final-marker) recovery_runner_watch_marker_is_exact "$WRITER_TEST_FINAL" ;;
        esac
        printf 'probe:%s:%s\n' "$_" "$?"
      done
    } >"$TMP_DIR/legacy-debug-probes" 2>&1 || :
  fi

  if recovery_arm_checkpoint_writer_receipt_handoff \
      "$WRITER_TEST_CONTRACT" "$WRITER_TEST_CONTRACT_SHA" \
      "$WRITER_TEST_BASELINE" "$baseline_sha" \
      "$WRITER_TEST_STOP" "$WRITER_TEST_FAILURE" "$WRITER_TEST_READY" \
      "$WRITER_TEST_PROGRESS" "$WRITER_TEST_FINAL" "$WRITER_TEST_PID" \
      "$writer_identity" "$authority_sha" legacy-absent checkpoint-restore \
      reticulum uid-reticulum handoff_token armed_json; then
    arm_status=0
  else
    arm_status=$?
  fi

  if [[ "$expected" == arm-failure ]]; then
    for _ in {1..500}; do
      kill -0 "$WRITER_TEST_PID" 2>/dev/null || break
      sleep 0.01
    done
    if kill -0 "$WRITER_TEST_PID" 2>/dev/null; then
      kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
    fi
    if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
    if [[ "$arm_status" != 0 && "$monitor_status" != 0 &&
       "$(cat "$WRITER_TEST_FAILURE" 2>/dev/null || :)" == \
         checkpoint_writer_monitor_failed &&
       ! -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" &&
       ! -e "$STUB_STATE_DIR/checkpoint-receipt-phase-ack" &&
       -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
       checkpoint_all_writers_at 0; then
      [[ "${YENHUBS_RECOVERY_TEST_DEBUG:-0}" != 1 ]] || set +x
      return 0
    fi
    printf 'legacy receipt arm failure diagnostics: arm=%s monitor=%s failure=%q receipt=%s ack=%s lock=%s writers=%s\n' \
      "$arm_status" "$monitor_status" \
      "$(cat "$WRITER_TEST_FAILURE" 2>/dev/null || :)" \
      "$([[ -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] && printf present || printf absent)" \
      "$([[ -e "$STUB_STATE_DIR/checkpoint-receipt-phase-ack" ]] && printf present || printf absent)" \
      "$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)" \
      "$(for _ in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do printf '%s=%s,' "$_" "$(cat "$STUB_STATE_DIR/replicas-$_" 2>/dev/null || printf missing)"; done)" >&2
    [[ "${YENHUBS_RECOVERY_TEST_DEBUG:-0}" != 1 ]] || set +x
    return 1
  fi
  [[ "$arm_status" == 0 && -n "$handoff_token" && -n "$armed_json" ]] || {
    kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
    wait "$WRITER_TEST_PID" 2>/dev/null || :
    return 1
  }
  patch_rv="$(recovery_publish_checkpoint_resume_receipt_exact \
    reticulum uid-reticulum \
    "$(jq -er '.receipt.armed_resource_version' <<<"$armed_json")" \
    "$target_selector" "$target_fingerprint" "$RECOVERY_OPERATION_ID")" || {
      kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
      wait "$WRITER_TEST_PID" 2>/dev/null || :
      return 1
    }
  if recovery_commit_checkpoint_writer_receipt_handoff \
      "$WRITER_TEST_CONTRACT" "$WRITER_TEST_CONTRACT_SHA" \
      "$WRITER_TEST_BASELINE" "$baseline_sha" \
      "$WRITER_TEST_STOP" "$WRITER_TEST_FAILURE" "$WRITER_TEST_READY" \
      "$WRITER_TEST_PROGRESS" "$WRITER_TEST_FINAL" "$WRITER_TEST_PID" \
      "$writer_identity" "$authority_sha" legacy-absent checkpoint-restore \
      reticulum uid-reticulum "$handoff_token" "$armed_json" "$patch_rv" \
      joined ack_json; then
    commit_status=0
  else
    commit_status=$?
  fi
  if [[ "$expected" == success ]]; then
    if ! [[ "$commit_status" == 0 && "$joined" == ok &&
       "$(jq -r '.handoff // empty' <<<"$ack_json")" == receipt-ack &&
       -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" &&
       -e "$STUB_STATE_DIR/restore-lock.yaml" ]] ||
       ! checkpoint_all_writers_at 0; then
      printf 'legacy receipt commit diagnostics: status=%s joined=%q failure=%q final=%q receipt=%s lock=%s writers=%s\n' \
        "$commit_status" "$joined" \
        "$(cat "$WRITER_TEST_FAILURE" 2>/dev/null || :)" \
        "$(cat "$WRITER_TEST_FINAL" 2>/dev/null || :)" \
        "$([[ -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] && printf present || printf absent)" \
        "$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)" \
        "$(for _ in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do printf '%s=%s,' "$_" "$(cat "$STUB_STATE_DIR/replicas-$_" 2>/dev/null || printf missing)"; done)" >&2
      return 1
    fi
    printf '%s\n' "$armed_json" >"$TMP_DIR/legacy-receipt-valid-armed.json"
    printf '%s\n' "$ack_json" >"$TMP_DIR/legacy-receipt-valid-ack.json"
    printf '%s\n' "$handoff_token" >"$TMP_DIR/legacy-receipt-valid-token"
    printf '%s\n' "$authority_sha" >"$TMP_DIR/legacy-receipt-valid-authority"
    printf '%s\n' "$patch_rv" >"$TMP_DIR/legacy-receipt-valid-patch-rv"
    cp "$WRITER_TEST_CONTRACT" "$TMP_DIR/legacy-receipt-valid-contract.json"
    return 0
  fi
  if kill -0 "$WRITER_TEST_PID" 2>/dev/null; then
    kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
    wait "$WRITER_TEST_PID" 2>/dev/null || :
  fi
  if [[ "$commit_status" != 0 && "$joined" != ok &&
     ! -e "$STUB_STATE_DIR/checkpoint-receipt-phase-ack" &&
     -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" &&
     -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && checkpoint_all_writers_at 0; then
    return 0
  fi
  printf 'legacy receipt expected commit-failure diagnostics: status=%s joined=%q failure=%q final=%q receipt=%s ack=%s lock=%s writers=%s\n' \
    "$commit_status" "$joined" \
    "$(cat "$WRITER_TEST_FAILURE" 2>/dev/null || :)" \
    "$(cat "$WRITER_TEST_FINAL" 2>/dev/null || :)" \
    "$([[ -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] && printf present || printf absent)" \
    "$([[ -e "$STUB_STATE_DIR/checkpoint-receipt-phase-ack" ]] && printf present || printf absent)" \
    "$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)" \
    "$(for _ in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do printf '%s=%s,' "$_" "$(cat "$STUB_STATE_DIR/replicas-$_" 2>/dev/null || printf missing)"; done)" >&2
  return 1
}

# Invoked indirectly through expect_success with optional fixture overrides.
# shellcheck disable=SC2120
run_checkpoint_writer_monitor_success() {
  local mode="${1:-}" runtime_generation="${2:-durable-v2}"
  local operation_owner="${3:-checkpoint-backup}"
  local ready baseline_sha authority_sha boundary monitor_status=0
  local first_progress current_progress="" progress_authority typed_path _
  prepare_checkpoint_writer_monitor_fixture \
    "$runtime_generation" "$operation_owner" || return 1
  start_checkpoint_writer_test_monitor "$mode"
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  [[ "$ready" =~ ^ready:([a-f0-9]{64}):([a-f0-9]{64})$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  authority_sha="${BASH_REMATCH[2]}"
  first_progress="$(cat "$WRITER_TEST_PROGRESS")"
  [[ "$first_progress" =~ ^([a-f0-9]{64}):([1-9][0-9]{0,17})$ ]] || return 1
  progress_authority="${BASH_REMATCH[1]}"
  first_progress="${BASH_REMATCH[2]}"
  [[ "$progress_authority" == "$authority_sha" ]] || return 1
  for _ in {1..500}; do
    current_progress="$(cat "$WRITER_TEST_PROGRESS")" || return 1
    [[ "$current_progress" =~ ^([a-f0-9]{64}):([1-9][0-9]{0,17})$ ]] || return 1
    progress_authority="${BASH_REMATCH[1]}"
    current_progress="${BASH_REMATCH[2]}"
    [[ "$progress_authority" == "$authority_sha" ]] || return 1
    ((current_progress >= first_progress)) || return 1
    ((current_progress > first_progress)) && break
    sleep 0.01
  done
  ((current_progress > first_progress)) || return 1
  [[ "$(sha256_digest "$WRITER_TEST_BASELINE")" == "$baseline_sha" ]] || return 1
  jq -e --arg runtime_generation "$runtime_generation" \
    --arg operation_owner "$operation_owner" '
    keys == ["boundaries","consumers","context","deployments","lease","namespace",
      "namespace_uid","operation_id","operation_lock","operation_owner","pods",
      "recovery_operation_fence","replica_sets","runtime_generation",
      "schema_version","storage_helper"] and
    .schema_version == 3 and .runtime_generation == $runtime_generation and
    .context == "fixture-context" and
    .operation_id == "88888888888888888888888888888888" and
    .operation_owner == $operation_owner and
    .operation_lock == {name:"yenhubs-recovery-operation-lock",
      uid:"restore-lock-uid",resource_version:"lock-rv-1"} and
    (if $runtime_generation == "durable-v2" then
      (.recovery_operation_fence | keys) == ["binding","namespaces","policy"] and
      (.recovery_operation_fence.namespaces | keys) == ["parent","runner"] and
      all(.recovery_operation_fence.namespaces[];
        keys == ["metadata_name_label","name","phase","resource_version","uid"] and
        .metadata_name_label == .name and .phase == "Active" and
        (.uid | type == "string" and length > 0) and
        (.resource_version | type == "string" and length > 0)) and
      .recovery_operation_fence.namespaces.parent == {
        metadata_name_label:"hcce",name:"hcce",phase:"Active",
        resource_version:"namespace-rv-hcce",uid:"fixture-uid"} and
      .recovery_operation_fence.namespaces.runner == {
        metadata_name_label:"hcce-bot-runners",name:"hcce-bot-runners",
        phase:"Active",resource_version:"namespace-rv-runner",
        uid:"fixture-runner-namespace-uid"} and
      (.recovery_operation_fence.policy | keys) ==
        ["generation","resource_version","spec_sha256","uid"] and
      .recovery_operation_fence.policy.uid ==
        "recovery-operation-fence-policy-uid" and
      .recovery_operation_fence.policy.resource_version ==
        "recovery-operation-fence-policy-rv-1" and
      .recovery_operation_fence.policy.generation == 7 and
      (.recovery_operation_fence.policy.spec_sha256 |
        test("^[a-f0-9]{64}$")) and
      (.recovery_operation_fence.binding | keys) ==
        ["resource_version","spec_sha256","uid"] and
      .recovery_operation_fence.binding.uid ==
        "recovery-operation-fence-binding-uid" and
      .recovery_operation_fence.binding.resource_version ==
        "recovery-operation-fence-binding-rv-1" and
      (.recovery_operation_fence.binding.spec_sha256 |
        test("^[a-f0-9]{64}$"))
    else .recovery_operation_fence == null end) and
    .namespace == "hcce" and
    .namespace_uid == "fixture-uid" and
    (.lease | keys) == ["acquire_time","holder","lease_transitions","name","uid"] and
    .lease.name == "yenhubs-operation-serialization" and
    .lease.uid == "serialization-lease-uid" and
    (.lease.holder | startswith("root-recovery:")) and
    (.lease.lease_transitions | type == "number") and
    (.storage_helper | keys) == ["image","name"] and
    .storage_helper.name ==
      ((if $operation_owner == "checkpoint-backup" then "ret-storage-backup-"
        else "ret-storage-restore-" end) + "888888888888") and
    .storage_helper.image ==
      ("ghcr.io/yengalvez/reticulum@sha256:" + ("6" * 64)) and
    (.consumers | length) == 5 and
    (.deployments | length) == 12 and
    (.deployments | map(.name)) ==
      ["bot-orchestrator","coturn","dialog","haproxy","hubs","nearspark",
       "pgbouncer","pgbouncer-t","pgsql","photomnemonic","reticulum","spoke"] and
    all(.deployments[];
      keys == ["fingerprint","generation","metadata_fingerprint","name","replicas",
        "resource_version","selector","spec_fingerprint","uid"]) and
    (.replica_sets | length) == 13 and
    all(.replica_sets[];
      keys == ["fingerprint","generation","metadata_fingerprint","name","owner",
        "replicas","resource_version","selector","template_fingerprint","uid"]) and
    ([.replica_sets[].owner.uid] | unique | length) == 12 and
    (.pods | length) == 7 and
    all(.pods[];
      keys == ["admission_fingerprint","fingerprint","name","object_fingerprint",
        "owner","resource_version","role","uid"] and .role == "service") and
    (.boundaries | keys) == ["deployments","pods","replicasets"]
  ' "$WRITER_TEST_BASELINE" >/dev/null || return 1
  boundary="$(checkpoint_writer_boundary "$baseline_sha")" || return 1
  printf '%s\n' "$boundary" >"$WRITER_TEST_STOP"
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" == 0 && ! -s "$WRITER_TEST_FAILURE" &&
     "$(cat "$WRITER_TEST_READY")" == "ready:$baseline_sha:$authority_sha" ]] || return 1
  jq -e --arg authority_sha "$authority_sha" '.complete == true and
    .monitor_authority_sha256 == $authority_sha and
    (.deployments | map(.name)) ==
      ["bot-orchestrator","coturn","pgbouncer","pgbouncer-t","reticulum"] and
    (.deployments | length) == 5 and
    all(.deployments[];
      (.uid | type == "string" and length > 0) and
      (.resource_version | type == "string" and length > 0))' \
    "$WRITER_TEST_FINAL" >/dev/null || return 1
  jq -e '.stop == true and
    (.boundaries | keys | sort) == ["deployments","pods","replicasets"] and
    all(.boundaries[]; type == "string" and length > 0)' \
    >/dev/null <<<"$boundary" || return 1
  for typed_path in \
    /apis/apps/v1/namespaces/hcce/deployments \
    /apis/apps/v1/namespaces/hcce/replicasets \
    /api/v1/namespaces/hcce/pods; do
    grep -Fq -- "get --raw $typed_path" "$KUBECTL_LOG" || return 1
  done
}

run_checkpoint_writer_terminal_gap_failure() {
  local mode="$1" ready baseline_sha boundary monitor_status=0 timed_out=0 _
  prepare_checkpoint_writer_monitor_fixture || return 1
  start_checkpoint_writer_test_monitor "$mode"
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  [[ "$ready" =~ ^ready:([a-f0-9]{64}):[a-f0-9]{64}$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  boundary="$(checkpoint_writer_boundary "$baseline_sha")" || return 1
  printf '%s\n' "$boundary" >"$WRITER_TEST_STOP"
  for _ in {1..1500}; do
    [[ ! -s "$WRITER_TEST_FAILURE" ]] || break
    kill -0 "$WRITER_TEST_PID" 2>/dev/null || break
    sleep 0.01
  done
  if [[ ! -s "$WRITER_TEST_FAILURE" ]] &&
     kill -0 "$WRITER_TEST_PID" 2>/dev/null; then
    timed_out=1
    kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
  fi
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$timed_out" == 0 && "$monitor_status" != 0 &&
     "$(cat "$WRITER_TEST_FAILURE" 2>/dev/null || :)" == \
       checkpoint_writer_monitor_failed && ! -s "$WRITER_TEST_FINAL" ]] || return 1
  case "$mode" in
    checkpoint-writer-terminal-list-gap)
      [[ -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-deployments-closed" &&
         -e "$STUB_STATE_DIR/checkpoint-writer-terminal-list-gap-excursion" ]]
      ;;
    checkpoint-writer-terminal-control-gap)
      [[ -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w1-stopped" &&
         -e "$STUB_STATE_DIR/checkpoint-writer-terminal-w2-deployments-started" &&
         -e "$STUB_STATE_DIR/checkpoint-writer-terminal-control-delay" &&
         -e "$STUB_STATE_DIR/checkpoint-writer-terminal-control-gap-excursion" ]]
      ;;
    *) return 2 ;;
  esac
}

run_checkpoint_writer_monitor_failure() {
  local mode="$1" fixture_mutation="${2:-}"
  local operation_owner="${3:-checkpoint-backup}" monitor_status=0 _
  prepare_checkpoint_writer_monitor_fixture \
    durable-v2 "$operation_owner" || return 1
  case "$fixture_mutation" in
    contract-tamper) printf ' ' >>"$WRITER_TEST_CONTRACT" ;;
    contract-symlink)
      cp "$WRITER_TEST_CONTRACT" "$WRITER_TEST_DIR/contract-target.json"
      rm "$WRITER_TEST_CONTRACT"
      ln -s "$WRITER_TEST_DIR/contract-target.json" "$WRITER_TEST_CONTRACT"
      ;;
    baseline-initial) printf 'tampered\n' >"$WRITER_TEST_BASELINE" ;;
    baseline-symlink)
      rm "$WRITER_TEST_BASELINE"
      ln -s "$WRITER_TEST_CONTRACT" "$WRITER_TEST_BASELINE"
      ;;
    ready-initial) printf 'tampered\n' >"$WRITER_TEST_READY" ;;
    progress-initial) printf '1\n' >"$WRITER_TEST_PROGRESS" ;;
    progress-symlink)
      rm "$WRITER_TEST_PROGRESS"
      ln -s "$WRITER_TEST_CONTRACT" "$WRITER_TEST_PROGRESS"
      ;;
    progress-next) printf 'decoy\n' >"${WRITER_TEST_PROGRESS}.next" ;;
    stop-initial) printf 'tampered\n' >"$WRITER_TEST_STOP" ;;
    failure-initial) printf 'tampered\n' >"$WRITER_TEST_FAILURE" ;;
    final-initial) printf 'tampered\n' >"$WRITER_TEST_FINAL" ;;
    final-symlink)
      rm "$WRITER_TEST_FINAL"
      ln -s "$WRITER_TEST_CONTRACT" "$WRITER_TEST_FINAL"
      ;;
    stale-lease)
      jq '.spec.renewTime = "2020-01-01T00:00:00.000000Z" |
        .spec.acquireTime = "2020-01-01T00:00:00.000000Z"' \
        "$STUB_STATE_DIR/serialization-lease.json" \
        >"$STUB_STATE_DIR/serialization-lease.next"
      mv "$STUB_STATE_DIR/serialization-lease.next" \
        "$STUB_STATE_DIR/serialization-lease.json"
      ;;
    "") ;;
    *) return 2 ;;
  esac
  start_checkpoint_writer_test_monitor "$mode"
  # A deliberately non-empty ready marker is itself one rejection fixture, so
  # it cannot be used as the generic handoff signal in this negative helper.
  # Wait for the failure marker or process exit instead of racing the watcher
  # and terminating it before its fail-closed marker write completes.
  for _ in {1..1100}; do
    [[ -s "$WRITER_TEST_FAILURE" ]] && break
    kill -0 "$WRITER_TEST_PID" 2>/dev/null || break
    sleep 0.01
  done
  if kill -0 "$WRITER_TEST_PID" 2>/dev/null &&
     [[ ! -s "$WRITER_TEST_FAILURE" ]]; then
    kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
  fi
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" != 0 &&
     "$(cat "$WRITER_TEST_FAILURE" 2>/dev/null || :)" == \
       checkpoint_writer_monitor_failed ]]
}

run_checkpoint_writer_baseline_tamper_test() {
  local ready baseline_sha monitor_status=0
  prepare_checkpoint_writer_monitor_fixture || return 1
  start_checkpoint_writer_test_monitor ""
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  [[ "$ready" =~ ^ready:([a-f0-9]{64}):[a-f0-9]{64}$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  printf ' ' >>"$WRITER_TEST_BASELINE"
  if checkpoint_writer_boundary "$baseline_sha" >/dev/null 2>&1; then return 1; fi
  printf 'discard\n' >"$WRITER_TEST_STOP"
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" == 0 && ! -s "$WRITER_TEST_FAILURE" &&
     ! -s "$WRITER_TEST_FINAL" ]]
}

run_checkpoint_writer_invalid_generation_test() {
  prepare_checkpoint_writer_monitor_fixture durable-v2 || return 1
  WRITER_TEST_COMMON_ARGS[29]=invalid-generation
  : >"$KUBECTL_LOG"
  if env KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
      YENHUBS_RECOVERY_TEST_MODE=local-fixture \
      RECOVERY_TEST_STABLE_ABSENCE_SECONDS=0 \
      node "$ROOT_DIR/deployment/watch-checkpoint-writers.mjs" monitor \
        "${WRITER_TEST_COMMON_ARGS[@]}" \
        --stop "$WRITER_TEST_STOP" --failure "$WRITER_TEST_FAILURE" \
        --ready "$WRITER_TEST_READY" --progress "$WRITER_TEST_PROGRESS" \
        --final "$WRITER_TEST_FINAL" \
        --authority "${WRITER_TEST_READY}.authority.json" >/dev/null 2>&1; then
    return 1
  fi
  [[ ! -s "$KUBECTL_LOG" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-policy-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-binding-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-queried" ]]
}

run_checkpoint_writer_operation_owner_mismatch_test() {
  local monitor_status=0 _
  prepare_checkpoint_writer_monitor_fixture durable-v2 checkpoint-backup || return 1
  WRITER_TEST_COMMON_ARGS[19]='checkpoint-restore'
  start_checkpoint_writer_test_monitor ""
  for _ in {1..1100}; do
    [[ -s "$WRITER_TEST_FAILURE" ]] && break
    kill -0 "$WRITER_TEST_PID" 2>/dev/null || break
    sleep 0.01
  done
  if kill -0 "$WRITER_TEST_PID" 2>/dev/null &&
     [[ ! -s "$WRITER_TEST_FAILURE" ]]; then
    kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
  fi
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" != 0 &&
     "$(cat "$WRITER_TEST_FAILURE" 2>/dev/null || :)" == \
       checkpoint_writer_monitor_failed && ! -s "$WRITER_TEST_READY" ]]
}

run_checkpoint_writer_generation_mismatch_boundary_test() {
  local ready baseline_sha monitor_status=0
  prepare_checkpoint_writer_monitor_fixture durable-v2 || return 1
  start_checkpoint_writer_test_monitor ""
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  [[ "$ready" =~ ^ready:([a-f0-9]{64}):[a-f0-9]{64}$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  printf 'discard\n' >"$WRITER_TEST_STOP"
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" == 0 ]] || return 1
  WRITER_TEST_COMMON_ARGS[29]=legacy-absent
  rm -f -- "$STUB_STATE_DIR/recovery-operation-fence-policy-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-queried"
  if checkpoint_writer_boundary "$baseline_sha" >/dev/null 2>&1; then return 1; fi
  [[ ! -e "$STUB_STATE_DIR/recovery-operation-fence-policy-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-binding-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-queried" ]]
}

run_checkpoint_writer_signed_capability_mismatch_test() {
  local mismatch="$1" ready baseline_sha monitor_status=0
  prepare_checkpoint_writer_monitor_fixture durable-v2 || return 1
  start_checkpoint_writer_test_monitor ""
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  [[ "$ready" =~ ^ready:([a-f0-9]{64}):[a-f0-9]{64}$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  printf 'discard\n' >"$WRITER_TEST_STOP"
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" == 0 ]] || return 1
  case "$mismatch" in
    context) WRITER_TEST_COMMON_ARGS[1]=other-context ;;
    lease-name) WRITER_TEST_COMMON_ARGS[23]=other-lease ;;
    operation-id) WRITER_TEST_COMMON_ARGS[21]=99999999999999999999999999999999 ;;
    operation-lock-rv) WRITER_TEST_COMMON_ARGS[17]=lock-rv-2 ;;
    *) return 2 ;;
  esac
  rm -f -- "$STUB_STATE_DIR/recovery-operation-fence-policy-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-binding-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-queried" \
    "$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-queried"
  if checkpoint_writer_boundary "$baseline_sha" >/dev/null 2>&1; then return 1; fi
  [[ ! -e "$STUB_STATE_DIR/recovery-operation-fence-policy-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-binding-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-queried" &&
     ! -e "$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-queried" ]]
}

run_checkpoint_writer_fence_second_boundary_read_test() {
  local ready baseline_sha monitor_status=0 mode
  mode='checkpoint-writer-fence-policy-drift-second-boundary-read'
  prepare_checkpoint_writer_monitor_fixture durable-v2 || return 1
  start_checkpoint_writer_test_monitor ""
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  [[ "$ready" =~ ^ready:([a-f0-9]{64}):[a-f0-9]{64}$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  printf 'discard\n' >"$WRITER_TEST_STOP"
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" == 0 ]] || return 1
  rm -f -- "$STUB_STATE_DIR/recovery-operation-fence-policy-count-$mode"
  if checkpoint_writer_boundary "$baseline_sha" "$mode" >/dev/null 2>&1; then
    return 1
  fi
  [[ "$(cat "$STUB_STATE_DIR/recovery-operation-fence-policy-count-$mode" \
       2>/dev/null || :)" == 2 ]]
}

run_checkpoint_writer_fence_timed_failure() {
  local mode="$1" started_at="$SECONDS"
  run_checkpoint_writer_monitor_failure "$mode" || return 1
  ((SECONDS - started_at <= 10))
}

run_checkpoint_writer_exit_143_descendant_test() {
  local ready baseline_sha authority_path authority_sha
  local original_monitor_status=0 watcher_pid watcher_identity=""
  local descendant_pid=""
  local descendant_pid_path descendant_state="" stop_status=0 checkpoint_joined=0
  local started_at stop_elapsed=0
  prepare_checkpoint_writer_monitor_fixture || return 1
  NAMESPACE=hcce
  EXPECTED_KUBE_CONTEXT=fixture-context
  EXPECTED_NAMESPACE_UID=fixture-uid
  EXPECTED_RET_PVC_UID=fixture-pvc-uid
  export NAMESPACE EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID \
    EXPECTED_RET_PVC_UID
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  RECOVERY_NAMESPACE_UID=fixture-uid
  RECOVERY_PVC_UID=fixture-pvc-uid
  RECOVERY_CHECKPOINT_STAMP="$STAMP"
  RECOVERY_DUMP_SHA256="$DUMP_SHA"
  RECOVERY_STORAGE_SHA256="$STORAGE_SHA"
  KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer"
  export KUBECTL_BIN
  recovery_adopt_parent_operation_serialization \
    "$YENHUBS_PARENT_LEASE_HOLDER" "$YENHUBS_PARENT_LEASE_UID" \
    "$YENHUBS_PARENT_PROCESS_PID" \
    "$YENHUBS_PARENT_PROCESS_START_IDENTITY" || return 1
  start_checkpoint_writer_test_monitor ""
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  [[ "$ready" =~ ^ready:([a-f0-9]{64}):[a-f0-9]{64}$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  [[ "$(sha256_digest "$WRITER_TEST_BASELINE")" == "$baseline_sha" ]] || return 1

  # Retire the real fixture watcher after it has produced an exact baseline,
  # then replace only its process capability with a deliberately failing
  # isolated leader whose descendant ignores TERM.
  printf 'discard\n' >"$WRITER_TEST_STOP"
  if wait "$WRITER_TEST_PID"; then
    original_monitor_status=0
  else
    original_monitor_status=$?
  fi
  [[ "$original_monitor_status" == 0 ]] || return 1
  : >"$WRITER_TEST_STOP"
  : >"$WRITER_TEST_FINAL"
  descendant_pid_path="$WRITER_TEST_DIR/descendant-pid"
  python3 -I -c '
import os
import signal
import sys
import time

stop_path, descendant_path = sys.argv[1:]
os.setsid()
child = os.fork()
if child == 0:
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with open(descendant_path, "w", encoding="ascii") as handle:
        handle.write(str(os.getpid()))
        handle.flush()
        os.fsync(handle.fileno())
    while True:
        time.sleep(1)
while True:
    try:
        if os.path.getsize(stop_path) > 0:
            break
    except FileNotFoundError:
        pass
    time.sleep(0.005)
os._exit(143)
' "$WRITER_TEST_STOP" "$descendant_pid_path" \
    </dev/null >/dev/null 2>&1 &
  watcher_pid=$!
  watcher_identity="$(recovery_process_start_identity "$watcher_pid")" || {
    recovery_stop_process_group "$watcher_pid"
    return 1
  }
  # The replacement process is a new capability. Re-sign the otherwise exact
  # fixture authority and its READY/progress tokens so the stop path reaches
  # the bounded join instead of correctly rejecting the retired PID first.
  authority_path="${WRITER_TEST_READY}.authority.json"
  if ! jq -c --argjson pid "$watcher_pid" \
      --arg start_identity "$watcher_identity" \
      '.pid = $pid | .start_identity = $start_identity' \
      "$authority_path" >"$authority_path.next"; then
    recovery_stop_process_group "$watcher_pid" "$watcher_identity" || :
    return 1
  fi
  chmod 600 "$authority_path.next" || {
    recovery_stop_process_group "$watcher_pid" "$watcher_identity" || :
    return 1
  }
  mv "$authority_path.next" "$authority_path" || {
    recovery_stop_process_group "$watcher_pid" "$watcher_identity" || :
    return 1
  }
  authority_sha="$(sha256_digest "$authority_path")" || {
    recovery_stop_process_group "$watcher_pid" "$watcher_identity" || :
    return 1
  }
  printf 'ready:%s:%s\n' "$baseline_sha" "$authority_sha" \
    >"$WRITER_TEST_READY"
  printf '%s:1\n' "$authority_sha" >"$WRITER_TEST_PROGRESS"
  for _ in {1..300}; do
    [[ -s "$descendant_pid_path" ]] && break
    kill -0 "$watcher_pid" 2>/dev/null || break
    sleep 0.01
  done
  descendant_pid="$(cat "$descendant_pid_path" 2>/dev/null || :)"
  if [[ ! "$descendant_pid" =~ ^[1-9][0-9]*$ ]]; then
    recovery_stop_process_group "$watcher_pid" "$watcher_identity"
    return 1
  fi

  started_at="$SECONDS"
  if RECOVERY_TEST_WATCHER_JOIN_TIMEOUT_SECONDS=1 \
      recovery_stop_checkpoint_writer_monitor \
        "$WRITER_TEST_CONTRACT" "$WRITER_TEST_CONTRACT_SHA" \
        "$WRITER_TEST_BASELINE" "$baseline_sha" \
        "$WRITER_TEST_STOP" "$WRITER_TEST_FAILURE" \
        "$WRITER_TEST_READY" "$WRITER_TEST_FINAL" \
        "$watcher_pid" "$watcher_identity" checkpoint_joined durable-v2 \
        checkpoint-backup; then
    stop_status=0
  else
    stop_status=$?
  fi
  stop_elapsed=$((SECONDS - started_at))
  for _ in {1..300}; do
    descendant_state="$(ps -o stat= -p "$descendant_pid" 2>/dev/null |
      awk '{$1=$1; print}' || :)"
    [[ -n "$descendant_state" && "$descendant_state" != Z* ]] || break
    sleep 0.01
  done
  if [[ "$stop_status" != 0 && "$checkpoint_joined" == failed &&
        "$stop_elapsed" -le 10 &&
        -e "$STUB_STATE_DIR/restore-lock.yaml" &&
        ( -z "$descendant_state" || "$descendant_state" == Z* ) ]] &&
     ! kill -0 -- "-$watcher_pid" 2>/dev/null; then
    return 0
  fi
  printf 'exit-143 diagnostics: status=%s joined=%s stop_elapsed=%s total_elapsed=%s descendant=%s lock=%s group=%s\n' \
    "$stop_status" "$checkpoint_joined" "$stop_elapsed" \
    "$((SECONDS - started_at))" \
    "${descendant_state:-absent}" \
    "$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)" \
    "$(kill -0 -- "-$watcher_pid" 2>/dev/null && printf present || printf absent)" >&2
  return 1
}

run_checkpoint_resume_fixture() {
  local runner_mode="$1" stub_mode="$2" output="$3"
  local values deployments runner_namespace runner_profile
  case "$runner_mode" in
    durable)
      values="$VALUES_FIXTURE"
      deployments="$KUBERNETES_DEPLOYMENTS_JSON"
      runner_namespace=present
      runner_profile=fence-stable
      # Direct monitor tests intentionally use the active binding fixture, but
      # every durable checkpoint must model the real dormant starting state.
      seed_recovery_operation_fence_binding_state dormant || return 1
      ;;
    legacy)
      values="$VALUES_PROCESS_LOCAL_FIXTURE"
      deployments="$LEGACY_DEPLOYMENTS_JSON"
      runner_namespace=''
      runner_profile=''
      ;;
    *) return 2 ;;
  esac
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$values" STUB_DEPLOYMENTS_JSON="$deployments" \
    STUB_RUNNER_NAMESPACE="$runner_namespace" \
    STUB_RUNNER_POD_PROFILE="$runner_profile" \
    KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" STUB_MODE="$stub_mode" \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"
}

checkpoint_all_writers_at() {
  local expected="$1" writer effective
  for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ -f "$STUB_STATE_DIR/replicas-$writer" ]]; then
      effective="$(cat "$STUB_STATE_DIR/replicas-$writer")"
    else
      effective="$(jq -er --arg name "$writer" '
        [.items[] | select(.metadata.name == $name)] |
        select(length == 1) | .[0].spec.replicas
      ' "$STUB_DEPLOYMENTS_JSON")" || return 1
    fi
    [[ "$effective" == "$expected" ]] || return 1
  done
}

checkpoint_resume_receipts_absent() {
  [[ -z "$(find "$STUB_STATE_DIR" -maxdepth 1 -type f \
    -name 'checkpoint-resume-receipt-*' -print -quit)" ]]
}

checkpoint_all_writer_rollouts_observed() {
  local writer
  for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    grep -q "rollout status deployment/$writer -n hcce" "$KUBECTL_LOG" || return 1
  done
}

checkpoint_output_is_valid() {
  local output="$1" stamp
  stamp="$(jq -er '.stamp' "$output/checkpoint-metadata.json" 2>/dev/null)" || return 1
  bash -c 'source "$1"; recovery_verify_checkpoint_directory "$2" "$3"' \
    _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$output" "$stamp"
}

run_checkpoint_writer_additional_tests() {
  local quiesce_mode output exact_rollback writer
  local total_cleanup_count bot_cleanup_count

  expect_success 'checkpoint writer exit 143 revokes its descendant group and records failed join' \
    run_checkpoint_writer_exit_143_descendant_test

  for quiesce_mode in checkpoint-quiesce-bot-lost-response \
    checkpoint-quiesce-reticulum-lost-response; do
    reset_stub
    output="$TMP_DIR/$quiesce_mode"
    expect_failure "$quiesce_mode preserves the original scale-down error after exact rollback" '' \
      run_checkpoint_resume_fixture durable "$quiesce_mode" "$output"
    exact_rollback=true
    if [[ "$quiesce_mode" == checkpoint-quiesce-bot-lost-response ]]; then
      [[ -e "$STUB_STATE_DIR/checkpoint-quiesce-bot-lost-response" ]] || \
        exact_rollback=false
      [[ "$(deployment_patch_count bot-orchestrator 0)" == 1 &&
         "$(deployment_patch_count bot-orchestrator 1)" == 1 &&
         "$(deployment_resume_receipt_cleanup_count bot-orchestrator)" == 1 ]] || \
        exact_rollback=false
      for writer in reticulum pgbouncer pgbouncer-t coturn; do
        [[ "$(deployment_patch_count "$writer" 0)" == 0 &&
           "$(deployment_patch_count "$writer" 1)" == 0 &&
           "$(deployment_resume_receipt_cleanup_count "$writer")" == 0 ]] || \
          exact_rollback=false
      done
    else
      [[ -e "$STUB_STATE_DIR/checkpoint-quiesce-reticulum-lost-response" ]] || \
        exact_rollback=false
      for writer in bot-orchestrator reticulum; do
        [[ "$(deployment_patch_count "$writer" 0)" == 1 &&
           "$(deployment_patch_count "$writer" 1)" == 1 &&
           "$(deployment_resume_receipt_cleanup_count "$writer")" == 1 ]] || \
          exact_rollback=false
      done
      for writer in pgbouncer pgbouncer-t coturn; do
        [[ "$(deployment_patch_count "$writer" 0)" == 0 &&
           "$(deployment_patch_count "$writer" 1)" == 0 &&
           "$(deployment_resume_receipt_cleanup_count "$writer")" == 0 ]] || \
          exact_rollback=false
      done
    fi
    if { [[ "$exact_rollback" == true ]] && checkpoint_all_writers_at 1 &&
         [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; } ||
       { [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
         [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]] &&
         [[ "$(deployment_patch_count reticulum 1)" == 0 ]] &&
         [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
         if [[ "$quiesce_mode" == checkpoint-quiesce-bot-lost-response ]]; then
           [[ "$(deployment_patch_count bot-orchestrator 0)" == 1 &&
              "$(deployment_patch_count reticulum 0)" == 0 ]]
         else
           [[ "$(cat "$STUB_STATE_DIR/replicas-reticulum" 2>/dev/null || :)" == 0 &&
              "$(deployment_patch_count bot-orchestrator 0)" == 1 &&
              "$(deployment_patch_count reticulum 0)" == 1 ]]
         fi; }; then
      if checkpoint_resume_receipts_absent && [[ ! -e "$output" ]] &&
         ! find "$STUB_STATE_DIR" -maxdepth 1 -type d -name 'writer-watch-*' \
           -print -quit | grep -q .; then
        pass "$quiesce_mode reaches exact rollback or retains only committed zero transitions fail-closed"
      else
        fail "$quiesce_mode exact pre-monitor terminal artifacts" \
          'unexpected receipt, output, or writer monitor exists'
      fi
    else
      fail "$quiesce_mode exact pre-monitor rollback contract" \
        "states=$(for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do printf '%s=%s ' "$writer" "$(cat "$STUB_STATE_DIR/replicas-$writer" 2>/dev/null || printf missing)"; done) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) patches=$(grep 'patch deployment ' "$KUBECTL_LOG" || :)"
    fi
  done

  reset_stub
  output="$TMP_DIR/checkpoint-writer-post-join-transient"
  expect_failure 'post-join transient preserves the original checkpoint error after FINAL adoption' '' \
    run_checkpoint_resume_fixture durable checkpoint-writer-post-join-transient "$output"
  if [[ -e "$STUB_STATE_DIR/checkpoint-writer-terminal-watch-seen" &&
        -e "$STUB_STATE_DIR/checkpoint-writer-post-join-transient" &&
        ! -e "$STUB_STATE_DIR/checkpoint-writer-post-join-rewait" ]] &&
     checkpoint_resume_receipts_absent && [[ ! -e "$output" ]] &&
     { { checkpoint_all_writers_at 1 && checkpoint_all_writer_rollouts_observed &&
         [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; } ||
       { checkpoint_all_writers_at 0 &&
         [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
         [[ "$(for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
           deployment_patch_count "$writer" 1
         done | awk '{sum += $1} END {print sum + 0}')" == 0 ]]; }; }; then
    pass 'joined FINAL is adopted once or retained fail-closed without stale PID re-wait'
  else
    fail 'post-join FINAL reentry contract' \
      "terminal=$([[ -e "$STUB_STATE_DIR/checkpoint-writer-terminal-watch-seen" ]] && printf seen || printf missing) transient=$([[ -e "$STUB_STATE_DIR/checkpoint-writer-post-join-transient" ]] && printf seen || printf missing) rewait=$([[ -e "$STUB_STATE_DIR/checkpoint-writer-post-join-rewait" ]] && printf seen || printf absent) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
  fi

  reset_stub
  output="$TMP_DIR/checkpoint-resume-cleanup-lost-response"
  expect_success 'lost receipt-cleanup response reconciles exact absence and completes checkpoint' \
    run_checkpoint_resume_fixture durable checkpoint-resume-cleanup-lost-response "$output"
  total_cleanup_count="$(grep -Ec \
    'patch deployment .*"op":"remove","path":"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"' \
    "$KUBECTL_LOG" || :)"
  bot_cleanup_count="$(deployment_resume_receipt_cleanup_count bot-orchestrator)"
  if [[ "$(cat "$STUB_STATE_DIR/checkpoint-resume-cleanup-lost-response" \
          2>/dev/null || :)" == bot-orchestrator &&
        "$total_cleanup_count" == 5 && "$bot_cleanup_count" == 1 ]] &&
     checkpoint_all_writers_at 1 && checkpoint_all_writer_rollouts_observed &&
     checkpoint_resume_receipts_absent && [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     checkpoint_output_is_valid "$output"; then
    pass 'bot cleanup lost-response reconciles exact absence without retrying its cleanup CAS'
  else
    fail 'receipt cleanup lost-response reconciliation left durable residue' \
      "cleanup-target=$(cat "$STUB_STATE_DIR/checkpoint-resume-cleanup-lost-response" 2>/dev/null || printf missing) total-cleanups=$total_cleanup_count bot-cleanups=$bot_cleanup_count lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) receipts=$(find "$STUB_STATE_DIR" -maxdepth 1 -type f -name 'checkpoint-resume-receipt-*' -print | paste -sd, -)"
  fi
}

run_checkpoint_writer_spawn_gate_test() (
  local mode="$1" test_dir fake_bin contract contract_sha baseline
  local stop_path failure_path ready_path progress_path final_path
  local node_exec_marker descendant_path watcher_pid="" watcher_identity=""
  local baseline_sha="" descendant_pid="" descendant_state="" start_status=0
  test_dir="$(mktemp -d "$TMP_DIR/checkpoint-writer-spawn-gate.XXXXXX")" ||
    return 1
  chmod 700 "$test_dir" || return 1
  fake_bin="$test_dir/bin"
  mkdir -p "$fake_bin"
  chmod 700 "$fake_bin"
  contract="$test_dir/consumer-contract.json"
  # shellcheck disable=SC2030 # This fixture intentionally stays inside its subshell.
  baseline="$test_dir/baseline.json"
  stop_path="$test_dir/stop"
  failure_path="$test_dir/failure"
  ready_path="$test_dir/ready"
  progress_path="$test_dir/progress"
  final_path="$test_dir/final"
  node_exec_marker="$test_dir/node-exec"
  descendant_path="$test_dir/descendant-pid"
  printf '%s\n' '{"consumers":[]}' >"$contract"
  : >"$baseline"
  : >"$stop_path"
  : >"$failure_path"
  : >"$ready_path"
  : >"$progress_path"
  : >"$final_path"
  chmod 600 "$contract" "$baseline" "$stop_path" "$failure_path" \
    "$ready_path" "$progress_path" "$final_path"
  cat >"$fake_bin/node" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'executed\n' >"$NODE_EXEC_MARKER"
if [[ "$WRITER_GATE_TEST_MODE" == pre-ready-exit ]]; then
  (
    trap '' TERM INT
    while :; do sleep 1; done
  ) &
  printf '%s\n' "$!" >"$WRITER_GATE_DESCENDANT_PATH"
fi
exit 23
STUB
  chmod 700 "$fake_bin/node"
  export NODE_EXEC_MARKER="$node_exec_marker"
  export WRITER_GATE_TEST_MODE="$mode"
  export WRITER_GATE_DESCENDANT_PATH="$descendant_path"
  # shellcheck disable=SC2030 # The PATH override is intentionally scoped to this fixture subshell.
  PATH="$fake_bin:$PATH"
  export PATH
  NAMESPACE=hcce
  EXPECTED_KUBE_CONTEXT=fixture-context
  # shellcheck disable=SC2030 # This fixture intentionally stays inside its subshell.
  EXPECTED_NAMESPACE_UID=fixture-uid
  # shellcheck disable=SC2030 # This fixture intentionally stays inside its subshell.
  EXPECTED_RET_PVC_UID=fixture-pvc-uid
  export NAMESPACE EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID \
    EXPECTED_RET_PVC_UID
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  RECOVERY_NAMESPACE_UID=fixture-uid
  RECOVERY_OPERATION_ID=88888888888888888888888888888888
  RECOVERY_OPERATION_LOCK_NAME="$RECOVERY_OPERATION_LOCK_GLOBAL_NAME"
  RECOVERY_OPERATION_LOCK_UID=fixture-lock-uid
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=fixture-lock-rv
  RECOVERY_OPERATION_OWNER='checkpoint-backup'
  RECOVERY_SERIALIZATION_LEASE_NAME=yenhubs-operation-serialization
  RECOVERY_SERIALIZATION_LEASE_UID=fixture-lease-uid
  RECOVERY_SERIALIZATION_LEASE_HOLDER='root-recovery:fixture'
  recovery_require_operation_serialization() { return 0; }
  recovery_require_operation_lock() { return 0; }
  recovery_checkpoint_writer_monitor_kubectl_bin() { printf '/bin/true\n'; }
  if [[ "$mode" == identity-failure ]]; then
    recovery_process_start_identity() { return 1; }
  fi
  contract_sha="$(recovery_sha256_digest "$contract")" || return 1
  if recovery_start_checkpoint_writer_monitor \
      "$contract" "$contract_sha" "$baseline" "$stop_path" "$failure_path" \
      "$ready_path" "$progress_path" "$final_path" watcher_pid watcher_identity \
      baseline_sha durable-v2 checkpoint-backup; then
    start_status=0
  else
    start_status=$?
  fi
  [[ "$start_status" != 0 && -z "$watcher_pid" &&
     -z "$watcher_identity" && -z "$baseline_sha" ]] || return 1
  if find "$test_dir" -maxdepth 1 -name '.checkpoint-writer-spawn-gate.*' \
      -print -quit | grep -q .; then
    return 1
  fi
  if [[ "$mode" == identity-failure ]]; then
    [[ ! -e "$node_exec_marker" && ! -e "$descendant_path" ]]
    return
  fi
  [[ -s "$node_exec_marker" && -s "$descendant_path" ]] || return 1
  descendant_pid="$(cat "$descendant_path")"
  [[ "$descendant_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  for _ in {1..400}; do
    descendant_state="$(ps -o stat= -p "$descendant_pid" 2>/dev/null |
      awk '{$1=$1; print}' || :)"
    [[ -n "$descendant_state" && "$descendant_state" != Z* ]] || break
    sleep 0.01
  done
  [[ -z "$descendant_state" || "$descendant_state" == Z* ]]
)

run_runner_false_health_identity_test() (
  local actual_identity failure_path ready_path
  NAMESPACE=hcce
  EXPECTED_KUBE_CONTEXT=fixture-context
  export NAMESPACE EXPECTED_KUBE_CONTEXT
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-false-health-failure.XXXXXX")"
  ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-false-health-ready.XXXXXX")"
  chmod 600 "$failure_path" "$ready_path"
  # shellcheck disable=SC2317,SC2329 # Invoked indirectly by the EXIT trap.
  cleanup_runner_false_health_markers() {
    rm -f -- "$failure_path" "$ready_path"
  }
  trap cleanup_runner_false_health_markers EXIT
  printf 'ready\n' >"$ready_path"
  actual_identity="$(recovery_process_start_identity "$$")" || return 1
  [[ -n "$actual_identity" ]] || return 1
  if recovery_require_no_managed_bot_runner_watch_healthy \
      "$failure_path" "$ready_path" "$$" "$actual_identity false"; then
    return 1
  fi
  [[ ! -s "$failure_path" ]]
)

run_runner_false_identity_no_signal_test() (
  local stop_path failure_path ready_path leader_ready signal_path
  local leader_pid="" leader_identity="" false_identity started_at
  NAMESPACE=hcce
  EXPECTED_KUBE_CONTEXT=fixture-context
  export NAMESPACE EXPECTED_KUBE_CONTEXT
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-false-stop.XXXXXX")"
  failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-false-failure.XXXXXX")"
  ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-false-ready.XXXXXX")"
  leader_ready="$(mktemp "${TMPDIR:-/tmp}/runner-false-leader-ready.XXXXXX")"
  signal_path="$(mktemp "${TMPDIR:-/tmp}/runner-false-signal.XXXXXX")"
  chmod 600 "$stop_path" "$failure_path" "$ready_path" \
    "$leader_ready" "$signal_path"
  # shellcheck disable=SC2317,SC2329 # Invoked indirectly by the EXIT trap.
  cleanup_runner_false_identity_group() {
    if [[ "$leader_pid" =~ ^[1-9][0-9]*$ ]]; then
      if [[ -n "$leader_identity" ]] &&
         recovery_process_identity_is_live "$leader_pid" "$leader_identity"; then
        recovery_stop_process_group "$leader_pid" "$leader_identity" || :
      elif kill -0 "$leader_pid" 2>/dev/null; then
        kill -KILL "$leader_pid" 2>/dev/null || :
        wait "$leader_pid" 2>/dev/null || :
      fi
    fi
    rm -f -- "$stop_path" "$failure_path" "$ready_path" \
      "$leader_ready" "$signal_path"
  }
  trap cleanup_runner_false_identity_group EXIT
  printf 'ready\n' >"$ready_path"
  python3 -I -c '
import os
import signal
import sys
import time

ready_path, signal_path = sys.argv[1:]
os.setsid()

def record_signal(signum, _frame):
    with open(signal_path, "a", encoding="ascii") as handle:
        handle.write(str(signum) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    raise SystemExit(0)

signal.signal(signal.SIGINT, record_signal)
signal.signal(signal.SIGTERM, record_signal)
with open(ready_path, "w", encoding="ascii") as handle:
    handle.write("ready\n")
    handle.flush()
    os.fsync(handle.fileno())
while True:
    time.sleep(1)
' "$leader_ready" "$signal_path" </dev/null >/dev/null 2>&1 &
  leader_pid=$!
  for _ in {1..300}; do
    [[ -s "$leader_ready" ]] && break
    kill -0 "$leader_pid" 2>/dev/null || break
    sleep 0.01
  done
  [[ -s "$leader_ready" ]] || return 1
  leader_identity="$(recovery_process_start_identity "$leader_pid")" || return 1
  [[ -n "$leader_identity" ]] || return 1
  false_identity="$leader_identity false"
  started_at="$SECONDS"
  if recovery_stop_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" \
      "$leader_pid" "$false_identity"; then
    return 1
  fi
  recovery_discard_no_managed_bot_runner_watch \
    "$stop_path" "$leader_pid" "$false_identity"
  recovery_discard_checkpoint_writer_monitor \
    "$stop_path" "$leader_pid" "$false_identity"
  [[ "$((SECONDS - started_at))" -le 2 ]] || return 1
  [[ ! -s "$stop_path" && ! -s "$signal_path" ]] || return 1
  recovery_process_identity_is_live "$leader_pid" "$leader_identity" || return 1
  kill -0 -- "-$leader_pid" 2>/dev/null
)

run_runner_identity_handshake_test() (
  local stop_path failure_path ready_path watcher_pid="" watcher_identity=""
  NAMESPACE=hcce
  EXPECTED_KUBE_CONTEXT=fixture-context
  EXPECTED_NAMESPACE_UID=fixture-uid
  EXPECTED_RET_PVC_UID=fixture-pvc-uid
  # shellcheck disable=SC2030 # Set and consumed inside this test subshell.
  RECOVERY_TEST_STABLE_ABSENCE_SECONDS=1
  export NAMESPACE EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID \
    EXPECTED_RET_PVC_UID RECOVERY_TEST_STABLE_ABSENCE_SECONDS
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  stop_path="$(mktemp "${TMPDIR:-/tmp}/runner-monitor-stop.XXXXXX")"
  failure_path="$(mktemp "${TMPDIR:-/tmp}/runner-monitor-failure.XXXXXX")"
  ready_path="$(mktemp "${TMPDIR:-/tmp}/runner-monitor-ready.XXXXXX")"
  chmod 600 "$stop_path" "$failure_path" "$ready_path"
  # shellcheck disable=SC2317,SC2329 # Invoked indirectly by the EXIT trap.
  cleanup_runner_identity_handshake() {
    if [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" ]]; then
      recovery_discard_no_managed_bot_runner_watch \
        "$stop_path" "$watcher_pid" "$watcher_identity"
    fi
    rm -f -- "$stop_path" "$failure_path" "$ready_path"
  }
  trap cleanup_runner_identity_handshake EXIT
  recovery_start_no_managed_bot_runner_watch \
    "$stop_path" "$failure_path" "$ready_path" \
    watcher_pid watcher_identity || return 1
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" ]] || return 1
  recovery_require_no_managed_bot_runner_watch_healthy \
    "$failure_path" "$ready_path" "$watcher_pid" "$watcher_identity" || return 1
  recovery_stop_no_managed_bot_runner_watch \
    "$stop_path" "$failure_path" "$ready_path" \
    "$watcher_pid" "$watcher_identity"
)

run_runner_identity_tests() {
  reset_stub
  expect_success 'runner watcher health rejects a false spawn identity' \
    run_runner_false_health_identity_test
  reset_stub
  expect_success 'runner and writer watcher cleanup ignore a false identity without signalling its live group' \
    run_runner_false_identity_no_signal_test
  reset_stub
  expect_success 'managed bot-runner watcher returns an identity and completes ready/stop handshake' \
    run_runner_identity_handshake_test
  if grep -Fq -- 'get --raw /api/v1/namespaces/hcce/pods' "$KUBECTL_LOG"; then
    pass 'managed bot-runner watcher starts from the typed PodList endpoint'
  else
    fail 'managed bot-runner watcher starts from the typed PodList endpoint' \
      "$(cat "$KUBECTL_LOG")"
  fi
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
}

run_checkpoint_writer_terminal_handoff_tests() {
  expect_success 'terminal writer handoff keeps causal watch coverage through LIST and control-plane postconditions' \
    run_checkpoint_writer_monitor_success checkpoint-writer-terminal-live
  expect_success 'terminal writer handoff rejects an excursion after W1 expires inside a slow LIST' \
    run_checkpoint_writer_terminal_gap_failure checkpoint-writer-terminal-list-gap
  expect_success 'terminal writer handoff W2 catches an excursion while slow control-plane reads block Node' \
    run_checkpoint_writer_terminal_gap_failure checkpoint-writer-terminal-control-gap
}

run_legacy_receipt_watcher_tests() {
  local mode trace expected_phase

  if [[ "${YENHUBS_RECOVERY_TEST_CASE:-}" == shell-happy ]]; then
    return
  fi
  if [[ "${YENHUBS_RECOVERY_TEST_CASE:-}" == w1-replicaset ]]; then
    trace="$TMP_DIR/legacy-receipt-w1-replicaset.trace"
    expect_success 'receipt W1 ReplicaSet successor replays a transient hidden by the terminal LIST' \
      run_legacy_receipt_monitor_handoff_case \
        legacy-receipt-w1-replicaset arm-failure "$trace"
    if trace_phases_are_ordered "$trace" ARM RS_W1_CLOSE RS_EXCURSION \
        RS_LIST_BOUNDARY RS_SUCCESSOR_REPLAY; then
      pass 'ReplicaSet replay is causally W1-close then excursion then LIST boundary then successor'
    else
      fail 'ReplicaSet receipt replay phase order' "$(cat "$trace" 2>/dev/null || :)"
    fi
    return
  fi
  if [[ "${YENHUBS_RECOVERY_TEST_CASE:-}" == happy ]]; then
    trace="$TMP_DIR/legacy-receipt-happy.trace"
    expect_success 'receipt handoff keeps three H watches through one natural post-request R generation' \
      run_legacy_receipt_monitor_handoff_case \
        legacy-receipt-happy success "$trace"
    if trace_phases_are_ordered "$trace" ARM PATCH_RECEIPT COMMIT H_LIVE_ALL \
        R_START_deployments R_NATURAL_deployments ACK \
        H_TERM_AFTER_ACK_deployments; then
      pass 'healthy receipt H-to-R phase order'
    else
      fail 'healthy receipt H-to-R phase order' "$(cat "$trace" 2>/dev/null || :)"
    fi
    return
  fi

  trace="$TMP_DIR/legacy-receipt-w1-replicaset.trace"
  expect_success 'receipt W1 ReplicaSet successor replays a transient hidden by the terminal LIST' \
    run_legacy_receipt_monitor_handoff_case \
      legacy-receipt-w1-replicaset arm-failure "$trace"
  if trace_phases_are_ordered "$trace" ARM RS_W1_CLOSE RS_EXCURSION \
      RS_LIST_BOUNDARY RS_SUCCESSOR_REPLAY; then
    pass 'ReplicaSet replay is causally W1-close then excursion then LIST boundary then successor'
  else
    fail 'ReplicaSet receipt replay phase order' "$(cat "$trace" 2>/dev/null || :)"
  fi

  trace="$TMP_DIR/legacy-receipt-w1-pod.trace"
  expect_success 'receipt W1 Pod successor replays a transient hidden by the terminal LIST' \
    run_legacy_receipt_monitor_handoff_case \
      legacy-receipt-w1-pod arm-failure "$trace"
  if trace_phases_are_ordered "$trace" ARM POD_W1_CLOSE POD_EXCURSION \
      POD_LIST_BOUNDARY POD_SUCCESSOR_REPLAY; then
    pass 'Pod replay is causally W1-close then excursion then LIST boundary then successor'
  else
    fail 'Pod receipt replay phase order' "$(cat "$trace" 2>/dev/null || :)"
  fi

  trace="$TMP_DIR/legacy-receipt-status-only.trace"
  expect_success 'post-receipt Reticulum status-only RV advance suppresses ACK' \
    run_legacy_receipt_monitor_handoff_case \
      legacy-receipt-status-only commit-failure "$trace"
  if trace_phases_are_ordered "$trace" ARM PATCH_RECEIPT COMMIT \
      STATUS_FINAL_GET_BEGIN STATUS_ONLY_EVENT &&
     ! grep -qx ACK "$trace"; then
    pass 'status-only ambiguity occurs after receipt and during the final GET without ACK'
  else
    fail 'status-only receipt ambiguity phase order' "$(cat "$trace" 2>/dev/null || :)"
  fi

  trace="$TMP_DIR/legacy-receipt-happy.trace"
  expect_success 'receipt handoff keeps three H watches through one natural post-request R generation' \
    run_legacy_receipt_monitor_handoff_case \
      legacy-receipt-happy success "$trace"
  if trace_phases_are_ordered "$trace" ARM PATCH_RECEIPT COMMIT H_LIVE_ALL \
      R_START_deployments R_NATURAL_deployments ACK \
      H_TERM_AFTER_ACK_deployments &&
     grep -qx H_LIVE_deployments "$trace" &&
     grep -qx H_LIVE_replicasets "$trace" &&
     grep -qx H_LIVE_pods "$trace" &&
     grep -qx R_NATURAL_replicasets "$trace" &&
     grep -qx R_NATURAL_pods "$trace"; then
    pass 'healthy H-to-R barrier observes all resources and terminates H only after ACK'
  else
    fail 'healthy receipt H-to-R phase order' "$(cat "$trace" 2>/dev/null || :)"
  fi

  for mode in legacy-receipt-r-error-410 legacy-receipt-r-clean-close \
    legacy-receipt-r-exit-91; do
    case "$mode" in
      legacy-receipt-r-error-410) expected_phase=R_ERROR_410 ;;
      legacy-receipt-r-clean-close) expected_phase=R_CLEAN_CLOSE ;;
      legacy-receipt-r-exit-91) expected_phase=R_EXIT_91 ;;
    esac
    trace="$TMP_DIR/$mode.trace"
    expect_success "$mode fails before ACK while H is still held" \
      run_legacy_receipt_monitor_handoff_case "$mode" commit-failure "$trace"
    if trace_phases_are_ordered "$trace" H_LIVE_ALL "$expected_phase" \
        H_TERM_BEFORE_ACK_deployments && ! grep -qx ACK "$trace"; then
      pass "$mode terminates held coverage before any ACK"
    else
      fail "$mode H/R failure phase order" "$(cat "$trace" 2>/dev/null || :)"
    fi
  done
}

legacy_schema2_restore_confirmation() {
  local inventory_sha
  inventory_sha="$(sha256_digest \
    "$GOOD_CHECKPOINT/deployment-images.json")" || return 1
  printf 'legacy-in-place:fixture-context:hcce:fixture-uid:fixture-pvc-uid:%s:%s:%s:%s:%s:legacy-absent\n' \
    "$STAMP" "$DUMP_SHA" "$STORAGE_SHA" "$inventory_sha" "$inventory_sha"
}

legacy_clear_stale_confirmation() {
  local inventory_sha
  inventory_sha="$(sha256_digest \
    "$GOOD_CHECKPOINT/deployment-images.json")" || return 1
  printf 'restore-lock:fixture-context:hcce:fixture-uid:%s:%s:%s:restore-lock-uid:fixture-pvc-uid:%s:legacy-absent\n' \
    "$STAMP" "$DUMP_SHA" "$STORAGE_SHA" "$inventory_sha"
}

run_legacy_receipt_shell_fixture() {
  local mode="$1" trace_path="$2" private_tmp confirmation
  private_tmp="$(mktemp -d "$TMP_DIR/legacy-receipt-shell.XXXXXX")" || return 1
  chmod 700 "$private_tmp" || return 1
  confirmation="$(legacy_schema2_restore_confirmation)" || return 1
  : >"$trace_path"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
    RESTORE_CHECKPOINT_LEGACY_IN_PLACE=1 \
    CONFIRM_LEGACY_IN_PLACE_RESTORE="$confirmation" \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
    STUB_CHECKPOINT_WRITER_DISCOVER_MONITOR=1 \
    STUB_CHECKPOINT_RECEIPT_TRACE="$trace_path" STUB_MODE="$mode" \
    TMPDIR="$private_tmp" bash -c '
      export STUB_RESTORE_DRIVER_PID=$$
      exec "$1" "$2"
    ' _ "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
}

legacy_receipt_failure_state_is_exact() {
  local expected_receipt="$1"
  checkpoint_all_writers_at 0 &&
    [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
    case "$expected_receipt" in
      present) [[ -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] ;;
      absent) [[ ! -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] ;;
      *) return 2 ;;
    esac
}

run_legacy_receipt_shell_happy_test() {
  local trace="$TMP_DIR/legacy-receipt-shell-happy.trace"
  reset_stub
  expect_success 'real schema-2 legacy restore completes the receipt handoff and resumes safely' \
    run_legacy_receipt_shell_fixture legacy-receipt-shell-happy "$trace"
  if trace_phases_are_ordered "$trace" ARM PATCH_RECEIPT COMMIT ACK \
      SCALE_RETICULUM_WITH_RECEIPT ROLLOUT_RETICULUM \
      RECAPTURE_RETICULUM_RV CLEAR_RETICULUM_RECEIPT \
      SCALE_OTHER_pgbouncer SCALE_OTHER_pgbouncer-t SCALE_OTHER_coturn \
      SCALE_OTHER_bot-orchestrator DELETE_RESTORE_LOCK &&
     checkpoint_all_writers_at 1 && checkpoint_all_writer_rollouts_observed &&
     checkpoint_resume_receipts_absent &&
     [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'legacy shell handoff orders receipt, target resume, receipt clear, remaining writers, parent and lock release'
  else
    fail 'legacy shell receipt handoff exact causal order and terminal state' \
      "trace=$(tr '\n' ',' <"$trace" 2>/dev/null || :) writers=$(for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do printf '%s=%s,' "$writer" "$(cat "$STUB_STATE_DIR/replicas-$writer" 2>/dev/null || printf missing)"; done) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
  fi
}

run_legacy_receipt_shell_failure_tests() {
  local mode trace

  reset_stub
  printf '%s' ffffffffffffffffffffffffffffffff \
    >"$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum"
  trace="$TMP_DIR/legacy-receipt-shell-stale-preflight.trace"
  expect_failure 'legacy restore rejects a stale receipt before downtime' \
    'stale or unknown resume receipt' \
    run_legacy_receipt_shell_fixture legacy-receipt-shell-happy "$trace"
  if ! grep -q 'patch deployment ' "$KUBECTL_LOG" &&
     [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" &&
        -f "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum" ]] &&
     ! grep -qx ARM "$trace"; then
    pass 'stale receipt preflight performs zero workload mutation and releases only its new lock'
  else
    fail 'stale receipt preflight mutation boundary' "$(cat "$KUBECTL_LOG")"
  fi

  for mode in legacy-receipt-publish-lost legacy-receipt-scale-lost \
    legacy-receipt-clear-lost; do
    reset_stub
    trace="$TMP_DIR/$mode-shell.trace"
    expect_success "$mode reconciles its lost PATCH response through exact readback" \
      run_legacy_receipt_shell_fixture "$mode" "$trace"
    if checkpoint_all_writers_at 1 && checkpoint_all_writer_rollouts_observed &&
       checkpoint_resume_receipts_absent &&
       [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
       grep -q 'RESPONSE_LOST' "$trace"; then
      pass "$mode finishes with five writers, zero receipts and no retained lock"
    else
      fail "$mode exact lost-response reconciliation" \
        "trace=$(tr '\n' ',' <"$trace" 2>/dev/null || :) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
    fi
  done

  for mode in legacy-receipt-signal-before legacy-receipt-signal-after; do
    reset_stub
    trace="$TMP_DIR/$mode-shell.trace"
    expect_failure "$mode interrupts the real restore without releasing authority" '' \
      run_legacy_receipt_shell_fixture "$mode" "$trace"
    if [[ "$mode" == legacy-receipt-signal-before ]]; then
      if legacy_receipt_failure_state_is_exact absent &&
         grep -qx SIGNAL_BEFORE_RECEIPT "$trace" && ! grep -qx ACK "$trace"; then
        pass 'signal before receipt leaves the watcher-owned five-zero state unambiguous'
      else
        fail 'signal-before exact fail-closed state' \
          "trace=$(tr '\n' ',' <"$trace" 2>/dev/null || :)"
      fi
    elif legacy_receipt_failure_state_is_exact present &&
         trace_phases_are_ordered "$trace" PATCH_RECEIPT SIGNAL_AFTER_RECEIPT \
           COMMIT ACK; then
      pass 'signal after receipt defers through ACK and retains receipt, lock and five-zero state'
    else
      fail 'signal-after exact fail-closed state' \
        "trace=$(tr '\n' ',' <"$trace" 2>/dev/null || :)"
    fi
  done
}

seed_legacy_clear_stale_receipt_case() {
  local receipt_case="$1" deployment
  reset_stub
  seed_schema2_legacy_stale_restore_lock available
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '%s' 0 >"$STUB_STATE_DIR/replicas-$deployment"
    printf '%s' 2 >"$STUB_STATE_DIR/rv-$deployment"
  done
  case "$receipt_case" in
    zero) ;;
    exact)
      printf '%s' 88888888888888888888888888888888 \
        >"$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum"
      ;;
    wrong)
      printf '%s' ffffffffffffffffffffffffffffffff \
        >"$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum"
      ;;
    multiple)
      printf '%s' 88888888888888888888888888888888 \
        >"$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum"
      printf '%s' 88888888888888888888888888888888 \
        >"$STUB_STATE_DIR/checkpoint-resume-receipt-pgbouncer"
      ;;
    non-reticulum)
      printf '%s' 88888888888888888888888888888888 \
        >"$STUB_STATE_DIR/checkpoint-resume-receipt-pgbouncer"
      ;;
    replicas1)
      printf '%s' 1 >"$STUB_STATE_DIR/replicas-reticulum"
      ;;
    *) return 2 ;;
  esac
}

legacy_clear_stale_receipt_snapshot() {
  local receipt_path
  for receipt_path in \
    "$STUB_STATE_DIR"/checkpoint-resume-receipt-*; do
    [[ -f "$receipt_path" ]] || continue
    printf '%s=%s\n' "${receipt_path##*/}" "$(cat "$receipt_path")"
  done | LC_ALL=C sort
}

run_legacy_clear_stale_receipt_command() {
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
    CONFIRM_CLEAR_RESTORE_LOCK="$(legacy_clear_stale_confirmation)" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
}

run_legacy_clear_stale_receipt_tests() {
  local receipt_case before_receipts after_receipts cleanup_count
  local receipt_cleanup_line lock_delete_line

  for receipt_case in zero exact; do
    seed_legacy_clear_stale_receipt_case "$receipt_case"
    expect_success "legacy clear-stale accepts $receipt_case exact receipt state" \
      run_legacy_clear_stale_receipt_command
    cleanup_count="$(deployment_resume_receipt_cleanup_count reticulum)"
    receipt_cleanup_line="$(grep -En \
      'patch deployment reticulum .*"op":"remove","path":"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"' \
      "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
    lock_delete_line="$(grep -En \
      'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' \
      "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
    if checkpoint_all_writers_at 0 && checkpoint_resume_receipts_absent &&
       [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
       ! any_deployment_replica_mutation &&
       [[ "$cleanup_count" == "$([[ "$receipt_case" == exact ]] && printf 1 || printf 0)" ]] &&
       [[ "$lock_delete_line" =~ ^[0-9]+$ ]] &&
       { [[ "$receipt_case" == zero ]] ||
         [[ "$receipt_cleanup_line" =~ ^[0-9]+$ &&
            "$receipt_cleanup_line" -lt "$lock_delete_line" ]]; }; then
      pass "legacy clear-stale $receipt_case state is cleanup-only and causally ordered"
    else
      fail "legacy clear-stale $receipt_case exact terminal state" \
        "cleanup=$cleanup_count receipt_line=${receipt_cleanup_line:-missing} lock_line=${lock_delete_line:-missing} lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
    fi
  done

  for receipt_case in wrong multiple non-reticulum replicas1; do
    seed_legacy_clear_stale_receipt_case "$receipt_case"
    before_receipts="$(legacy_clear_stale_receipt_snapshot)"
    if [[ "$receipt_case" == replicas1 ]]; then
      expect_failure 'legacy clear-stale rejects one active fixed writer' \
        'Every DB consumer must already be at zero' \
        run_legacy_clear_stale_receipt_command
    else
      expect_failure "legacy clear-stale rejects $receipt_case receipt ownership" \
        'checkpoint resume receipt ownership is not exact' \
        run_legacy_clear_stale_receipt_command
    fi
    after_receipts="$(legacy_clear_stale_receipt_snapshot)"
    if [[ -e "$STUB_STATE_DIR/restore-lock.yaml" &&
          "$before_receipts" == "$after_receipts" ]] &&
       ! any_deployment_replica_mutation &&
       ! grep -Eq 'delete --raw=|"op":"remove","path":"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"' \
         "$KUBECTL_LOG"; then
      pass "legacy clear-stale $receipt_case rejection preserves lock and receipts without mutation"
    else
      fail "legacy clear-stale $receipt_case fail-closed terminal state" \
        "before=$before_receipts after=$after_receipts lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
    fi
  done
}

receipt_json_validator_rejects() {
  local kind="$1" json="$2" contract="$3" authority="$4" token_sha="$5"
  local generation="$6" patch_rv="${7:-}"
  case "$kind" in
    armed)
      ! recovery_checkpoint_writer_receipt_armed_json_is_acceptable \
        "$json" "$contract" "$authority" "$token_sha" \
        reticulum uid-reticulum "$generation"
      ;;
    ack)
      ! recovery_checkpoint_writer_receipt_ack_json_is_acceptable \
        "$json" "$contract" "$authority" "$token_sha" \
        reticulum uid-reticulum "$generation" "$patch_rv"
      ;;
    *) return 2 ;;
  esac
}

run_legacy_receipt_malformed_envelope_tests() {
  local armed_path="$TMP_DIR/legacy-receipt-valid-armed.json"
  local ack_path="$TMP_DIR/legacy-receipt-valid-ack.json"
  local contract="$TMP_DIR/legacy-receipt-valid-contract.json"
  local authority token_sha generation patch_rv case_name mutated
  [[ -s "$armed_path" && -s "$ack_path" && -s "$contract" ]] || return 1
  authority="$(cat "$TMP_DIR/legacy-receipt-valid-authority")" || return 1
  token_sha="$(jq -er '.token_sha256' "$armed_path")" || return 1
  generation="$(jq -er '.target.generation' "$armed_path")" || return 1
  patch_rv="$(cat "$TMP_DIR/legacy-receipt-valid-patch-rv")" || return 1
  reset_stub
  configure_legacy_receipt_monitor_library_context || return 1

  for case_name in token armed-rv uid authority; do
    case "$case_name" in
      token) mutated="$(jq -c '.token_sha256 = ("f" * 64)' "$armed_path")" ;;
      armed-rv) mutated="$(jq -c '.receipt.armed_resource_version = "wrong-rv"' "$armed_path")" ;;
      uid) mutated="$(jq -c '.target.uid = "replacement-reticulum-uid"' "$armed_path")" ;;
      authority) mutated="$(jq -c '.monitor_authority_sha256 = ("f" * 64)' "$armed_path")" ;;
    esac
    expect_success "ARMED validator rejects malformed $case_name" \
      receipt_json_validator_rejects armed "$mutated" "$contract" \
        "$authority" "$token_sha" "$generation"
  done

  for case_name in token patch-rv terminal-rv uid authority; do
    case "$case_name" in
      token) mutated="$(jq -c '.token_sha256 = ("f" * 64)' "$ack_path")" ;;
      patch-rv) mutated="$(jq -c '.receipt.patch_response_resource_version = "wrong-rv"' "$ack_path")" ;;
      terminal-rv) mutated="$(jq -c '(.deployments[] | select(.name == "reticulum") | .resource_version) = "wrong-rv"' "$ack_path")" ;;
      uid) mutated="$(jq -c '.target.uid = "replacement-reticulum-uid"' "$ack_path")" ;;
      authority) mutated="$(jq -c '.monitor_authority_sha256 = ("f" * 64)' "$ack_path")" ;;
    esac
    expect_success "ACK validator rejects malformed $case_name" \
      receipt_json_validator_rejects ack "$mutated" "$contract" \
        "$authority" "$token_sha" "$generation" "$patch_rv"
  done
}

run_legacy_receipt_create_checkpoint_regression_test() {
  local output="$TMP_DIR/legacy-receipt-create-checkpoint-regression"
  local cleanup_count
  reset_stub
  expect_failure 'legacy checkpoint lost-response reentry still uses five exact receipts' '' \
    run_checkpoint_resume_fixture legacy checkpoint-resume-lost-response "$output"
  cleanup_count="$(grep -Ec \
    'patch deployment .*"op":"remove","path":"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"' \
    "$KUBECTL_LOG" || :)"
  if [[ "$cleanup_count" == 5 ]] && checkpoint_all_writers_at 1 &&
     checkpoint_all_writer_rollouts_observed && checkpoint_resume_receipts_absent &&
     [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'create-checkpoint still reconciles and clears all five writer receipts before lock release'
  else
    fail 'create-checkpoint five-receipt regression contract' \
      "cleanups=$cleanup_count lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
  fi
}

run_legacy_receipt_shell_tests() {
  run_legacy_receipt_shell_happy_test
  if [[ "${YENHUBS_RECOVERY_TEST_CASE:-}" == shell-happy ]]; then
    return 0
  fi
  run_legacy_receipt_shell_failure_tests
  run_legacy_clear_stale_receipt_tests
  expect_success 'malformed receipt envelope matrix executes against exact context' \
    run_legacy_receipt_malformed_envelope_tests
  run_legacy_receipt_create_checkpoint_regression_test
}

run_checkpoint_writer_fence_contract_tests() {
  local mode
  expect_success 'checkpoint writer monitor signs its durable fence baseline and completes exact boundary stop' \
    run_checkpoint_writer_monitor_success
  expect_success 'checkpoint writer monitor signs and enforces an explicit checkpoint-restore owner' \
    run_checkpoint_writer_monitor_success "" durable-v2 checkpoint-restore
  expect_success 'checkpoint writer monitor rejects an allowed CLI owner that differs from the live lock owner' \
    run_checkpoint_writer_operation_owner_mismatch_test
  expect_success 'checkpoint-backup accepts only its exact ret-storage-backup helper lifecycle' \
    run_checkpoint_writer_monitor_success \
      checkpoint-writer-owned-helper-lifecycle durable-v2 checkpoint-backup
  expect_success 'checkpoint-restore accepts only its exact ret-storage-restore helper lifecycle' \
    run_checkpoint_writer_monitor_success \
      checkpoint-writer-owned-helper-lifecycle durable-v2 checkpoint-restore
  expect_success 'checkpoint-backup rejects a crossed ret-storage-restore helper event' \
    run_checkpoint_writer_monitor_failure \
      checkpoint-writer-helper-cross-owner "" checkpoint-backup
  expect_success 'checkpoint-restore rejects a crossed ret-storage-backup helper event' \
    run_checkpoint_writer_monitor_failure \
      checkpoint-writer-helper-cross-owner "" checkpoint-restore
  expect_success 'checkpoint-backup rejects a writable backup helper event' \
    run_checkpoint_writer_monitor_failure \
      checkpoint-writer-helper-cross-mode "" checkpoint-backup
  expect_success 'checkpoint-restore rejects a read-only restore helper event' \
    run_checkpoint_writer_monitor_failure \
      checkpoint-writer-helper-cross-mode "" checkpoint-restore
  expect_success 'legacy checkpoint writer monitor signs explicit absence without consulting the durable fence' \
    run_checkpoint_writer_monitor_success "" legacy-absent
  if [[ ! -e "$STUB_STATE_DIR/recovery-operation-fence-policy-queried" &&
        ! -e "$STUB_STATE_DIR/recovery-operation-fence-binding-queried" &&
        ! -e "$STUB_STATE_DIR/recovery-operation-fence-parent-namespace-queried" &&
        ! -e "$STUB_STATE_DIR/recovery-operation-fence-runner-namespace-queried" ]] &&
     ! grep -q 'recovery-operation-pod-fence.yenhubs.org' "$KUBECTL_LOG"; then
    pass 'legacy-absent performs zero recovery-operation fence reads'
  else
    fail 'legacy-absent recovery-operation fence isolation' "$(cat "$KUBECTL_LOG")"
  fi
  expect_success 'checkpoint writer monitor rejects an invalid explicit generation before Kubernetes' \
    run_checkpoint_writer_invalid_generation_test
  expect_success 'checkpoint writer boundary rejects a generation different from its signed baseline' \
    run_checkpoint_writer_generation_mismatch_boundary_test
  expect_success 'checkpoint writer boundary binds the signed operation id' \
    run_checkpoint_writer_signed_capability_mismatch_test operation-id
  expect_success 'checkpoint writer boundary binds the signed operation-lock resourceVersion' \
    run_checkpoint_writer_signed_capability_mismatch_test operation-lock-rv
  expect_success 'checkpoint writer boundary binds the signed Kubernetes context' \
    run_checkpoint_writer_signed_capability_mismatch_test context
  expect_success 'checkpoint writer boundary binds the signed Lease name' \
    run_checkpoint_writer_signed_capability_mismatch_test lease-name
  expect_success 'checkpoint writer boundary revalidates the fence after its terminal LIST' \
    run_checkpoint_writer_fence_second_boundary_read_test
  run_checkpoint_writer_terminal_handoff_tests

  for mode in checkpoint-writer-fence-policy-missing \
    checkpoint-writer-fence-parent-namespace-missing \
    checkpoint-writer-fence-parent-namespace-terminating \
    checkpoint-writer-fence-parent-namespace-inactive \
    checkpoint-writer-fence-parent-namespace-label-drift \
    checkpoint-writer-fence-runner-namespace-missing \
    checkpoint-writer-fence-runner-namespace-terminating \
    checkpoint-writer-fence-runner-namespace-inactive \
    checkpoint-writer-fence-runner-namespace-label-drift \
    checkpoint-writer-fence-policy-warning \
    checkpoint-writer-fence-policy-unobserved \
    checkpoint-writer-fence-policy-param-kind \
    checkpoint-writer-fence-policy-terminating \
    checkpoint-writer-fence-policy-spec-drift \
    checkpoint-writer-fence-policy-rule-drift \
    checkpoint-writer-fence-policy-variable-drift \
    checkpoint-writer-fence-policy-message-drift \
    checkpoint-writer-fence-binding-missing \
    checkpoint-writer-fence-binding-dormant \
    checkpoint-writer-fence-binding-param-ref \
    checkpoint-writer-fence-binding-params \
    checkpoint-writer-fence-binding-terminating \
    checkpoint-writer-fence-parent-namespace-replaced-after-ready \
    checkpoint-writer-fence-parent-namespace-rv-drift-after-ready \
    checkpoint-writer-fence-runner-namespace-replaced-after-ready \
    checkpoint-writer-fence-runner-namespace-rv-drift-after-ready \
    checkpoint-writer-fence-policy-drift-after-ready \
    checkpoint-writer-fence-policy-aba-after-ready \
    checkpoint-writer-fence-binding-drift-after-ready; do
    expect_success "checkpoint writer monitor fails closed on $mode" \
      run_checkpoint_writer_monitor_failure "$mode"
  done
  expect_success 'checkpoint writer policy read timeout fails closed within ten seconds' \
    run_checkpoint_writer_fence_timed_failure \
      checkpoint-writer-fence-policy-timeout
  expect_success 'checkpoint writer binding read timeout fails closed within ten seconds' \
    run_checkpoint_writer_fence_timed_failure \
      checkpoint-writer-fence-binding-timeout
  expect_success 'checkpoint writer parent Namespace timeout fails closed within ten seconds' \
    run_checkpoint_writer_fence_timed_failure \
      checkpoint-writer-fence-parent-namespace-timeout
  expect_success 'checkpoint writer runner Namespace timeout fails closed within ten seconds' \
    run_checkpoint_writer_fence_timed_failure \
      checkpoint-writer-fence-runner-namespace-timeout
  expect_success 'checkpoint writer four-object fence read shares one global ten-second deadline' \
    run_checkpoint_writer_fence_timed_failure \
      checkpoint-writer-fence-global-deadline
}

run_checkpoint_writer_list_item_gvk_tests() {
  local mode
  if [[ "${YENHUBS_RECOVERY_TEST_CASE:-}" != negatives ]]; then
    expect_success 'checkpoint writer monitor accepts omitted item GVK under exact typed Lists' \
      run_checkpoint_writer_list_item_gvk_success
  fi
  if [[ "${YENHUBS_RECOVERY_TEST_CASE:-}" == positive ]]; then
    return
  fi
  for mode in checkpoint-writer-deployment-gvk-spoof \
    checkpoint-writer-replicaset-gvk-spoof checkpoint-writer-pod-gvk-spoof; do
    expect_success "checkpoint writer monitor rejects explicit wrong item GVK: $mode" \
      run_checkpoint_writer_monitor_failure "$mode" "" checkpoint-backup
  done
}

run_checkpoint_writer_list_item_gvk_success() {
  local monitor_status=0 ready
  prepare_checkpoint_writer_monitor_fixture legacy-absent checkpoint-backup || return 1
  start_checkpoint_writer_test_monitor checkpoint-writer-list-item-gvk-omitted
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  if ! [[ "$ready" =~ ^ready:[a-f0-9]{64}:[a-f0-9]{64}$ &&
          ! -s "$WRITER_TEST_FAILURE" ]]; then
    kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
    wait "$WRITER_TEST_PID" 2>/dev/null || :
    return 1
  fi
  printf 'discard\n' >"$WRITER_TEST_STOP"
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" == 0 && ! -s "$WRITER_TEST_FAILURE" &&
     ! -s "$WRITER_TEST_FINAL" ]]
}

run_checkpoint_writer_live_pod_defaults_tests() {
  expect_success 'checkpoint writer monitor accepts exact Kubernetes Pod defaults under typed Lists' \
    run_checkpoint_writer_live_pod_defaults_success
  expect_success 'checkpoint writer monitor accepts imagePullSecrets declared by the exact ReplicaSet template' \
    run_checkpoint_writer_live_pod_defaults_success \
      checkpoint-writer-template-pull-secret
  expect_success 'checkpoint writer monitor canonicalizes semantic Deployment key order across GET and LIST' \
    run_checkpoint_writer_live_pod_defaults_success \
      checkpoint-writer-list-key-order
  expect_success 'checkpoint writer monitor rejects explicit enableServiceLinks false against an omitted template default' \
    run_checkpoint_writer_monitor_failure \
      checkpoint-writer-live-pod-explicit-false "" checkpoint-backup
  expect_success 'checkpoint writer monitor rejects initial Pod imagePullSecrets different from its ServiceAccount' \
    run_checkpoint_writer_monitor_failure \
      checkpoint-writer-live-pod-secret-mismatch "" checkpoint-backup
  expect_success 'checkpoint writer monitor rejects replacement Pod imagePullSecrets drift on WATCH' \
    run_checkpoint_writer_monitor_failure \
      checkpoint-writer-live-pod-secret-watch-drift "" checkpoint-backup
}

run_checkpoint_writer_live_pod_defaults_success() {
  local mode="${1:-checkpoint-writer-live-pod-defaults}"
  local monitor_status=0 ready
  prepare_checkpoint_writer_monitor_fixture legacy-absent checkpoint-backup || return 1
  start_checkpoint_writer_test_monitor "$mode"
  wait_checkpoint_writer_test_handoff || return 1
  ready="$(cat "$WRITER_TEST_READY")"
  if ! [[ "$ready" =~ ^ready:[a-f0-9]{64}:[a-f0-9]{64}$ &&
          ! -s "$WRITER_TEST_FAILURE" ]]; then
    kill -TERM "$WRITER_TEST_PID" 2>/dev/null || :
    wait "$WRITER_TEST_PID" 2>/dev/null || :
    return 1
  fi
  printf 'discard\n' >"$WRITER_TEST_STOP"
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  [[ "$monitor_status" == 0 && ! -s "$WRITER_TEST_FAILURE" &&
     ! -s "$WRITER_TEST_FINAL" ]]
}

run_checkpoint_writer_monitor_tests() {
  local mode mutation writer runner_mode all_zero output publication_safe checkpoint_stamp
  local receipt_cleanup_count last_rollout_line lock_delete_line
  if [[ "${YENHUBS_RECOVERY_TEST_CASE:-}" == exit-143 ]]; then
    expect_success 'checkpoint writer exit 143 revokes its descendant group and records failed join' \
      run_checkpoint_writer_exit_143_descendant_test
    return
  fi
  reset_stub
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'unattested checkpoint-writer kubectl override fails before invocation' \
    'exact isolated fixture identity' \
    env KUBECTL_BIN="$TMP_DIR/bin/kubectl" \
    YENHUBS_RECOVERY_TEST_MODE=local-fixture \
    EXPECTED_KUBE_CONTEXT=nonfixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid NAMESPACE=hcce bash -c '
      source "$1"
      recovery_checkpoint_writer_monitor_kubectl_bin
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  if [[ ! -s "$KUBECTL_LOG" ]]; then
    pass 'unattested checkpoint-writer kubectl override executes no binary or Node monitor'
  else
    fail 'unattested checkpoint-writer kubectl override crossed the invocation boundary' \
      "$(cat "$KUBECTL_LOG")"
  fi
  expect_success 'checkpoint writer spawn gate prevents exec when identity capture fails' \
    run_checkpoint_writer_spawn_gate_test identity-failure
  expect_success 'checkpoint writer pre-ready exit is reaped with its isolated descendants' \
    run_checkpoint_writer_spawn_gate_test pre-ready-exit
  run_checkpoint_writer_fence_contract_tests
  expect_success 'checkpoint writer monitor permits only the exact owned read-only helper lifecycle' \
    run_checkpoint_writer_monitor_success checkpoint-writer-owned-helper-lifecycle
  expect_success 'checkpoint writer monitor permits an exact non-writer Pod replacement lifecycle' \
    run_checkpoint_writer_monitor_success checkpoint-writer-nonwriter-pod-replacement

  for mode in checkpoint-writer-deployment-excursion \
    checkpoint-writer-replicaset-excursion checkpoint-writer-replicaset-added \
    checkpoint-writer-pod-excursion checkpoint-writer-pod-modified-dangerous \
    checkpoint-writer-direct-pod-preexisting checkpoint-writer-watch-error \
    checkpoint-writer-watch-closes checkpoint-writer-lock-rv-drift \
    checkpoint-writer-lease-uid-drift \
    checkpoint-writer-lease-transitions-drift checkpoint-writer-helper-rw \
    checkpoint-writer-helper-env checkpoint-writer-helper-ephemeral \
    checkpoint-writer-helper-image-drift \
    checkpoint-writer-nonwriter-pod-annotation-drift lease-holder-lost; do
    expect_success "checkpoint writer monitor fails closed on $mode" \
      run_checkpoint_writer_monitor_failure "$mode"
  done
  expect_success 'checkpoint writer monitor rejects stale Lease freshness' \
    run_checkpoint_writer_monitor_failure "" stale-lease

  for mutation in contract-tamper contract-symlink baseline-initial \
    baseline-symlink ready-initial progress-initial progress-symlink \
    progress-next stop-initial failure-initial final-initial final-symlink; do
    expect_success "checkpoint writer monitor rejects $mutation" \
      run_checkpoint_writer_monitor_failure "" "$mutation"
  done
  expect_success 'checkpoint writer boundary rejects post-ready baseline tampering' \
    run_checkpoint_writer_baseline_tamper_test

  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  output="$TMP_DIR/checkpoint-writer-post-ready-failure"
  expect_failure 'post-ready writer excursion blocks checkpoint writer resume' '' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
    STUB_MODE=checkpoint-writer-post-ready-excursion \
    KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"
  all_zero=true
  for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ ! -f "$STUB_STATE_DIR/replicas-$writer" ||
          "$(cat "$STUB_STATE_DIR/replicas-$writer")" != 0 ]]; then
      all_zero=false
    fi
  done
  if [[ -e "$STUB_STATE_DIR/checkpoint-writer-post-ready-emitted" &&
        "$all_zero" == true && -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     ! grep -Eq 'patch deployment .*"op":"replace","path":"/spec/replicas","value":1' \
       "$KUBECTL_LOG"; then
    pass 'failed continuous writer monitor retains lock with every writer at zero'
  else
    fail 'failed continuous writer monitor resumed a writer or released authority' \
      "states=$(for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
        printf '%s=%s ' "$writer" "$(cat "$STUB_STATE_DIR/replicas-$writer" 2>/dev/null || printf missing)"
      done) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) resume_patch=$(grep -Ec 'patch deployment .*\"op\":\"replace\",\"path\":\"/spec/replicas\",\"value\":1' "$KUBECTL_LOG" || :)"
  fi

  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  output="$TMP_DIR/checkpoint-writer-final-publication-failure"
  expect_failure 'writer event after final rehash blocks checkpoint publication' \
    'Checkpoint failure: stage=terminal-boundary code=writer-monitor status=1.' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
    STUB_MODE=checkpoint-writer-final-publication-excursion \
    KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
    STUB_CHECKPOINT_OUTPUT_PATH="$output" \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$output"
  publication_safe=false
  if [[ ! -e "$output" ]]; then
    publication_safe=true
  elif [[ -f "$output/.yenhubs-incomplete" &&
          -f "$output/checkpoint-metadata.json" ]]; then
    checkpoint_stamp="$(jq -er '.stamp' "$output/checkpoint-metadata.json" 2>/dev/null || :)"
    if [[ -n "$checkpoint_stamp" ]] &&
       ! bash -c 'source "$1"; recovery_verify_checkpoint_directory "$2" "$3"' \
         _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$output" \
         "$checkpoint_stamp" >/dev/null 2>&1; then
      publication_safe=true
    fi
  fi
  all_zero=true
  for writer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ ! -f "$STUB_STATE_DIR/replicas-$writer" ||
          "$(cat "$STUB_STATE_DIR/replicas-$writer")" != 0 ]]; then
      all_zero=false
    fi
  done
  if [[ -e "$STUB_STATE_DIR/checkpoint-writer-final-boundary-read" &&
        -e "$STUB_STATE_DIR/checkpoint-writer-final-event-emitted" &&
        "$publication_safe" == true && "$all_zero" == true &&
        -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     ! grep -Eq 'patch deployment .*"op":"replace","path":"/spec/replicas","value":1' \
       "$KUBECTL_LOG"; then
    pass 'final-boundary writer event leaves no acceptable unmarked checkpoint and no resume'
  else
    fail 'final-boundary writer event crossed the publication or resume boundary' \
      "boundary=$([[ -e "$STUB_STATE_DIR/checkpoint-writer-final-boundary-read" ]] && printf seen || printf missing) event=$([[ -e "$STUB_STATE_DIR/checkpoint-writer-final-event-emitted" ]] && printf seen || printf missing) output=$([[ -e "$output" ]] && printf present || printf absent) marker=$([[ -f "$output/.yenhubs-incomplete" ]] && printf present || printf absent) publication_safe=$publication_safe writers_zero=$all_zero lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) command_output=$LAST_OUTPUT"
  fi

  run_checkpoint_writer_additional_tests

  for runner_mode in legacy durable; do
    for mode in checkpoint-resume-lost-response checkpoint-resume-postcheck-lost; do
      reset_stub
      output="$TMP_DIR/checkpoint-resume-$runner_mode-$mode"
      expect_failure "$runner_mode checkpoint reentry adopts exact bot receipt after $mode" '' \
        run_checkpoint_resume_fixture "$runner_mode" "$mode" "$output"
      receipt_cleanup_count="$(grep -Ec \
        'patch deployment .*"op":"remove","path":"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"' \
        "$KUBECTL_LOG" || :)"
      last_rollout_line="$( (grep -n 'rollout status deployment/' "$KUBECTL_LOG" || :) |
        tail -1 | cut -d: -f1 )"
      lock_delete_line="$( (grep -n \
        'delete --raw=/api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock' \
        "$KUBECTL_LOG" || :) | tail -1 | cut -d: -f1 )"
      if [[ ( "$mode" != checkpoint-resume-lost-response ||
              -e "$STUB_STATE_DIR/checkpoint-resume-lost-response" ) &&
            ( "$mode" != checkpoint-resume-postcheck-lost ||
              -e "$STUB_STATE_DIR/checkpoint-resume-postcheck-lost" ) ]] &&
         checkpoint_all_writers_at 1 && checkpoint_all_writer_rollouts_observed &&
         checkpoint_resume_receipts_absent && [[ "$receipt_cleanup_count" == 5 &&
           ! -e "$STUB_STATE_DIR/restore-lock.yaml" &&
           "$last_rollout_line" =~ ^[0-9]+$ && "$lock_delete_line" =~ ^[0-9]+$ &&
           "$last_rollout_line" -lt "$lock_delete_line" ]]; then
        pass "$runner_mode reentry restores five writers, clears receipts, then releases lock"
      else
        fail "$runner_mode ambiguous resume receipt reentry contract" \
          "mode=$mode receipts_removed=$receipt_cleanup_count last_rollout=${last_rollout_line:-missing} lock_delete=${lock_delete_line:-missing} lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) receipts=$(find "$STUB_STATE_DIR" -maxdepth 1 -type f -name 'checkpoint-resume-receipt-*' -print | paste -sd, -)"
      fi
    done
  done

  for mode in checkpoint-resume-external-without-receipt \
    checkpoint-resume-wrong-receipt; do
    reset_stub
    output="$TMP_DIR/$mode"
    expect_failure "$mode blocks checkpoint resume adoption" '' \
      run_checkpoint_resume_fixture durable "$mode" "$output"
    if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 1 &&
          -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
       ! grep -q \
         'delete --raw=/api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock' \
         "$KUBECTL_LOG"; then
      if [[ "$mode" == checkpoint-resume-external-without-receipt &&
            ! -e "$STUB_STATE_DIR/checkpoint-resume-receipt-bot-orchestrator" ]] ||
         [[ "$mode" == checkpoint-resume-wrong-receipt &&
            "$(cat "$STUB_STATE_DIR/checkpoint-resume-receipt-bot-orchestrator" 2>/dev/null || :)" == \
              ffffffffffffffffffffffffffffffff ]]; then
        pass "$mode retains authority without adopting an unproven 0-to-original transition"
      else
        fail "$mode fixture did not materialize its intended ambiguous state" \
          "receipt=$(cat "$STUB_STATE_DIR/checkpoint-resume-receipt-bot-orchestrator" 2>/dev/null || printf absent)"
      fi
    else
      fail "$mode released authority after an unproven resume" \
        "replicas=$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || printf missing) lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)"
    fi
  done

  reset_stub
  printf 'ffffffffffffffffffffffffffffffff' \
    >"$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum"
  output="$TMP_DIR/checkpoint-stale-resume-receipt"
  expect_failure 'checkpoint rejects a stale writer resume receipt before downtime' \
    'stale or unknown resume receipt' \
    run_checkpoint_resume_fixture durable '' "$output"
  if ! grep -q 'patch deployment ' "$KUBECTL_LOG" &&
     [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'stale writer receipt rejection performs zero replica mutation and releases own lock'
  else
    fail 'stale writer receipt crossed the pre-downtime mutation boundary' \
      "$(grep 'patch deployment ' "$KUBECTL_LOG" || :)"
  fi

  reset_stub
  output="$TMP_DIR/checkpoint-lock-create-lost-response"
  expect_success 'checkpoint adopts only its exact lock after a lost create response' \
    run_checkpoint_resume_fixture durable checkpoint-lock-create-lost-response "$output"
  if [[ -e "$STUB_STATE_DIR/checkpoint-lock-create-lost-response" ]] &&
     checkpoint_output_is_valid "$output" && checkpoint_all_writers_at 1 &&
     checkpoint_resume_receipts_absent && [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'exact post-create lock readback continues and removes only the adopted lock'
  else
    fail 'lost lock-create response was not reconciled through exact private identity' \
      "lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) output=$([[ -e "$output" ]] && printf present || printf absent)"
  fi

  for mode in checkpoint-lock-create-wrong-token checkpoint-lock-create-competitor; do
    reset_stub
    output="$TMP_DIR/$mode"
    expect_failure "$mode is never adopted after an ambiguous create" '' \
      run_checkpoint_resume_fixture durable "$mode" "$output"
    if [[ -e "$STUB_STATE_DIR/$mode" && -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
       ! grep -q 'patch deployment ' "$KUBECTL_LOG" &&
       ! grep -q \
         'delete --raw=/api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock' \
         "$KUBECTL_LOG"; then
      pass "$mode remains untouched with zero writer mutation"
    else
      fail "$mode was adopted, mutated or deleted without exact private identity" \
        "lock=$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent) patches=$(grep -c 'patch deployment ' "$KUBECTL_LOG" || :)"
    fi
  done
}

run_restore_target_mode_tests() {
  local mode expected expected_status surface input_path test_name case_tmp
  for mode in cold-rebind future-rebind; do
    if [[ "$mode" != cold-rebind ]]; then
      expected='RESTORE_TARGET_MODE must be exactly in-place'
      expected_status=2
    fi
    for surface in coordinator db-child storage-child-clear-stale-helper; do
      reset_stub
      case_tmp="$TMP_DIR/restore-target-mode-$mode-$surface-tmp"
      mkdir -p "$case_tmp"
      input_path="$case_tmp/must-not-exist"
      if [[ "$mode" == cold-rebind ]]; then
        expected_status=1
        case "$surface" in
          coordinator)
            expected='Checkpoint directory must be direct and contain no symlink component'
            ;;
          db-child | storage-child-clear-stale-helper)
            expected='Restore artifacts must be regular files, not links'
            ;;
        esac
        test_name="$surface accepts RESTORE_TARGET_MODE=cold-rebind and rejects a missing input before materialization"
      else
        test_name="$surface rejects RESTORE_TARGET_MODE=$mode before input materialization"
      fi
      case "$surface" in
        coordinator)
          expect_failure_status "$test_name" "$expected" "$expected_status" \
            env TMPDIR="$case_tmp" RESTORE_TARGET_MODE="$mode" \
            RESTORE_CHECKPOINT_PREFLIGHT=1 \
            "$ROOT_DIR/deployment/restore-checkpoint.sh" "$input_path"
          ;;
        db-child)
          expect_failure_status "$test_name" "$expected" "$expected_status" \
            env TMPDIR="$case_tmp" RESTORE_TARGET_MODE="$mode" RESTORE_PREFLIGHT=1 \
            "$ROOT_DIR/deployment/restore-retdb.sh" "$input_path"
          ;;
        storage-child-clear-stale-helper)
          expect_failure_status "$test_name" "$expected" "$expected_status" \
            env TMPDIR="$case_tmp" RESTORE_TARGET_MODE="$mode" RESTORE_COORDINATED=1 \
            RESTORE_STORAGE_CLEAR_STALE_HELPER=1 \
            "$ROOT_DIR/deployment/restore-ret-storage.sh" "$input_path"
          ;;
      esac
      if [[ ! -e "$input_path" && ! -s "$KUBECTL_LOG" ]] &&
         [[ -z "$(find "$case_tmp" -mindepth 1 -print -quit)" ]]; then
        pass "$surface RESTORE_TARGET_MODE=$mode rejection creates no temporaries, kubectl calls or deletes"
      else
        fail "$surface RESTORE_TARGET_MODE=$mode crossed its pre-materialization boundary" \
          "input=$([[ -e "$input_path" ]] && printf present || printf absent) temporaries=$(find "$case_tmp" -mindepth 1 -maxdepth 1 -print) kubectl=$(cat "$KUBECTL_LOG")"
      fi
    done
  done
}

storage_helper_pod_contract() {
  local pod_json="$1" read_only="$2"
  local image="ghcr.io/yengalvez/reticulum@sha256:6666666666666666666666666666666666666666666666666666666666666666"
  # shellcheck disable=SC2016 # Positional arguments expand in the isolated Bash process.
  env NAMESPACE=hcce bash -c '
    set -euo pipefail
    source "$1"
    recovery_storage_helper_pod_is_exact "$2" \
      ret-storage-restore-888888888888 restore-pod-uid \
      ret-storage-restore "$3" "$4"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$pod_json" "$image" \
    "$read_only"
}

storage_helper_policy_contract() {
  local policy_json="$1"
  # shellcheck disable=SC2016 # Positional arguments expand in the isolated Bash process.
  env NAMESPACE=hcce bash -c '
    set -euo pipefail
    source "$1"
    recovery_storage_helper_network_policy_is_exact "$2" \
      ret-storage-restore-deny-888888888888 network-policy-uid \
      ret-storage-restore
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$policy_json"
}

run_storage_helper_contract_tests() {
  local pod_fixture="$TMP_DIR/storage-helper-pod-create.yaml"
  local policy_fixture="$TMP_DIR/storage-helper-policy-create.yaml"
  local pod_json policy_json read_only_pod_json mutated_json mutation
  reset_stub
  seed_restore_lock
  seed_stale_restore_helper
  cp "$STUB_STATE_DIR/applied.yaml" "$pod_fixture"
  cp "$STUB_STATE_DIR/network-policy.yaml" "$policy_fixture"

  reset_stub
  seed_restore_lock
  policy_json="$(
    kubectl --context fixture-context --request-timeout=45s \
      create -f - -o json <"$policy_fixture"
  )"
  pod_json="$(
    kubectl --context fixture-context --request-timeout=45s \
      create -f - -o json <"$pod_fixture"
  )"
  expect_success 'direct NetworkPolicy create response arms the exact UID capability' \
    storage_helper_policy_contract "$policy_json"
  expect_success 'direct RW Pod create response accepts Kubernetes boolean omission' \
    storage_helper_pod_contract "$pod_json" false
  if jq -e '
      (.metadata.resourceVersion | type == "string" and length > 0) and
      ((.spec.volumes[0].persistentVolumeClaim.readOnly // false) == false) and
      ((.spec.containers[0].volumeMounts[0].readOnly // false) == false)
    ' >/dev/null <<<"$pod_json" &&
     ! grep -Eq 'get (pod|networkpolicy) ret-storage-' "$KUBECTL_LOG"; then
    pass 'exact create JSON avoids GET and preserves readOnly:false semantics'
  else
    fail 'exact create JSON capability or RW boolean contract' \
      "pod=$pod_json log=$(cat "$KUBECTL_LOG")"
  fi

  pod_json="$(
    kubectl --context fixture-context --request-timeout=45s \
      get pod ret-storage-restore-888888888888 -n hcce -o json
  )"
  policy_json="$(
    kubectl --context fixture-context --request-timeout=45s \
      get networkpolicy ret-storage-restore-deny-888888888888 -n hcce -o json
  )"
  expect_success 'Pod GET readback preserves exact UID, RV and admitted spec' \
    storage_helper_pod_contract "$pod_json" false
  expect_success 'NetworkPolicy GET readback preserves exact UID, RV and admitted spec' \
    storage_helper_policy_contract "$policy_json"
  mutated_json="$(jq -c 'del(.spec.ingress, .spec.egress)' <<<"$policy_json")"
  expect_success 'NetworkPolicy accepts the API server omission of both empty rule lists' \
    storage_helper_policy_contract "$mutated_json"
  mutated_json="$(jq -c 'del(.spec.ingress)' <<<"$policy_json")"
  expect_failure 'NetworkPolicy rejects omission of only one empty rule list' '' \
    storage_helper_policy_contract "$mutated_json"
  mutated_json="$(jq -c '.spec.ingress = null | .spec.egress = null' <<<"$policy_json")"
  expect_failure 'NetworkPolicy rejects explicit null rule lists' '' \
    storage_helper_policy_contract "$mutated_json"
  mutated_json="$(jq -c '.spec.ingress = [{}]' <<<"$policy_json")"
  expect_failure 'NetworkPolicy rejects a nonempty ingress rule' '' \
    storage_helper_policy_contract "$mutated_json"
  expect_failure 'the same omitempty Pod is never accepted as read-only' '' \
    storage_helper_pod_contract "$pod_json" true

  read_only_pod_json="$(jq -c '
    .spec.volumes[0].persistentVolumeClaim.readOnly = true |
    .spec.containers[0].volumeMounts[0].readOnly = true
  ' <<<"$pod_json")"
  expect_success 'exact read-only helper Pod contract is accepted' \
    storage_helper_pod_contract "$read_only_pod_json" true
  for mutation in decoy-mount other-container other-claim subpath; do
    case "$mutation" in
      decoy-mount)
        mutated_json="$(jq -c '
          .spec.volumes += [{name:"decoy",emptyDir:{}}] |
          .spec.containers[0].volumeMounts[0].mountPath = "/not-storage" |
          .spec.containers[0].volumeMounts += [
            {name:"decoy",mountPath:"/storage",readOnly:true}
          ]
        ' <<<"$read_only_pod_json")"
        ;;
      other-container)
        mutated_json="$(jq -c '
          .spec.containers += [{
            name:"sidecar",image:.spec.containers[0].image,
            volumeMounts:[{name:"storage",mountPath:"/mirror",readOnly:true}]
          }]
        ' <<<"$read_only_pod_json")"
        ;;
      other-claim)
        mutated_json="$(jq -c '
          .spec.volumes += [{name:"other",persistentVolumeClaim:{
            claimName:"other-pvc",readOnly:true
          }}] |
          .spec.containers[0].volumeMounts[0].mountPath = "/ret-pvc" |
          .spec.containers[0].volumeMounts += [
            {name:"other",mountPath:"/storage",readOnly:true}
          ]
        ' <<<"$read_only_pod_json")"
        ;;
      subpath)
        mutated_json="$(jq -c '
          .spec.containers[0].volumeMounts[0].subPath = "owned"
        ' <<<"$read_only_pod_json")"
        ;;
    esac
    expect_failure "read-only helper rejects $mutation mount mutation" '' \
      storage_helper_pod_contract "$mutated_json" true
  done

  mutated_json="$(jq -c '
    .spec.containers[0].securityContext += {
      runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,
      seccompProfile:{type:"RuntimeDefault"}
    }
  ' <<<"$pod_json")"
  expect_success 'container may repeat the exact inherited nonroot identity' \
    storage_helper_pod_contract "$mutated_json" false
  for mutation in run-as-user run-as-group run-as-root unconfined-seccomp unknown-key; do
    case "$mutation" in
      run-as-user)
        mutated_json="$(jq -c \
          '.spec.containers[0].securityContext.runAsUser = 0' <<<"$pod_json")"
        ;;
      run-as-group)
        mutated_json="$(jq -c \
          '.spec.containers[0].securityContext.runAsGroup = 0' <<<"$pod_json")"
        ;;
      run-as-root)
        mutated_json="$(jq -c \
          '.spec.containers[0].securityContext.runAsNonRoot = false' <<<"$pod_json")"
        ;;
      unconfined-seccomp)
        mutated_json="$(jq -c \
          '.spec.containers[0].securityContext.seccompProfile = {type:"Unconfined"}' \
          <<<"$pod_json")"
        ;;
      unknown-key)
        mutated_json="$(jq -c \
          '.spec.containers[0].securityContext.unexpected = true' <<<"$pod_json")"
        ;;
    esac
    expect_failure "Pod capability rejects container $mutation mutation" '' \
      storage_helper_pod_contract "$mutated_json" false
  done

  for mutation in api-version kind resource-version finalizer owner-reference deleting; do
    case "$mutation" in
      api-version) mutated_json="$(jq -c '.apiVersion = "apps/v1"' <<<"$pod_json")" ;;
      kind) mutated_json="$(jq -c '.kind = "ConfigMap"' <<<"$pod_json")" ;;
      resource-version) mutated_json="$(jq -c '.metadata.resourceVersion = ""' <<<"$pod_json")" ;;
      finalizer) mutated_json="$(jq -c '.metadata.finalizers = ["foreign/finalizer"]' <<<"$pod_json")" ;;
      owner-reference) mutated_json="$(jq -c '.metadata.ownerReferences = [{uid:"foreign-uid"}]' <<<"$pod_json")" ;;
      deleting) mutated_json="$(jq -c '.metadata.deletionTimestamp = "2026-07-20T00:00:00Z"' <<<"$pod_json")" ;;
    esac
    expect_failure "Pod capability rejects $mutation mutation" '' \
      storage_helper_pod_contract "$mutated_json" false
  done

  for mutation in api-version kind resource-version finalizer owner-reference deleting; do
    case "$mutation" in
      api-version) mutated_json="$(jq -c '.apiVersion = "v1"' <<<"$policy_json")" ;;
      kind) mutated_json="$(jq -c '.kind = "Service"' <<<"$policy_json")" ;;
      resource-version) mutated_json="$(jq -c 'del(.metadata.resourceVersion)' <<<"$policy_json")" ;;
      finalizer) mutated_json="$(jq -c '.metadata.finalizers = ["foreign/finalizer"]' <<<"$policy_json")" ;;
      owner-reference) mutated_json="$(jq -c '.metadata.ownerReferences = [{uid:"foreign-uid"}]' <<<"$policy_json")" ;;
      deleting) mutated_json="$(jq -c '.metadata.deletionTimestamp = "2026-07-20T00:00:00Z"' <<<"$policy_json")" ;;
    esac
    expect_failure "NetworkPolicy capability rejects $mutation mutation" '' \
      storage_helper_policy_contract "$mutated_json"
  done

  for mutation in policy pod; do
    reset_stub
    seed_restore_lock
    if [[ "$mutation" == pod ]]; then
      kubectl --context fixture-context --request-timeout=45s \
        create -f - -o json <"$policy_fixture" >/dev/null
    fi
    if STUB_MODE="helper-$mutation-create-lost-response" \
      kubectl --context fixture-context --request-timeout=45s \
        create -f - -o json \
        <"$([[ "$mutation" == policy ]] && printf '%s' "$policy_fixture" || \
          printf '%s' "$pod_fixture")" >/dev/null 2>&1; then
      fail "$mutation lost-response stub returns an ambiguous failure" \
        'create unexpectedly succeeded'
    else
      pass "$mutation lost-response stub returns an ambiguous failure"
    fi
    if [[ "$mutation" == policy ]]; then
      policy_json="$(
        STUB_MODE="helper-$mutation-create-lost-response" \
          kubectl --context fixture-context --request-timeout=45s \
          get networkpolicy ret-storage-restore-deny-888888888888 \
          -n hcce -o json
      )"
      expect_success 'policy lost response leaves one exact reconcilable capability' \
        storage_helper_policy_contract "$policy_json"
    else
      pod_json="$(
        STUB_MODE="helper-$mutation-create-lost-response" \
          kubectl --context fixture-context --request-timeout=45s \
          get pod ret-storage-restore-888888888888 -n hcce -o json
      )"
      expect_success 'pod lost response leaves one exact reconcilable capability' \
        storage_helper_pod_contract "$pod_json" false
    fi

    reset_stub
    seed_restore_lock
    if [[ "$mutation" == pod ]]; then
      kubectl --context fixture-context --request-timeout=45s \
        create -f - -o json <"$policy_fixture" >/dev/null
    fi
    if STUB_MODE="helper-$mutation-create-decoy" \
      kubectl --context fixture-context --request-timeout=45s \
        create -f - -o json \
        <"$([[ "$mutation" == policy ]] && printf '%s' "$policy_fixture" || \
          printf '%s' "$pod_fixture")" >/dev/null 2>&1; then
      fail "$mutation decoy stub returns an ambiguous failure" \
        'create unexpectedly succeeded'
    else
      pass "$mutation decoy stub returns an ambiguous failure"
    fi
    if [[ "$mutation" == policy ]]; then
      policy_json="$(
        STUB_MODE="helper-$mutation-create-decoy" \
          kubectl --context fixture-context --request-timeout=45s \
          get networkpolicy ret-storage-restore-deny-888888888888 \
          -n hcce -o json
      )"
      expect_failure 'same-name policy decoy is not a reconcilable capability' '' \
        storage_helper_policy_contract "$policy_json"
    else
      pod_json="$(
        STUB_MODE="helper-$mutation-create-decoy" \
          kubectl --context fixture-context --request-timeout=45s \
          get pod ret-storage-restore-888888888888 -n hcce -o json
      )"
      expect_failure 'same-name pod decoy is not a reconcilable capability' '' \
        storage_helper_pod_contract "$pod_json" false
    fi
    if ! grep -q 'delete --raw=' "$KUBECTL_LOG"; then
      pass "$mutation decoy remains untouched without UID authority"
    else
      fail "$mutation decoy was deleted without UID authority" \
        "$(cat "$KUBECTL_LOG")"
    fi
  done
}

run_parent_death_stream_test() {
  local parent_death_owner_pid="" parent_death_rv_before parent_death_rv_after
  local parent_death_grandchild_pid parent_death_grandchild_state
  local parent_death_stream_pid parent_death_stream_pgid
  local parent_death_stream_group_state
  reset_stub
  # shellcheck disable=SC2016 # Expanded by the isolated owner process.
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_MODE=parent-death-stream \
    RECOVERY_LEASE_HEARTBEAT_SECONDS=1 RECOVERY_STREAM_POLL_SECONDS=0.01 \
    bash -c '
      set -euo pipefail
      NAMESPACE=hcce
      source "$1"
      recovery_acquire_operation_serialization root-recovery
      recovery_kubectl_stream_mutate 30 exec -n hcce parent-death-probe -- destructive-stream
      printf completed >"$2/parent-death-owner-completed"
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$STUB_STATE_DIR" &
  # shellcheck disable=SC2031 # This shell owns the isolated owner PID.
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
    return
  fi
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
  parent_death_stream_pid="$(cat \
    "$STUB_STATE_DIR/parent-death-stream-pid" 2>/dev/null || :)"
  parent_death_stream_pgid="$(cat \
    "$STUB_STATE_DIR/parent-death-stream-pgid" 2>/dev/null || :)"
  parent_death_grandchild_state=""
  parent_death_stream_group_state=""
  # The supervisor intentionally grants the process group two seconds to honor
  # TERM before KILL. Verify the exact recorded PGID as well as its resistant
  # descendant so an ordinary kubectl fixture cannot survive reparented.
  for _ in {1..400}; do
    parent_death_grandchild_state="$(
      ps -o stat= -p "$parent_death_grandchild_pid" 2>/dev/null |
        awk '{$1=$1; print}' || :
    )"
    parent_death_stream_group_state="$(
      ps -axo pgid=,stat=,pid= 2>/dev/null |
        awk -v pgid="$parent_death_stream_pgid" \
          '$1 == pgid && $2 !~ /^Z/ {print $2 ":" $3; exit}' || :
    )"
    if [[ ( -z "$parent_death_grandchild_state" ||
            "$parent_death_grandchild_state" == Z* ) &&
          -z "$parent_death_stream_group_state" ]]; then
      break
    fi
    sleep 0.01
  done
  parent_death_rv_after="$(jq -r '.metadata.resourceVersion' \
    "$STUB_STATE_DIR/serialization-lease.json")"
  if [[ -e "$STUB_STATE_DIR/parent-death-stream-terminated" &&
        ! -e "$STUB_STATE_DIR/parent-death-stream-completed" &&
        ! -e "$STUB_STATE_DIR/parent-death-owner-completed" &&
        "$parent_death_rv_before" == "$parent_death_rv_after" &&
        "$parent_death_stream_pid" =~ ^[1-9][0-9]*$ &&
        "$parent_death_stream_pgid" =~ ^[1-9][0-9]*$ &&
        -z "$parent_death_stream_group_state" &&
        "$parent_death_grandchild_pid" =~ ^[1-9][0-9]*$ &&
        ( -z "$parent_death_grandchild_state" ||
          "$parent_death_grandchild_state" == Z* ) ]]; then
    pass 'parent SIGKILL kills orphaned stream group and stops Lease renewal'
  else
    fail 'parent SIGKILL kills orphaned stream group and stops Lease renewal' \
      "rv-before=$parent_death_rv_before rv-after=$parent_death_rv_after stream=$parent_death_stream_pid pgid=$parent_death_stream_pgid group-state=${parent_death_stream_group_state:-gone} grandchild=$parent_death_grandchild_pid state=$parent_death_grandchild_state"
  fi
}

STREAM_GUARD_FIXTURE_PUBLISHER_PID=""
start_stream_guard_fixture_publisher() {
  local progress_marker="$1" stop_marker="$2" initial_delay="$3"
  local interval="$4" maximum_increments="$5" start_marker="${6:-}"
  local publication_prefix="${7:-}" frozen_marker="${8:-}"
  python3 - "$progress_marker" "$stop_marker" "$initial_delay" \
    "$interval" "$maximum_increments" "$start_marker" \
    "$publication_prefix" "$frozen_marker" <<'PY' &
import os
import sys
import time

(
    progress_path,
    stop_path,
    initial_text,
    interval_text,
    maximum_text,
    start_path,
    publication_prefix,
    frozen_path,
) = sys.argv[1:]
initial_delay = float(initial_text)
interval = float(interval_text)
maximum = int(maximum_text)
counter = int(open(progress_path, encoding="utf-8").read().strip())
published = 0


def publish_private(path, value):
    if not path or os.path.exists(path):
        return
    next_path = f"{path}.publisher-next"
    with open(next_path, "w", encoding="utf-8") as marker:
        marker.write(f"{value}\n")
    os.chmod(next_path, 0o600)
    os.replace(next_path, path)


while start_path and not os.path.exists(start_path):
    if os.path.exists(stop_path):
        sys.exit(0)
    time.sleep(0.01)
deadline = time.monotonic() + initial_delay
while not os.path.exists(stop_path):
    if maximum == 0 or published < maximum:
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(remaining, 0.01))
            continue
        counter += 1
        next_path = f"{progress_path}.publisher-next"
        with open(next_path, "w", encoding="utf-8") as marker:
            marker.write(f"{counter}\n")
        os.chmod(next_path, 0o600)
        os.replace(next_path, progress_path)
        published += 1
        if publication_prefix:
            publish_private(f"{publication_prefix}-published-{published}", counter)
        deadline += interval
    else:
        publish_private(frozen_path, counter)
        time.sleep(0.01)
PY
  # shellcheck disable=SC2031 # This shell owns the fixture publisher PID.
  STREAM_GUARD_FIXTURE_PUBLISHER_PID=$!
}

stream_guard_fixture_start_identity() {
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  bash -c '
    set -euo pipefail
    source "$1"
    recovery_process_start_identity "$2"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$1"
}

run_multi_guard_round_robin_case() (
  local case_name="$1" guard_dir observation_dir stop_marker
  local failure_one progress_one failure_two progress_two
  local failure_three progress_three
  local pid_one="" pid_two="" pid_three=""
  local identity_one="" identity_two="" identity_three=""
  local status=0 publishers_stopped=0 maximum_stale_seconds=3
  local progress_value_one progress_value_two progress_value_three publisher_pid
  local inner_baseline_value=""
  guard_dir="$(mktemp -d "$TMP_DIR/multi-stream-guards.XXXXXX")" || return 1
  chmod 700 "$guard_dir"
  observation_dir="$guard_dir/observations"
  mkdir -m 700 "$observation_dir"
  stop_marker="$guard_dir/stop"
  failure_one="$guard_dir/guard-one.failure"
  progress_one="$guard_dir/guard-one.progress"
  failure_two="$guard_dir/guard-two.failure"
  progress_two="$guard_dir/guard-two.progress"
  failure_three="$guard_dir/guard-three.failure"
  progress_three="$guard_dir/guard-three.progress"
  : >"$failure_one"
  : >"$failure_two"
  : >"$failure_three"
  printf '1\n' >"$progress_one"
  printf '1\n' >"$progress_two"
  printf '1\n' >"$progress_three"
  chmod 600 "$failure_one" "$progress_one" "$failure_two" \
    "$progress_two" "$failure_three" "$progress_three"

  cleanup_stream_guard_fixture_publishers() {
    local publisher_pid publisher_status=0
    [[ "$publishers_stopped" == 0 ]] || return 0
    publishers_stopped=1
    printf 'stop\n' >"$stop_marker"
    chmod 600 "$stop_marker"
    for publisher_pid in "$pid_one" "$pid_two" "$pid_three"; do
      [[ "$publisher_pid" =~ ^[1-9][0-9]*$ ]] || continue
      if wait "$publisher_pid"; then :; else publisher_status=1; fi
    done
    return "$publisher_status"
  }
  trap 'cleanup_stream_guard_fixture_publishers || :' EXIT INT TERM

  case "$case_name" in
    round-robin-success)
      # Every publisher starts only after its initial baseline read. The slow
      # guard then leaves 4.5 seconds between counters 2 and 3 while both fast
      # guards continue at 0.15/0.20 seconds. A serial refresher reaches the
      # slow result with less than the mandatory two-second cancellation
      # reserve; foreground round-robin observations keep both fast lower
      # bounds current. Production remains fixed at ten seconds by the timing
      # contract; only this attested fixture uses six.
      maximum_stale_seconds=6
      start_stream_guard_fixture_publisher "$progress_one" "$stop_marker" \
        0.10 0.15 0 "$observation_dir/guard-one-baseline-read"
      pid_one="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      start_stream_guard_fixture_publisher "$progress_two" "$stop_marker" \
        0.10 0.20 0 "$observation_dir/guard-two-baseline-read"
      pid_two="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      start_stream_guard_fixture_publisher "$progress_three" "$stop_marker" \
        0.15 4.50 0 "$observation_dir/guard-three-baseline-read" \
        "$observation_dir/slow"
      pid_three="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      ;;
    no-simultaneous-window)
      # Each live publisher advances at most once. The first guard is stale
      # before the final guard can advance, so there is no simultaneous fresh
      # window from which a destructive stream may be launched.
      start_stream_guard_fixture_publisher "$progress_one" "$stop_marker" \
        0.40 1 1 "$observation_dir/guard-one-baseline-read"
      pid_one="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      start_stream_guard_fixture_publisher "$progress_two" "$stop_marker" \
        1.80 1 1 "$observation_dir/guard-two-baseline-read"
      pid_two="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      start_stream_guard_fixture_publisher "$progress_three" "$stop_marker" \
        3.70 1 1 "$observation_dir/guard-three-baseline-read"
      pid_three="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      ;;
    inner-baseline)
      # Guard three publishes 2, 3 and 4 only after its first outer read, then
      # freezes. Guard one cannot advance until that freeze exists, so the
      # outer round completes with guard three exactly at 4. The observation
      # wrapper must prove refresh_supervised_stream_guards_for_launch read 4
      # as its inner baseline before the expected fail-closed timeout.
      start_stream_guard_fixture_publisher "$progress_one" "$stop_marker" \
        0.10 0.15 0 "$observation_dir/guard-three-frozen"
      pid_one="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      start_stream_guard_fixture_publisher "$progress_two" "$stop_marker" \
        0.10 0.20 0 "$observation_dir/guard-two-baseline-read"
      pid_two="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      start_stream_guard_fixture_publisher "$progress_three" "$stop_marker" \
        0.05 0.05 3 "$observation_dir/guard-three-baseline-read" \
        "$observation_dir/guard-three" "$observation_dir/guard-three-frozen"
      pid_three="$STREAM_GUARD_FIXTURE_PUBLISHER_PID"
      ;;
    *) return 2 ;;
  esac

  identity_one="$(stream_guard_fixture_start_identity "$pid_one")" || return 1
  identity_two="$(stream_guard_fixture_start_identity "$pid_two")" || return 1
  identity_three="$(stream_guard_fixture_start_identity "$pid_three")" || return 1
  reset_stub
  # shellcheck disable=SC2016 # Guard variables expand in the isolated Bash.
  if env EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    STUB_MODE=multi-guard-stream RECOVERY_STREAM_POLL_SECONDS=0.02 \
    GUARD_ONE_PID="$pid_one" GUARD_ONE_IDENTITY="$identity_one" \
    GUARD_ONE_FAILURE="$failure_one" GUARD_ONE_PROGRESS="$progress_one" \
    GUARD_TWO_PID="$pid_two" GUARD_TWO_IDENTITY="$identity_two" \
    GUARD_TWO_FAILURE="$failure_two" GUARD_TWO_PROGRESS="$progress_two" \
    GUARD_THREE_PID="$pid_three" GUARD_THREE_IDENTITY="$identity_three" \
    GUARD_THREE_FAILURE="$failure_three" GUARD_THREE_PROGRESS="$progress_three" \
    GUARD_MAX_STALE_SECONDS="$maximum_stale_seconds" \
    MULTI_GUARD_CASE="$case_name" GUARD_OBSERVATION_DIR="$observation_dir" \
    bash -c '
      set -euo pipefail
      NAMESPACE=hcce
      source "$1"
      progress_reader_definition="$(declare -f recovery_stream_guard_progress_value)"
      progress_reader_definition="${progress_reader_definition/recovery_stream_guard_progress_value/recovery_stream_guard_progress_value_fixture_original}"
      eval "$progress_reader_definition"
      unset progress_reader_definition
      fixture_publish_guard_observation_once() {
        local marker_path="$1" marker_value="$2"
        local next_path="${marker_path}.next.$$"
        [[ ! -e "$marker_path" && ! -L "$marker_path" ]] || return 0
        (umask 077; printf "%s\n" "$marker_value" >"$next_path") || return 1
        chmod 600 "$next_path" || { rm -f -- "$next_path"; return 1; }
        mv -f -- "$next_path" "$marker_path"
      }
      recovery_stream_guard_progress_value() {
        local progress_path="$1" progress_value guard_name function_stack
        if ! progress_value="$(
          recovery_stream_guard_progress_value_fixture_original "$@"
        )"; then
          return 1
        fi
        case "$progress_path" in
          "$GUARD_ONE_PROGRESS") guard_name=guard-one ;;
          "$GUARD_TWO_PROGRESS") guard_name=guard-two ;;
          "$GUARD_THREE_PROGRESS") guard_name=guard-three ;;
          *) return 2 ;;
        esac
        fixture_publish_guard_observation_once \
          "$GUARD_OBSERVATION_DIR/$guard_name-baseline-read" \
          "$progress_value" || return 1
        function_stack=" ${FUNCNAME[*]} "
        if [[ "$MULTI_GUARD_CASE" == round-robin-success ]]; then
          if [[ "$guard_name" == guard-three && "$progress_value" == 2 &&
                "$function_stack" == *" refresh_supervised_stream_guards_for_launch "* &&
                -e "$GUARD_OBSERVATION_DIR/slow-published-1" &&
                ! -e "$GUARD_OBSERVATION_DIR/slow-published-2" ]]; then
            fixture_publish_guard_observation_once \
              "$GUARD_OBSERVATION_DIR/slow-inner-wait-started" \
              "$progress_value" || return 1
          elif [[ ( "$guard_name" == guard-one ||
                    "$guard_name" == guard-two ) &&
                  -e "$GUARD_OBSERVATION_DIR/slow-inner-wait-started" &&
                  ! -e "$GUARD_OBSERVATION_DIR/slow-published-2" ]]; then
            fixture_publish_guard_observation_once \
              "$GUARD_OBSERVATION_DIR/$guard_name-observed-during-slow-gap" \
              "$progress_value" || return 1
          fi
        elif [[ "$MULTI_GUARD_CASE" == inner-baseline &&
                "$guard_name" == guard-three &&
                -e "$GUARD_OBSERVATION_DIR/guard-three-frozen" &&
                "$function_stack" == *" refresh_supervised_stream_guards_for_launch "* ]]; then
          fixture_publish_guard_observation_once \
            "$GUARD_OBSERVATION_DIR/guard-three-inner-baseline-read" \
            "$progress_value" || return 1
        fi
        printf "%s\n" "$progress_value"
      }
      recovery_kubectl_stream_supervised 0 30 \
        --guard-process "$GUARD_ONE_PID" "$GUARD_ONE_IDENTITY" \
          "$GUARD_ONE_FAILURE" "$GUARD_ONE_PROGRESS" "$GUARD_MAX_STALE_SECONDS" \
        --guard-process "$GUARD_TWO_PID" "$GUARD_TWO_IDENTITY" \
          "$GUARD_TWO_FAILURE" "$GUARD_TWO_PROGRESS" "$GUARD_MAX_STALE_SECONDS" \
        --guard-process "$GUARD_THREE_PID" "$GUARD_THREE_IDENTITY" \
          "$GUARD_THREE_FAILURE" "$GUARD_THREE_PROGRESS" "$GUARD_MAX_STALE_SECONDS" -- \
        exec -n hcce parent-death-probe -- destructive-stream
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"; then
    status=0
  else
    status=$?
  fi
  progress_value_one="$(<"$progress_one")"
  progress_value_two="$(<"$progress_two")"
  progress_value_three="$(<"$progress_three")"
  inner_baseline_value="$(cat \
    "$observation_dir/guard-three-inner-baseline-read" 2>/dev/null || :)"
  cleanup_stream_guard_fixture_publishers || return 1
  trap - EXIT INT TERM
  for publisher_pid in "$pid_one" "$pid_two" "$pid_three"; do
    ! kill -0 "$publisher_pid" 2>/dev/null || return 1
  done

  case "$case_name" in
    round-robin-success)
      if [[ "$status" == 0 &&
            -e "$STUB_STATE_DIR/multi-guard-stream-started" &&
            -e "$STUB_STATE_DIR/multi-guard-stream-completed" &&
            "$progress_value_one" =~ ^[0-9]+$ &&
            "$progress_value_two" =~ ^[0-9]+$ &&
            "$progress_value_three" =~ ^[0-9]+$ &&
            "$progress_value_one" -ge 10 && "$progress_value_two" -ge 8 &&
            "$progress_value_three" -ge 3 &&
            -e "$observation_dir/slow-published-1" &&
            -e "$observation_dir/slow-published-2" &&
            -e "$observation_dir/slow-inner-wait-started" &&
            -e "$observation_dir/guard-one-observed-during-slow-gap" &&
            -e "$observation_dir/guard-two-observed-during-slow-gap" ]]; then
        return 0
      fi
      ;;
    no-simultaneous-window)
      if [[ "$status" != 0 &&
            ! -e "$STUB_STATE_DIR/multi-guard-stream-started" &&
            ! -e "$STUB_STATE_DIR/multi-guard-stream-completed" &&
            "$progress_value_one" == 2 && "$progress_value_two" == 2 &&
            "$progress_value_three" == 1 ]]; then
        return 0
      fi
      ;;
    inner-baseline)
      if [[ "$status" != 0 &&
            ! -e "$STUB_STATE_DIR/multi-guard-stream-started" &&
            ! -e "$STUB_STATE_DIR/multi-guard-stream-completed" &&
            "$progress_value_three" == 4 &&
            -e "$observation_dir/guard-three-frozen" &&
            "$inner_baseline_value" == 4 ]]; then
        return 0
      fi
      ;;
  esac
  printf 'case=%s status=%s started=%s completed=%s progress=%s,%s,%s observations=%s\n' \
    "$case_name" "$status" \
    "$([[ -e "$STUB_STATE_DIR/multi-guard-stream-started" ]] && printf yes || printf no)" \
    "$([[ -e "$STUB_STATE_DIR/multi-guard-stream-completed" ]] && printf yes || printf no)" \
    "$progress_value_one" "$progress_value_two" "$progress_value_three" \
    "$(find "$observation_dir" -maxdepth 1 -type f -exec basename {} \; | sort | tr '\n' ',')" >&2
  return 1
)

run_multi_guard_stream_regression_tests() {
  expect_success \
    'three heterogeneous guards launch and complete only through round-robin freshness' \
    run_multi_guard_round_robin_case round-robin-success
  expect_success \
    'one-shot guards with no simultaneous fresh window cannot launch a stream' \
    run_multi_guard_round_robin_case no-simultaneous-window
  expect_success \
    'a later guard increment predating the inner baseline cannot create false freshness' \
    run_multi_guard_round_robin_case inner-baseline
}

run_stream_guard_abort_tests() {
  local guard_mode failure_marker progress_marker guard_pid guard_start_identity
  local grandchild_pid grandchild_state started_path terminated_path completed_path
  local elapsed_path elapsed_milliseconds lease_timeout_log
  local stream_started_milliseconds stream_terminated_milliseconds
  local stream_elapsed_milliseconds timing_within_deadline
  for guard_mode in marker exit stale; do
    reset_stub
    failure_marker="$TMP_DIR/stream-guard-$guard_mode.failure"
    progress_marker="$TMP_DIR/stream-guard-$guard_mode.progress"
    : >"$failure_marker"
    printf '1\n' >"$progress_marker"
    chmod 600 "$failure_marker" "$progress_marker"
    started_path="$STUB_STATE_DIR/guard-failure-stream-started"
    terminated_path="$STUB_STATE_DIR/guard-failure-stream-terminated"
    completed_path="$STUB_STATE_DIR/guard-failure-stream-completed"
    python3 - "$guard_mode" "$started_path" "$failure_marker" \
      "$progress_marker" <<'PY' &
import os
import sys
import time

mode, started_path, failure_marker, progress_marker = sys.argv[1:]
deadline = time.monotonic() + 10
progress = 1
while not os.path.exists(started_path):
    if time.monotonic() >= deadline:
        sys.exit(2)
    progress += 1
    next_marker = f"{progress_marker}.next"
    with open(next_marker, "w", encoding="utf-8") as marker:
        marker.write(f"{progress}\n")
    os.chmod(next_marker, 0o600)
    os.replace(next_marker, progress_marker)
    time.sleep(0.01)
if mode == "marker":
    with open(failure_marker, "w", encoding="utf-8") as marker:
        marker.write("guard_failed\n")
    time.sleep(30)
elif mode == "stale":
    time.sleep(30)
PY
    # shellcheck disable=SC2031 # PID belongs to this top-level test shell.
    guard_pid=$!
    guard_start_identity="$(
      # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
      env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
        set -euo pipefail
        source "$1"
        recovery_process_start_identity "$2"
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$guard_pid"
    )"
    # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
    expect_failure "supervised stream aborts when its $guard_mode guard fails" '' \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_MODE=guard-failure-stream \
      RECOVERY_STREAM_POLL_SECONDS=0.01 bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        source "$1"
        recovery_kubectl_stream_supervised 0 30 \
          --guard-process "$2" "$3" "$4" "$5" 3 -- \
          exec -n hcce parent-death-probe -- destructive-stream
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$guard_pid" \
        "$guard_start_identity" "$failure_marker" "$progress_marker"
    kill -TERM "$guard_pid" 2>/dev/null || :
    wait "$guard_pid" 2>/dev/null || :
    grandchild_pid="$(cat \
      "$STUB_STATE_DIR/guard-failure-grandchild-pid" 2>/dev/null || :)"
    grandchild_state=""
    for _ in {1..400}; do
      grandchild_state="$(
        ps -o stat= -p "$grandchild_pid" 2>/dev/null |
          awk '{$1=$1; print}' || :
      )"
      [[ -n "$grandchild_state" && "$grandchild_state" != Z* ]] || break
      sleep 0.01
    done
    if [[ -e "$started_path" && -e "$terminated_path" &&
          ! -e "$completed_path" &&
          "$grandchild_pid" =~ ^[1-9][0-9]*$ &&
          ( -z "$grandchild_state" || "$grandchild_state" == Z* ) ]]; then
      pass "$guard_mode guard failure reaps kubectl and its isolated descendant group"
    else
      fail "$guard_mode guard failure left stream capability or completion behind" \
        "supervisor=${LAST_OUTPUT:-empty} started=$([[ -e "$started_path" ]] && printf yes || printf no) terminated=$([[ -e "$terminated_path" ]] && printf yes || printf no) completed=$([[ -e "$completed_path" ]] && printf yes || printf no) grandchild=${grandchild_pid:-missing} state=${grandchild_state:-gone}"
    fi
  done

  reset_stub
  started_path="$STUB_STATE_DIR/guard-failure-stream-started"
  terminated_path="$STUB_STATE_DIR/guard-failure-stream-terminated"
  completed_path="$STUB_STATE_DIR/guard-failure-stream-completed"
  # shellcheck disable=SC2016 # The isolated shell deliberately overrides one probe.
  expect_failure 'supervised stream fails closed on a post-launch identity-probe failure' '' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_MODE=guard-failure-stream \
      RECOVERY_STREAM_POLL_SECONDS=0.01 bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        started_path="$2"
        source "$1"
        recovery_process_identity_is_live() {
          local pid="$1" expected_start="$2" current_start
          kill -0 "$pid" 2>/dev/null || return 1
          if [[ "$pid" != "$$" && -e "$started_path" ]]; then
            return 1
          fi
          current_start="$(recovery_process_start_identity "$pid")" || return 1
          [[ "$current_start" == "$expected_start" ]]
        }
        recovery_kubectl_stream_supervised 0 30 -- \
          exec -n hcce parent-death-probe -- destructive-stream
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$started_path"
  grandchild_pid="$(cat \
    "$STUB_STATE_DIR/guard-failure-grandchild-pid" 2>/dev/null || :)"
  grandchild_state=""
  for _ in {1..400}; do
    grandchild_state="$(
      ps -o stat= -p "$grandchild_pid" 2>/dev/null |
        awk '{$1=$1; print}' || :
    )"
    [[ -n "$grandchild_state" && "$grandchild_state" != Z* ]] || break
    sleep 0.01
  done
  if [[ -e "$started_path" && -e "$terminated_path" &&
        ! -e "$completed_path" &&
        "$grandchild_pid" =~ ^[1-9][0-9]*$ &&
        ( -z "$grandchild_state" || "$grandchild_state" == Z* ) ]]; then
    pass 'post-launch identity probe failure reaps the owned stream group'
  else
    fail 'post-launch identity probe failure left an unsupervised stream' \
      "supervisor=${LAST_OUTPUT:-empty} started=$([[ -e "$started_path" ]] && printf yes || printf no) terminated=$([[ -e "$terminated_path" ]] && printf yes || printf no) completed=$([[ -e "$completed_path" ]] && printf yes || printf no) grandchild=${grandchild_pid:-missing} state=${grandchild_state:-gone}"
  fi

  reset_stub
  failure_marker="$TMP_DIR/stream-guard-slow-lease.failure"
  progress_marker="$TMP_DIR/stream-guard-slow-lease.progress"
  elapsed_path="$TMP_DIR/stream-guard-slow-lease.elapsed"
  lease_timeout_log="$TMP_DIR/stream-guard-slow-lease.timeouts"
  : >"$failure_marker"
  printf '1\n' >"$progress_marker"
  : >"$lease_timeout_log"
  chmod 600 "$failure_marker" "$progress_marker" "$lease_timeout_log"
  started_path="$STUB_STATE_DIR/guard-failure-stream-started"
  terminated_path="$STUB_STATE_DIR/guard-failure-stream-terminated"
  completed_path="$STUB_STATE_DIR/guard-failure-stream-completed"
  python3 - "$started_path" "$progress_marker" <<'PY' &
import os
import sys
import time

started_path, progress_marker = sys.argv[1:]
deadline = time.monotonic() + 10
progress = 1
while not os.path.exists(started_path):
    if time.monotonic() >= deadline:
        sys.exit(2)
    progress += 1
    next_marker = f"{progress_marker}.next"
    with open(next_marker, "w", encoding="utf-8") as marker:
        marker.write(f"{progress}\n")
    os.chmod(next_marker, 0o600)
    os.replace(next_marker, progress_marker)
    time.sleep(0.01)
time.sleep(30)
PY
  # shellcheck disable=SC2031 # PID belongs to this top-level test shell.
  guard_pid=$!
  guard_start_identity="$(
    # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
    bash -c 'source "$1"; recovery_process_start_identity "$2"' _ \
      "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$guard_pid"
  )"
  # shellcheck disable=SC2016 # Functions intentionally simulate a slow Lease API.
  expect_failure 'slow Lease checks cannot consume the guard cancellation budget' '' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_MODE=guard-failure-stream \
      RECOVERY_STREAM_POLL_SECONDS=0.01 bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        source "$1"
        started_path="$6"
        elapsed_path="$7"
        lease_timeout_log="$8"
        recovery_require_operation_serialization_stream() {
          local timeout_seconds="${1:-5}"
          printf "%s\n" "$timeout_seconds" >>"$lease_timeout_log"
          if [[ -e "$started_path" ]]; then sleep "$timeout_seconds"; fi
        }
        started_milliseconds="$(recovery_monotonic_milliseconds)"
        stream_status=0
        recovery_kubectl_stream_supervised 1 30 \
          --guard-process "$2" "$3" "$4" "$5" 5 -- \
          exec -n hcce parent-death-probe -- destructive-stream || stream_status=$?
        finished_milliseconds="$(recovery_monotonic_milliseconds)"
        printf "%s\n" "$((finished_milliseconds - started_milliseconds))" \
          >"$elapsed_path"
        exit "$stream_status"
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$guard_pid" \
        "$guard_start_identity" "$failure_marker" "$progress_marker" \
        "$started_path" "$elapsed_path" "$lease_timeout_log"
  kill -TERM "$guard_pid" 2>/dev/null || :
  wait "$guard_pid" 2>/dev/null || :
  grandchild_pid="$(cat \
    "$STUB_STATE_DIR/guard-failure-grandchild-pid" 2>/dev/null || :)"
  grandchild_state=""
  for _ in {1..400}; do
    grandchild_state="$(
      ps -o stat= -p "$grandchild_pid" 2>/dev/null |
        awk '{$1=$1; print}' || :
    )"
    [[ -n "$grandchild_state" && "$grandchild_state" != Z* ]] || break
    sleep 0.01
  done
  elapsed_milliseconds="$(cat "$elapsed_path" 2>/dev/null || :)"
  stream_started_milliseconds="$(cat "$started_path" 2>/dev/null || :)"
  stream_terminated_milliseconds="$(cat "$terminated_path" 2>/dev/null || :)"
  if [[ "$stream_started_milliseconds" =~ ^[0-9]+$ &&
        "$stream_terminated_milliseconds" =~ ^[0-9]+$ ]]; then
    stream_elapsed_milliseconds=$((
      stream_terminated_milliseconds - stream_started_milliseconds
    ))
  else
    stream_elapsed_milliseconds=""
  fi
  timing_within_deadline=false
  if [[ "$elapsed_milliseconds" =~ ^[0-9]+$ &&
        "$stream_elapsed_milliseconds" =~ ^-?[0-9]+$ ]]; then
    if ((stream_elapsed_milliseconds >= 0 &&
         stream_elapsed_milliseconds < 5000)); then
      timing_within_deadline=true
    elif ((stream_elapsed_milliseconds == -1 &&
           elapsed_milliseconds < 5000)); then
      # The fixture publishes these two millisecond readings from separate
      # Python interpreters and has observed them one millisecond out of order
      # under scheduling pressure. In that exact case, the independently timed
      # whole call is stricter: it begins before launch and ends after reap.
      timing_within_deadline=true
    fi
  fi
  if [[ "$timing_within_deadline" == true ]] &&
     awk 'NF != 1 || $1 !~ /^[1-5]$/ || $1 > 2 { exit 1 }
          END { if (NR < 2) exit 1 }' "$lease_timeout_log" &&
     [[ -e "$started_path" && -e "$terminated_path" &&
        ! -e "$completed_path" &&
        "$grandchild_pid" =~ ^[1-9][0-9]*$ &&
        ( -z "$grandchild_state" || "$grandchild_state" == Z* ) ]]; then
    pass 'slow Lease guard loss is revoked and reaped inside its stale deadline'
  else
    fail 'slow Lease guard loss exceeded its end-to-end stale deadline' \
      "call-elapsed=${elapsed_milliseconds:-missing} stream-elapsed=${stream_elapsed_milliseconds:-missing} timeouts=$(tr '\n' ',' <"$lease_timeout_log") started=$([[ -e "$started_path" ]] && printf yes || printf no) terminated=$([[ -e "$terminated_path" ]] && printf yes || printf no) completed=$([[ -e "$completed_path" ]] && printf yes || printf no) grandchild=${grandchild_pid:-missing} state=${grandchild_state:-gone}"
  fi

  reset_stub
  failure_marker="$TMP_DIR/stream-guard-wrong-identity.failure"
  progress_marker="$TMP_DIR/stream-guard-wrong-identity.progress"
  : >"$failure_marker"
  printf '1\n' >"$progress_marker"
  chmod 600 "$failure_marker" "$progress_marker"
  sleep 30 &
  # shellcheck disable=SC2031 # PID belongs to this top-level test shell.
  guard_pid=$!
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'supervised stream rejects a guard PID with the wrong start identity' '' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_MODE=guard-failure-stream \
    RECOVERY_STREAM_POLL_SECONDS=0.01 bash -c '
      set -euo pipefail
      NAMESPACE=hcce
      source "$1"
      recovery_kubectl_stream_supervised 0 30 \
        --guard-process "$2" wrong-start-identity "$3" "$4" 1 -- \
        exec -n hcce parent-death-probe -- destructive-stream
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$guard_pid" \
      "$failure_marker" "$progress_marker"
  kill -TERM "$guard_pid" 2>/dev/null || :
  wait "$guard_pid" 2>/dev/null || :
  if [[ ! -e "$STUB_STATE_DIR/guard-failure-stream-started" ]]; then
    pass 'wrong guard start identity is rejected before kubectl launch'
  else
    fail 'wrong guard start identity launched kubectl' "$(cat "$KUBECTL_LOG")"
  fi

  reset_stub
  failure_marker="$TMP_DIR/stream-guard-stale.failure"
  progress_marker="$TMP_DIR/stream-guard-stale.progress"
  : >"$failure_marker"
  printf '9\n' >"$progress_marker"
  chmod 600 "$failure_marker" "$progress_marker"
  sleep 30 &
  # shellcheck disable=SC2031 # PID belongs to this top-level test shell.
  guard_pid=$!
  guard_start_identity="$(
    # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
    env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
      set -euo pipefail
      source "$1"
      recovery_process_start_identity "$2"
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$guard_pid"
  )"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'a live guard with only an old unobserved increment cannot launch a stream' '' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_MODE=guard-failure-stream \
      RECOVERY_STREAM_POLL_SECONDS=0.01 bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        source "$1"
        recovery_kubectl_stream_supervised 0 30 \
          --guard-process "$2" "$3" "$4" "$5" 1 -- \
          exec -n hcce parent-death-probe -- destructive-stream
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$guard_pid" \
        "$guard_start_identity" "$failure_marker" "$progress_marker"
  kill -TERM "$guard_pid" 2>/dev/null || :
  wait "$guard_pid" 2>/dev/null || :
  if [[ ! -e "$STUB_STATE_DIR/guard-failure-stream-started" ]]; then
    pass 'stale guard counter is rejected before kubectl launch'
  else
    fail 'stale guard counter launched kubectl' "$(cat "$KUBECTL_LOG")"
  fi
}

stream_writer_capability_is_healthy() {
  # shellcheck disable=SC2016 # Positional arguments expand in the isolated shell.
  bash -c '
    set -euo pipefail
    source "$1"
    authority_json="$(<"$7")"
    EXPECTED_KUBE_CONTEXT="$(jq -er .context <<<"$authority_json")"
    NAMESPACE="$(jq -er .namespace <<<"$authority_json")"
    RECOVERY_NAMESPACE_UID="$(jq -er .namespace_uid <<<"$authority_json")"
    RECOVERY_OPERATION_ID="$(jq -er .operation_id <<<"$authority_json")"
    RECOVERY_OPERATION_OWNER="$(jq -er .operation_owner <<<"$authority_json")"
    RECOVERY_OPERATION_LOCK_NAME="$(jq -er .operation_lock.name <<<"$authority_json")"
    RECOVERY_OPERATION_LOCK_UID="$(jq -er .operation_lock.uid <<<"$authority_json")"
    RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$(
      jq -er .operation_lock.resource_version <<<"$authority_json"
    )"
    RECOVERY_SERIALIZATION_LEASE_NAME="$(jq -er .lease.name <<<"$authority_json")"
    RECOVERY_SERIALIZATION_LEASE_UID="$(jq -er .lease.uid <<<"$authority_json")"
    RECOVERY_SERIALIZATION_LEASE_HOLDER="$(jq -er .lease.holder <<<"$authority_json")"
    recovery_stream_guard_process_is_healthy \
      "$2" "$3" "$4" "$5" "$6" "$7" "$8" \
      checkpoint-writer-monitor
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
    "$WRITER_TEST_PID" "$1" "$WRITER_TEST_FAILURE" "$WRITER_TEST_READY" \
    "$WRITER_TEST_PROGRESS" "$2" "$3"
}

run_stream_capability_authority_tamper_tests() {
  local ready_value baseline_sha authority_sha authority_path monitor_identity
  local original_authority tampered_authority tampered_sha monitor_status=0
  prepare_checkpoint_writer_monitor_fixture durable-v2 || return 1
  start_checkpoint_writer_test_monitor ""
  wait_checkpoint_writer_test_handoff || return 1
  ready_value="$(<"$WRITER_TEST_READY")"
  [[ "$ready_value" =~ ^ready:([a-f0-9]{64}):([a-f0-9]{64})$ ]] || return 1
  baseline_sha="${BASH_REMATCH[1]}"
  authority_sha="${BASH_REMATCH[2]}"
  authority_path="${WRITER_TEST_READY}.authority.json"
  original_authority="$(<"$authority_path")"
  monitor_identity="$(jq -er '.start_identity' <<<"$original_authority")" || return 1
  expect_success 'stream capability accepts its exact signed READY and authority' \
    stream_writer_capability_is_healthy \
      "$monitor_identity" "$authority_path" "$authority_sha"
  kill -STOP "$WRITER_TEST_PID" 2>/dev/null || return 1

  printf 'revoked\n' >"$WRITER_TEST_READY"
  expect_failure 'stream capability rejects post-handshake READY replacement' '' \
    stream_writer_capability_is_healthy \
      "$monitor_identity" "$authority_path" "$authority_sha"

  tampered_authority="$(jq -cS \
    --arg path "$WRITER_TEST_DIR/not-the-authority.json" \
    '.paths.authority = $path' <<<"$original_authority")" || return 1
  printf '%s\n' "$tampered_authority" >"$authority_path"
  chmod 600 "$authority_path"
  tampered_sha="$(sha256_digest "$authority_path")" || return 1
  printf 'ready:%s:%s\n' "$baseline_sha" "$tampered_sha" >"$WRITER_TEST_READY"
  expect_failure \
    'stream capability rejects self-path substitution even with matching READY digest' '' \
    stream_writer_capability_is_healthy \
      "$monitor_identity" "$authority_path" "$tampered_sha"

  printf '%s\n' "$original_authority" >"$authority_path"
  chmod 600 "$authority_path"
  printf '%s\n' "$ready_value" >"$WRITER_TEST_READY"
  printf 'discard\n' >"$WRITER_TEST_STOP"
  kill -CONT "$WRITER_TEST_PID" 2>/dev/null || :
  if wait "$WRITER_TEST_PID"; then monitor_status=0; else monitor_status=$?; fi
  if [[ "$monitor_status" == 0 && ! -s "$WRITER_TEST_FAILURE" ]]; then
    pass 'stream capability tamper fixture restores and reaps its monitor'
  else
    fail 'stream capability tamper fixture did not restore cleanly' \
      "status=$monitor_status failure=$(cat "$WRITER_TEST_FAILURE" 2>/dev/null || :)"
  fi
}

run_stream_guard_timing_contract_tests() {
  reset_stub
  # shellcheck disable=SC2016 # Command substitution expands in isolated Bash.
  expect_success 'fixture kubectl accepts the supervisor one-second Lease budget' \
    bash -c '
      set -euo pipefail
      [[ "$(kubectl --context fixture-context --request-timeout=1s \
        config current-context)" == fixture-context ]]
    '

  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_success 'production stream timing defaults remain one-second poll and ten-second budgets' \
    env -u YENHUBS_RECOVERY_TEST_MODE -u RECOVERY_STREAM_POLL_SECONDS \
      -u RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS \
      -u RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS bash -c '
        set -euo pipefail
        source "$1"
        [[ "$(recovery_stream_poll_seconds)" == 1 &&
           "$(recovery_stream_guard_max_stale_seconds)" == 10 &&
           "$(recovery_stream_guard_initial_deadline_seconds)" == 10 ]]
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_success 'attested fixture may extend only initial sweep startup to 120 seconds' \
    env YENHUBS_RECOVERY_TEST_MODE=local-fixture \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid NAMESPACE=hcce \
      RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=120 bash -c '
        set -euo pipefail
        source "$1"
        [[ "$(recovery_stream_guard_initial_deadline_seconds)" == 120 &&
           "$(recovery_stream_guard_max_stale_seconds)" == 10 ]]
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_success 'attested fixture accepts bounded stream poll and max-stale overrides' \
    env YENHUBS_RECOVERY_TEST_MODE=local-fixture \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid NAMESPACE=hcce \
      RECOVERY_STREAM_POLL_SECONDS=0.01 \
      RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS=1 bash -c '
        set -euo pipefail
        source "$1"
        [[ "$(recovery_stream_poll_seconds)" == 0.01 &&
           "$(recovery_stream_guard_max_stale_seconds)" == 1 ]]
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'unattested context cannot shorten the stream poll interval' '' \
    env -u YENHUBS_RECOVERY_TEST_MODE \
      EXPECTED_KUBE_CONTEXT=production-context NAMESPACE=hcce \
      RECOVERY_STREAM_POLL_SECONDS=0.01 bash -c '
        set -euo pipefail
        source "$1"
        recovery_stream_poll_seconds
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'unattested context cannot override stream max-stale timing' '' \
    env -u YENHUBS_RECOVERY_TEST_MODE \
      EXPECTED_KUBE_CONTEXT=production-context NAMESPACE=hcce \
      RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS=1 bash -c '
        set -euo pipefail
        source "$1"
        recovery_stream_guard_max_stale_seconds
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'unattested context cannot extend initial stream-guard startup' '' \
    env -u YENHUBS_RECOVERY_TEST_MODE \
      EXPECTED_KUBE_CONTEXT=production-context NAMESPACE=hcce \
      RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=120 bash -c '
        set -euo pipefail
        source "$1"
        recovery_stream_guard_initial_deadline_seconds
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'even an attested fixture cannot set a 300-second initial deadline' '' \
    env YENHUBS_RECOVERY_TEST_MODE=local-fixture \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid NAMESPACE=hcce \
      RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=300 bash -c '
        set -euo pipefail
        source "$1"
        recovery_stream_guard_initial_deadline_seconds
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_failure 'even an attested fixture cannot extend max-stale to 300 seconds' '' \
    env YENHUBS_RECOVERY_TEST_MODE=local-fixture \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid NAMESPACE=hcce \
      RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS=300 bash -c '
        set -euo pipefail
        source "$1"
        recovery_stream_guard_max_stale_seconds
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

  # Keep removed timing knobs out of both production recovery scripts and the
  # active safety harness. Split the names so this assertion does not preserve
  # the deprecated spellings that it is designed to detect.
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_success 'active recovery surfaces contain no deprecated interval knobs' \
    bash -c '
      set -euo pipefail
      for legacy_name in \
        "STORAGE_BACKUP_MONITOR_""INTERVAL_SECONDS" \
        "DB_QUIESCE_MONITOR_""INTERVAL_SECONDS" \
        "PVC_MONITOR_""INTERVAL_SECONDS"; do
        ! rg -q -- "$legacy_name" "$1/deployment" "$2"
      done
    ' _ "$ROOT_DIR" "$ROOT_DIR/tests/recovery/test-recovery-safety.sh"

  reset_stub
  # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
  expect_success 'stream Lease revalidation uses its dedicated five-second API timeout' \
    env EXPECTED_KUBE_CONTEXT=fixture-context \
      RECOVERY_LEASE_HEARTBEAT_SECONDS=1 bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        source "$1"
        recovery_acquire_operation_serialization root-recovery
        recovery_require_operation_serialization_stream
        grep -Fq -- \
          "--request-timeout=5s get lease yenhubs-operation-serialization -n hcce -o json" \
          "$2"
        recovery_release_operation_serialization
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$KUBECTL_LOG"
}

run_watchdog_identity_tests() {
  local stop_marker="$TMP_DIR/reused-watchdog.stop"
  local call_log="$TMP_DIR/reused-watchdog.calls"
  local event_log="$TMP_DIR/reused-watchdog.events"
  local reused_pid reused_identity platform
  printf 'stop\n' >"$stop_marker"
  chmod 600 "$stop_marker"
  : >"$call_log"
  sleep 30 &
  # shellcheck disable=SC2031 # PID belongs to this top-level test shell.
  reused_pid=$!
  reused_identity="$(
    # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
    bash -c 'source "$1"; recovery_process_start_identity "$2"' _ \
      "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$reused_pid"
  )"
  platform="$(uname -s)"
  if [[ ( "$platform" == Darwin &&
          "$reused_identity" =~ ^darwin:[1-9][0-9]*:[0-9]{1,6}$ ) ||
        ( "$platform" == Linux &&
          "$reused_identity" =~ ^linux:[a-f0-9-]{36}:[1-9][0-9]*$ ) ]]; then
    pass 'process capabilities use a platform-native high-resolution start identity'
  else
    fail 'process capability lacks a high-resolution start identity' \
      "platform=$platform identity=${reused_identity:-missing}"
  fi
  # shellcheck disable=SC2016 # Functions intentionally shadow builtins in the isolated Bash.
  expect_success 'bounded watcher join rejects a reused target PID before watchdog spawn' \
    env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
      set -euo pipefail
      source "$1"
      call_log="$5"
      kill() {
        if [[ "${1:-}" == -0 ]]; then builtin kill "$@"; return; fi
        printf "kill %s\n" "$*" >>"$call_log"
        return 99
      }
      wait() {
        printf "wait %s\n" "$*" >>"$call_log"
        return 127
      }
      if recovery_wait_isolated_process_bounded \
          "$2" "$3-reused" "$4"; then
        exit 1
      fi
      [[ ! -s "$5" ]]
      recovery_process_identity_is_live "$2" "$3"
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$reused_pid" \
      "$reused_identity" "$stop_marker" "$call_log"
  builtin kill -TERM "$reused_pid" 2>/dev/null || :
  builtin wait "$reused_pid" 2>/dev/null || :

  printf 'stop\n' >"$stop_marker"
  : >"$call_log"
  : >"$event_log"
  python3 - <<'PY' &
import os
import time

os.setsid()
time.sleep(30)
PY
  # shellcheck disable=SC2031 # PID belongs to this top-level test shell.
  reused_pid=$!
  for _ in {1..100}; do
    reused_identity="$(
      # shellcheck disable=SC2016 # Positional arguments expand in isolated Bash.
      bash -c 'source "$1"; recovery_process_start_identity "$2"' _ \
        "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$reused_pid" \
        2>/dev/null || :
    )"
    [[ -n "$reused_identity" ]] && break
    sleep 0.01
  done
  # shellcheck disable=SC2016 # Functions intentionally simulate watchdog PID reuse.
  expect_success 'bounded watcher join never signals or waits a reused internal watchdog PID' \
    env YENHUBS_RECOVERY_TEST_MODE=local-fixture \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid NAMESPACE=hcce \
      RECOVERY_TEST_WATCHER_JOIN_TIMEOUT_SECONDS=1 bash -c '
        set -euo pipefail
        source "$1"
        target_pid="$2"
        target_identity="$3"
        action_log="$5"
        event_log="$6"
        deadline_grep_count=0
        recovery_process_start_identity() {
          printf "captured-watchdog-identity\n"
        }
        recovery_process_identity_is_live() {
          [[ "$1" == "$target_pid" && "$2" == "$target_identity" ]]
        }
        recovery_stop_process_group() {
          printf "target-cleanup %s\n" "$*" >>"$event_log"
        }
        grep() {
          if [[ "$*" == *yenhubs-watcher-deadline* &&
                "$deadline_grep_count" == 0 ]]; then
            deadline_grep_count=1
            printf "watchdog-reuse-observed\n" >>"$event_log"
            return 1
          fi
          command grep "$@"
        }
        kill() {
          if [[ "${1:-}" == -0 ]]; then builtin kill "$@"; return; fi
          printf "kill %s\n" "$*" >>"$action_log"
          return 99
        }
        wait() {
          printf "wait %s\n" "$*" >>"$action_log"
          return 127
        }
        if recovery_wait_isolated_process_bounded \
            "$target_pid" "$target_identity" "$4"; then
          exit 1
        fi
        [[ ! -s "$action_log" ]] &&
          grep -q "watchdog-reuse-observed" "$event_log" &&
          grep -q "target-cleanup" "$event_log"
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$reused_pid" \
        "$reused_identity" "$stop_marker" "$call_log" "$event_log"
  for _ in {1..400}; do
    kill -0 "$reused_pid" 2>/dev/null || break
    sleep 0.01
  done
  builtin kill -TERM "$reused_pid" 2>/dev/null || :
  builtin wait "$reused_pid" 2>/dev/null || :
}

prepare_recovery_operation_fence_library_fixture() {
  NAMESPACE=hcce
  EXPECTED_KUBE_CONTEXT=fixture-context
  EXPECTED_NAMESPACE_UID=fixture-uid
  EXPECTED_RET_PVC_UID=fixture-pvc-uid
  export NAMESPACE EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID \
    EXPECTED_RET_PVC_UID
  reset_stub
  seed_checkpoint_backup_guard
  RECOVERY_NAMESPACE_UID=fixture-uid
  RECOVERY_PVC_UID=fixture-pvc-uid
  RECOVERY_CHECKPOINT_STAMP="$STAMP"
  RECOVERY_DUMP_SHA256="$DUMP_SHA"
  RECOVERY_STORAGE_SHA256="$STORAGE_SHA"
  RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
  RECOVERY_OPERATION_BINDING_SHA256=""
  recovery_adopt_parent_operation_serialization \
    "$YENHUBS_PARENT_LEASE_HOLDER" "$YENHUBS_PARENT_LEASE_UID" \
    "$YENHUBS_PARENT_PROCESS_PID" \
    "$YENHUBS_PARENT_PROCESS_START_IDENTITY" || return 1
  printf '%s' dormant \
    >"$STUB_STATE_DIR/recovery-operation-fence-binding-state"
  printf '%s' recovery-operation-fence-binding-rv-1 \
    >"$STUB_STATE_DIR/recovery-operation-fence-binding-rv"
}

run_recovery_operation_fence_library_success() (
  local active_identity="" dormant_identity=""
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  prepare_recovery_operation_fence_library_fixture || return 1
  recovery_require_recovery_operation_fence_state dormant || return 1
  recovery_activate_recovery_operation_fence active_identity || return 1
  recovery_operation_fence_identity_is_exact "$active_identity" active || return 1
  recovery_require_recovery_operation_fence_state \
    active "$active_identity" || return 1
  recovery_deactivate_recovery_operation_fence \
    "$active_identity" dormant_identity || return 1
  recovery_operation_fence_identity_is_exact \
    "$dormant_identity" dormant || return 1
  recovery_require_recovery_operation_fence_state \
    dormant "$dormant_identity" || return 1
  [[ "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")" == \
       dormant &&
     "$(grep -c 'create --dry-run=server -f -' "$KUBECTL_LOG")" == 4 &&
     "$(grep -c 'replace -f - -o json' "$KUBECTL_LOG")" == 2 ]]
)

run_recovery_operation_fence_stale_identity_test() (
  local active_identity="" stale_identity="" ignored="" replace_count
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  prepare_recovery_operation_fence_library_fixture || return 1
  recovery_activate_recovery_operation_fence active_identity || return 1
  stale_identity="$(jq -cS '
    .binding.resource_version = "stale-binding-resource-version"
  ' <<<"$active_identity")" || return 1
  replace_count="$(grep -c 'replace -f - -o json' "$KUBECTL_LOG")"
  if recovery_deactivate_recovery_operation_fence \
      "$stale_identity" ignored >/dev/null 2>&1; then
    return 1
  fi
  [[ -z "$ignored" &&
     "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")" == \
       active &&
     "$(grep -c 'replace -f - -o json' "$KUBECTL_LOG")" == "$replace_count" ]]
)

run_recovery_operation_fence_failure_test() (
  local mode="$1" active_identity=""
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  prepare_recovery_operation_fence_library_fixture || return 1
  # shellcheck disable=SC2030 # Set and consumed inside this test subshell.
  export STUB_MODE="$mode"
  if recovery_activate_recovery_operation_fence \
      active_identity >/dev/null 2>&1; then
    return 1
  fi
  case "$mode" in
    recovery-fence-cas-conflict)
      [[ "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")" == \
        dormant ]]
      ;;
    recovery-fence-aba-after-replace)
      [[ "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-state")" == \
           active &&
         "$(cat "$STUB_STATE_DIR/recovery-operation-fence-binding-rv")" == \
           recovery-operation-fence-binding-rv-99 ]]
      ;;
    *) return 2 ;;
  esac
)

run_recovery_operation_fence_library_tests() {
  expect_success 'recovery-operation fence performs exact dormant-active-dormant CAS and both probe pairs' \
    run_recovery_operation_fence_library_success
  expect_success 'recovery-operation fence refuses deactivation with a stale active identity before CAS' \
    run_recovery_operation_fence_stale_identity_test
  expect_success 'recovery-operation fence fails closed on a binding CAS conflict' \
    run_recovery_operation_fence_failure_test recovery-fence-cas-conflict
  expect_success 'recovery-operation fence detects a post-replace ABA resourceVersion' \
    run_recovery_operation_fence_failure_test recovery-fence-aba-after-replace
}

run_durable_runner_monitor_library_success() (
  local control_sha durable_json durable_path durable_sha monitor_dir
  local monitor_pid="" monitor_identity="" capability_sha="" authority_sha="" joined=0
  local stop_path failure_path ready_path progress_path final_path
  # Defaults are intentional here; other calls pass overrides via expect_success.
  # shellcheck disable=SC2119
  run_checkpoint_writer_monitor_success || return 1
  control_sha="$(sha256_digest "$WRITER_TEST_BASELINE")" || return 1
  NAMESPACE=hcce
  EXPECTED_KUBE_CONTEXT=fixture-context
  EXPECTED_NAMESPACE_UID=fixture-uid
  EXPECTED_RET_PVC_UID=fixture-pvc-uid
  export NAMESPACE EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID \
    EXPECTED_RET_PVC_UID
  # shellcheck source=deployment/lib/recovery-safety.sh
  source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  RECOVERY_NAMESPACE_UID=fixture-uid
  RECOVERY_PVC_UID=fixture-pvc-uid
  RECOVERY_CHECKPOINT_STAMP="$STAMP"
  RECOVERY_DUMP_SHA256="$DUMP_SHA"
  RECOVERY_STORAGE_SHA256="$STORAGE_SHA"
  recovery_adopt_parent_operation_serialization \
    "$YENHUBS_PARENT_LEASE_HOLDER" "$YENHUBS_PARENT_LEASE_UID" \
    "$YENHUBS_PARENT_PROCESS_PID" \
    "$YENHUBS_PARENT_PROCESS_START_IDENTITY" || return 1
  # shellcheck disable=SC2031 # This wrapper intentionally replaces sibling fixture state.
  export STUB_MODE=durable-wrapper-live STUB_RUNNER_NAMESPACE=present
  export STUB_RUNNER_POD_PROFILE=fence-stable
  KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer"
  export KUBECTL_BIN
  durable_json="$(recovery_capture_durable_quiescence)" || return 1
  recovery_durable_fence_inventory_json_is_canonical "$durable_json" || return 1
  monitor_dir="$(mktemp -d "$TMP_DIR/durable-library-monitor.XXXXXX")" || return 1
  chmod 700 "$monitor_dir"
  durable_path="$monitor_dir/durable-baseline.json"
  stop_path="$monitor_dir/stop"
  failure_path="$monitor_dir/failure"
  ready_path="$monitor_dir/ready"
  progress_path="$monitor_dir/progress"
  final_path="$monitor_dir/final"
  printf '%s' "$durable_json" >"$durable_path"
  : >"$stop_path"
  : >"$failure_path"
  : >"$ready_path"
  : >"$progress_path"
  : >"$final_path"
  chmod 600 "$durable_path" "$stop_path" "$failure_path" "$ready_path" \
    "$progress_path" "$final_path"
  durable_sha="$(sha256_digest "$durable_path")" || return 1
  # shellcheck disable=SC2317,SC2329 # Invoked by EXIT trap.
  cleanup_durable_library_monitor() {
    if [[ "$monitor_pid" =~ ^[1-9][0-9]*$ && -n "$monitor_identity" ]]; then
      recovery_discard_durable_runner_quiescence_monitor \
        "$stop_path" "$monitor_pid" "$monitor_identity"
    fi
  }
  trap cleanup_durable_library_monitor EXIT
  recovery_start_durable_runner_quiescence_monitor \
    "$durable_path" "$durable_sha" "$WRITER_TEST_BASELINE" "$control_sha" \
    "$stop_path" "$failure_path" "$ready_path" "$progress_path" "$final_path" \
    monitor_pid monitor_identity capability_sha checkpoint-backup || return 1
  authority_sha="$(recovery_monitor_authority_sha256_for_ready \
    "$ready_path")" || return 1
  recovery_require_durable_runner_quiescence_monitor_healthy \
    "$durable_path" "$durable_sha" "$WRITER_TEST_BASELINE" "$control_sha" \
    "$failure_path" "$ready_path" "$progress_path" "$monitor_pid" \
    "$monitor_identity" "$capability_sha" checkpoint-backup || return 1
  recovery_stop_durable_runner_quiescence_monitor \
    "$durable_path" "$durable_sha" "$WRITER_TEST_BASELINE" "$control_sha" \
    "$stop_path" "$failure_path" "$ready_path" "$progress_path" "$final_path" \
    "$monitor_pid" "$monitor_identity" "$capability_sha" joined \
    checkpoint-backup || return 1
  monitor_pid=""
  monitor_identity=""
  [[ "$joined" == ok && "$capability_sha" =~ ^[a-f0-9]{64}$ &&
     "$(<"$ready_path")" == \
       "ready:$durable_sha:$control_sha:$capability_sha:$authority_sha" &&
     "$(<"$final_path")" == \
       "complete:$durable_sha:$control_sha:$capability_sha:$authority_sha" ]]
)

run_durable_runner_monitor_library_tests() {
  expect_success 'durable quiescence wrappers bind real PID identity, both baselines, owner, progress and FINAL' \
    run_durable_runner_monitor_library_success
}

test_yaml_field() {
  local pattern="$1" file="$2"
  awk -v pattern="$pattern" '$0 ~ pattern {value=$0; sub(/^[^:]+:[[:space:]]*/, "", value); gsub(/^"|"$/, "", value); print value; exit}' "$file"
}

prepare_fence_fixture() {
  seed_recovery_operation_fence_binding_state dormant \
    recovery-operation-fence-binding-rv-1 || return 1
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
    RESTORE_CHECKPOINT_PREPARE_FENCE=1 \
    CONFIRM_PREPARE_RESTORE_FENCE="$PREPARE_FENCE_CONFIRMATION" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
}

apply_restore_fence_fixture() {
  local deployment
  recovery_operation_fence_binding_state_is dormant \
    recovery-operation-fence-binding-rv-1 || return 1
  seed_recovery_operation_fence_binding_state active \
    recovery-operation-fence-binding-rv-2 || return 1
  printf '%s' restore-fence >"$STUB_STATE_DIR/recovery-phase"
  printf '%s' "$TARGET_RUNNER_EPOCH" >"$STUB_STATE_DIR/recovery-epoch"
  printf '%s' runner-role-uid >"$STUB_STATE_DIR/runner-role-uid"
  printf '%s' 3 >"$STUB_STATE_DIR/runner-role-rv"
  printf '%s' restore-fence >"$STUB_STATE_DIR/runner-role-phase"
  printf '%s' '[]' >"$STUB_STATE_DIR/runner-role-rules.json"
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    [[ -f "$STUB_STATE_DIR/replicas-$deployment" &&
       "$(cat "$STUB_STATE_DIR/replicas-$deployment")" == 0 ]] || return 1
    printf '%s' 3 >"$STUB_STATE_DIR/rv-$deployment"
  done
}

execute_fence_confirmation() {
  local operation_id
  operation_id="$(test_yaml_field 'yenhubs.org/operation-id:' "$STUB_STATE_DIR/restore-lock.yaml")"
  printf 'execute-fenced:fixture-context:hcce:fixture-uid:fixture-pvc-uid:%s:%s:%s:%s:%s:%s:%s:durable-v2:restore-lock-uid:%s' \
    "$STAMP" "$DURABLE_RESTORE_DUMP_SHA" "$DURABLE_RESTORE_STORAGE_SHA" \
    "$CHECKPOINT_INVENTORY_SHA" "$LIVE_RUNNER_EPOCH" \
    "$TARGET_RUNNER_EPOCH" "$CHECKPOINT_EVIDENCE_SHA" \
    "$operation_id"
}

execute_fenced_fixture() {
  local confirmation
  confirmation="$(execute_fence_confirmation)"
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
    RESTORE_CHECKPOINT_EXECUTE_FENCED=1 \
    CONFIRM_EXECUTE_RESTORE_FENCE="$confirmation" \
    YENHUBS_WATCH_TEST_DEBUG=1 \
    STUB_MONITOR_WATCH_PACE=1 \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
}

apply_active_reactivation_fixture() {
  local deployment replicas="${1:-1}"
  recovery_operation_fence_binding_state_is active \
    recovery-operation-fence-binding-rv-2 || return 1
  seed_recovery_operation_fence_binding_state dormant \
    recovery-operation-fence-binding-rv-3 || return 1
  printf '%s' active >"$STUB_STATE_DIR/recovery-phase"
  printf '%s' "$TARGET_RUNNER_EPOCH" >"$STUB_STATE_DIR/recovery-epoch"
  printf '%s' runner-role-uid >"$STUB_STATE_DIR/runner-role-uid"
  printf '%s' active >"$STUB_STATE_DIR/runner-role-phase"
  printf '%s' '[{"apiGroups":[""],"resources":["pods"],"verbs":["create","delete","get","list","patch"]}]' \
    >"$STUB_STATE_DIR/runner-role-rules.json"
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '%s' "$replicas" >"$STUB_STATE_DIR/replicas-$deployment"
    printf '%s' 4 >"$STUB_STATE_DIR/rv-$deployment"
  done
}

apply_fail_closed_active_fixture() {
  local deployment
  recovery_operation_fence_binding_state_is dormant \
    recovery-operation-fence-binding-rv-3 || return 1
  [[ "$(cat "$STUB_STATE_DIR/recovery-phase" 2>/dev/null || :)" == active ]] ||
    return 1
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    [[ "$(cat "$STUB_STATE_DIR/replicas-$deployment" 2>/dev/null || :)" == 0 ]] ||
      return 1
  done
  printf '%s' 5 >"$STUB_STATE_DIR/runner-role-rv"
  printf '%s' restore-fence >"$STUB_STATE_DIR/runner-role-phase"
  printf '%s' '[]' >"$STUB_STATE_DIR/runner-role-rules.json"
}

finalize_fence_confirmation() {
  local operation_id
  operation_id="$(test_yaml_field 'yenhubs.org/operation-id:' \
    "$STUB_STATE_DIR/restore-lock.yaml")"
  printf 'finalize-reactivation:fixture-context:hcce:fixture-uid:fixture-pvc-uid:%s:%s:%s:%s:%s:%s:%s:durable-v2:restore-lock-uid:%s' \
    "$STAMP" "$DURABLE_RESTORE_DUMP_SHA" "$DURABLE_RESTORE_STORAGE_SHA" \
    "$CHECKPOINT_INVENTORY_SHA" "$LIVE_RUNNER_EPOCH" \
    "$TARGET_RUNNER_EPOCH" "$CHECKPOINT_EVIDENCE_SHA" \
    "$operation_id"
}

initialize_restore_fence_test_environment() {
  # Earlier writer-monitor fixtures intentionally select the writer-specific
  # kubectl wrapper and export failure modes. A full-suite restore must not
  # inherit that synthetic query profile; focused restore tests already start
  # with the ordinary kubectl stub. Keep both entry paths byte-for-byte equal.
  unset STUB_MODE STUB_CHECKPOINT_WRITER_QUERY
  KUBECTL_BIN="$TMP_DIR/bin/kubectl"
  export KUBECTL_BIN
}

initialize_restore_fence_test_context() {
  initialize_restore_fence_test_environment
  initialize_durable_restore_fixture
  initialize_schema3_legacy_restore_fixture
  RESTORE_PHASE_PREVIOUS_DEPLOYMENTS_JSON="$STUB_DEPLOYMENTS_JSON"
  VALUES_FILE="$RESTORE_VALUES_FIXTURE"
  STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON"
  STUB_RUNNER_NAMESPACE=present
  STUB_RUNNER_POD_PROFILE=fence-stable
  export VALUES_FILE STUB_DEPLOYMENTS_JSON STUB_RUNNER_NAMESPACE \
    STUB_RUNNER_POD_PROFILE
  reset_stub
  CHECKPOINT_INVENTORY_SHA="$DURABLE_RESTORE_INVENTORY_SHA"
  CHECKPOINT_EVIDENCE_SHA="$DURABLE_RESTORE_EVIDENCE_SHA"
  PREPARE_FENCE_CONFIRMATION="prepare-fence:fixture-context:hcce:fixture-uid:fixture-pvc-uid:$STAMP:$DURABLE_RESTORE_DUMP_SHA:$DURABLE_RESTORE_STORAGE_SHA:$CHECKPOINT_INVENTORY_SHA:$LIVE_RUNNER_EPOCH:$TARGET_RUNNER_EPOCH:$CHECKPOINT_EVIDENCE_SHA:durable-v2"
}

run_restore_execute_cas_tests() {
  local execute_lock_cas_mode execute_lock_cas_confirmation
  local execute_lock_cas_error execute_lock_cas_expected_rv
  local execute_lock_cas_expected_fence_rv execute_lock_cas_all_zero
  local execute_lock_cas_consumer
  local requested_mode="${1:-}"
  local -a execute_lock_cas_modes=(
    restore-lock-cas-no-rv-advance
    restore-fence-identity-drift-after-lock-cas
  )
  if [[ -n "$requested_mode" ]]; then
    case "$requested_mode" in
      restore-lock-cas-no-rv-advance|restore-fence-identity-drift-after-lock-cas)
        execute_lock_cas_modes=("$requested_mode")
        ;;
      *)
        printf 'Unknown restore-execute-cas test case.\n' >&2
        return 2
        ;;
    esac
  fi
  for execute_lock_cas_mode in "${execute_lock_cas_modes[@]}"; do
    reset_stub
    expect_success "$execute_lock_cas_mode fixture prepares its exact source fence" \
      prepare_fence_fixture
    apply_restore_fence_fixture
    execute_lock_cas_confirmation="$(execute_fence_confirmation)"
    case "$execute_lock_cas_mode" in
      restore-lock-cas-no-rv-advance)
        execute_lock_cas_error='Restore lock replacement did not advance its resourceVersion'
        execute_lock_cas_expected_rv=lock-rv-1
        execute_lock_cas_expected_fence_rv=recovery-operation-fence-binding-rv-2
        ;;
      restore-fence-identity-drift-after-lock-cas)
        execute_lock_cas_error='active recovery-operation fence identity changed beyond the expected restore-lock resourceVersion advance'
        execute_lock_cas_expected_rv=lock-rv-2
        execute_lock_cas_expected_fence_rv=recovery-operation-fence-binding-rv-99
        ;;
    esac
    : >"$KUBECTL_LOG"
    expect_failure "$execute_lock_cas_mode fails closed after fenced restore" \
      "$execute_lock_cas_error" \
      env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid \
      VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
      HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
      RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
      RESTORE_CHECKPOINT_EXECUTE_FENCED=1 \
      CONFIRM_EXECUTE_RESTORE_FENCE="$execute_lock_cas_confirmation" \
      STUB_MODE="$execute_lock_cas_mode" STUB_MONITOR_WATCH_PACE=1 \
      RECOVERY_STREAM_POLL_SECONDS=0.01 \
      "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
    execute_lock_cas_all_zero=true
    for execute_lock_cas_consumer in \
      reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
      if [[ "$(cat "$STUB_STATE_DIR/replicas-$execute_lock_cas_consumer" \
            2>/dev/null || :)" != 0 ]]; then
        execute_lock_cas_all_zero=false
      fi
    done
    if [[ "$execute_lock_cas_all_zero" == true ]] &&
       restore_lock_state_is restore-complete-awaiting-reactivation \
         "$execute_lock_cas_expected_rv" &&
       recovery_operation_fence_binding_state_is active \
         "$execute_lock_cas_expected_fence_rv" &&
       recovery_operation_fence_binding_was_not_replaced &&
       jq -e '
         .kind == "ConfigMap" and
         .metadata.uid == "restore-lock-uid" and
         .metadata.resourceVersion == "lock-rv-1" and
         .metadata.annotations["yenhubs.org/recovery-state"] ==
           "restore-complete-awaiting-reactivation"
       ' "$STUB_STATE_DIR/restore-lock-replace-payload.json" >/dev/null &&
       ! grep -Eq -- \
         'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock' \
         "$KUBECTL_LOG"; then
      pass "$execute_lock_cas_mode retains the exact lock/fence identity without local VAP mutation"
    else
      fail "$execute_lock_cas_mode exact fail-closed CAS contract" \
        "$(cat "$KUBECTL_LOG")"
    fi
  done
}

run_restore_finalize_positive_test() {
  local finalize_confirmation finalize_lock_delete_base
  local finalize_lock_delete_index finalize_live_verifier_base
  local finalize_all_active=true finalize_consumer
  apply_active_reactivation_fixture
  if recovery_operation_fence_binding_state_is dormant \
       recovery-operation-fence-binding-rv-3 &&
     recovery_operation_fence_binding_was_not_replaced; then
    pass 'standard Cloud active fixture returns the fifth fence to dormant RV3'
  else
    fail 'standard Cloud active fixture identity' "$(cat "$KUBECTL_LOG")"
  fi
  finalize_confirmation="$(finalize_fence_confirmation)"
  finalize_lock_delete_base="$(
    cat "$STUB_STATE_DIR/delete-count" 2>/dev/null || printf 0
  )"
  finalize_lock_delete_index=$((finalize_lock_delete_base + 1))
  finalize_live_verifier_base="$(
    cat "$STUB_STATE_DIR/live-reactivation-verifier-count" 2>/dev/null || printf 0
  )"
  : >"$KUBECTL_LOG"
  expect_success 'finalizer accepts active workloads only after Cloud returns the fifth fence to dormant' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
    RESTORE_CHECKPOINT_FINALIZE_REACTIVATION=1 \
    CONFIRM_FINALIZE_RESTORE_REACTIVATION="$finalize_confirmation" \
    STUB_RUNNER_NAMESPACE=present \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  for finalize_consumer in \
    reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ "$(cat "$STUB_STATE_DIR/replicas-$finalize_consumer" \
          2>/dev/null || :)" != 1 ]]; then
      finalize_all_active=false
    fi
  done
  if [[ "$finalize_all_active" == true &&
        ! -e "$STUB_STATE_DIR/restore-lock.yaml" &&
        "$(cat "$STUB_STATE_DIR/delete-count")" == \
          "$((finalize_lock_delete_base + 1))" &&
        "$(cat "$STUB_STATE_DIR/live-reactivation-verifier-count" \
          2>/dev/null || :)" == "$((finalize_live_verifier_base + 1))" &&
        "$(cat "$STUB_STATE_DIR/runner-role-phase")" == active ]] &&
     recovery_operation_fence_binding_state_is dormant \
       recovery-operation-fence-binding-rv-3 &&
     recovery_operation_fence_binding_was_not_replaced &&
     jq -e '
       . == {
         apiVersion:"v1",
         kind:"DeleteOptions",
         propagationPolicy:"Foreground",
         preconditions:{uid:"restore-lock-uid",resourceVersion:"lock-rv-2"}
       }
     ' "$STUB_STATE_DIR/delete-options-$finalize_lock_delete_index.json" \
       >/dev/null &&
     ! any_deployment_replica_mutation; then
    pass 'FINALIZE deletes only the lock at RV2 and preserves dormant RV3/active workloads'
  else
    fail 'FINALIZE positive exact state-machine contract' "$(cat "$KUBECTL_LOG")"
  fi
}

run_restore_clear_stale_final_evidence_test() {
  local durable_clear_operation_id durable_clear_operation_token
  local durable_clear_confirmation
  reset_stub
  expect_success 'durable clear-stale final-evidence fixture prepares a persistent restore fence' \
    prepare_fence_fixture
  apply_restore_fence_fixture
  expect_success 'durable clear-stale final-evidence fixture reaches completed restore state' \
    execute_fenced_fixture
  apply_active_reactivation_fixture 0
  apply_fail_closed_active_fixture
  durable_clear_operation_id="$(test_yaml_field 'yenhubs.org/operation-id:' \
    "$STUB_STATE_DIR/restore-lock.yaml")"
  durable_clear_operation_token="$(test_yaml_field 'yenhubs.org/recovery-token:' \
    "$STUB_STATE_DIR/restore-lock.yaml")"
  seed_stale_restore_helper "$durable_clear_operation_id" \
    "$durable_clear_operation_token"
  durable_clear_confirmation="restore-lock:fixture-context:hcce:fixture-uid:$STAMP:$DURABLE_RESTORE_DUMP_SHA:$DURABLE_RESTORE_STORAGE_SHA:restore-lock-uid:fixture-pvc-uid:$CHECKPOINT_EVIDENCE_SHA:durable-v2"
  : >"$KUBECTL_LOG"
  expect_failure 'durable clear-stale revalidates target evidence after stopping its monitor' \
    'clear_stale_final_evidence_drift' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
    YENHUBS_RECOVERY_RUNNER_CHECKPOINT_HELPER="$RUNNER_CHECKPOINT_HELPER_FIXTURE" \
    STUB_MODE=clear-stale-final-evidence-drift \
    RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
    CONFIRM_CLEAR_RESTORE_LOCK="$durable_clear_confirmation" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  if [[ "$(cat "$STUB_STATE_DIR/clear-stale-post-helper-evidence-count")" == 2 &&
        ! -e "$STUB_STATE_DIR/pod-created" &&
        ! -e "$STUB_STATE_DIR/network-policy.yaml" &&
        -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     restore_lock_state_is restore-complete-awaiting-reactivation lock-rv-2 &&
     recovery_operation_fence_binding_state_is dormant \
       recovery-operation-fence-binding-rv-3 &&
     recovery_operation_fence_binding_was_not_replaced &&
     ! grep -Eq 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' \
       "$KUBECTL_LOG" &&
     ! any_deployment_replica_mutation; then
    pass 'final target-evidence drift preserves the exact lock after helper cleanup'
  else
    fail 'final target-evidence drift remains fail-closed' "$(cat "$KUBECTL_LOG")"
  fi
}

run_restore_clear_stale_success_test() {
  local durable_clear_operation_id durable_clear_operation_token
  local durable_clear_confirmation durable_clear_delete_base
  local durable_clear_lock_resource_version durable_clear_pod_delete_index
  local durable_clear_policy_delete_index durable_clear_lock_delete_index
  local durable_clear_pod_delete_line durable_clear_policy_delete_line
  local durable_clear_lock_delete_line
  reset_stub
  expect_success 'durable clear-stale fixture prepares a persistent restore fence' \
    prepare_fence_fixture
  apply_restore_fence_fixture
  expect_success 'durable clear-stale fixture reaches completed restore state' \
    execute_fenced_fixture
  apply_active_reactivation_fixture 0
  apply_fail_closed_active_fixture
  durable_clear_operation_id="$(test_yaml_field 'yenhubs.org/operation-id:' \
    "$STUB_STATE_DIR/restore-lock.yaml")"
  durable_clear_operation_token="$(test_yaml_field 'yenhubs.org/recovery-token:' \
    "$STUB_STATE_DIR/restore-lock.yaml")"
  seed_stale_restore_helper "$durable_clear_operation_id" \
    "$durable_clear_operation_token"
  durable_clear_confirmation="restore-lock:fixture-context:hcce:fixture-uid:$STAMP:$DURABLE_RESTORE_DUMP_SHA:$DURABLE_RESTORE_STORAGE_SHA:restore-lock-uid:fixture-pvc-uid:$CHECKPOINT_EVIDENCE_SHA:durable-v2"
  durable_clear_delete_base="$(
    cat "$STUB_STATE_DIR/delete-count" 2>/dev/null || printf 0
  )"
  durable_clear_lock_resource_version="$(
    cat "$STUB_STATE_DIR/restore-lock-rv"
  )"
  durable_clear_pod_delete_index=$((durable_clear_delete_base + 1))
  durable_clear_policy_delete_index=$((durable_clear_delete_base + 2))
  durable_clear_lock_delete_index=$((durable_clear_delete_base + 3))
  : >"$KUBECTL_LOG"
  expect_success 'exact durable completed-lock clearance removes only retained helper state and lock' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
    RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
    CONFIRM_CLEAR_RESTORE_LOCK="$durable_clear_confirmation" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  durable_clear_pod_delete_line="$(
    grep -En \
      'delete --raw=/api/v1/namespaces/hcce/pods/ret-storage-restore-' \
      "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :
  )"
  durable_clear_policy_delete_line="$(
    grep -En \
      'delete --raw=/apis/networking.k8s.io/v1/namespaces/hcce/networkpolicies/ret-storage-restore-deny-' \
      "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :
  )"
  durable_clear_lock_delete_line="$(
    grep -En \
      'delete --raw=/api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock ' \
      "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :
  )"
  if [[ ! -e "$STUB_STATE_DIR/pod-created" &&
        ! -e "$STUB_STATE_DIR/network-policy.yaml" &&
        ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     [[ "$(cat "$STUB_STATE_DIR/delete-count")" == \
        "$((durable_clear_delete_base + 3))" ]] &&
     [[ "$durable_clear_lock_resource_version" == lock-rv-2 ]] &&
     recovery_operation_fence_binding_state_is dormant \
       recovery-operation-fence-binding-rv-3 &&
     recovery_operation_fence_binding_was_not_replaced &&
     [[ "$(grep -c 'delete --raw=' "$KUBECTL_LOG" || :)" == 3 ]] &&
     jq -e '
       . == {
         apiVersion:"v1",
         kind:"DeleteOptions",
         propagationPolicy:"Foreground",
         preconditions:{uid:"restore-pod-uid"}
       }
     ' "$STUB_STATE_DIR/delete-options-$durable_clear_pod_delete_index.json" \
       >/dev/null &&
     jq -e '
       . == {
         apiVersion:"v1",
         kind:"DeleteOptions",
         propagationPolicy:"Foreground",
         preconditions:{uid:"network-policy-uid"}
       }
     ' "$STUB_STATE_DIR/delete-options-$durable_clear_policy_delete_index.json" \
       >/dev/null &&
     jq -e --arg rv "$durable_clear_lock_resource_version" '
       . == {
         apiVersion:"v1",
         kind:"DeleteOptions",
         propagationPolicy:"Foreground",
         preconditions:{uid:"restore-lock-uid",resourceVersion:$rv}
       }
     ' "$STUB_STATE_DIR/delete-options-$durable_clear_lock_delete_index.json" \
       >/dev/null &&
     [[ "$durable_clear_pod_delete_line" =~ ^[0-9]+$ &&
        "$durable_clear_policy_delete_line" =~ ^[0-9]+$ &&
        "$durable_clear_lock_delete_line" =~ ^[0-9]+$ &&
        "$durable_clear_pod_delete_line" -lt "$durable_clear_policy_delete_line" &&
        "$durable_clear_policy_delete_line" -lt "$durable_clear_lock_delete_line" ]] &&
     ! any_deployment_replica_mutation &&
     ! grep -Eq 'rollout status' "$KUBECTL_LOG"; then
    pass 'durable clear-stale deletes helper, policy and lock without workload mutation'
  else
    fail 'durable clear-stale exact cleanup-only contract' "$(cat "$KUBECTL_LOG")"
  fi
}

run_storage_helper_pod_snapshot_race_test() (
  local list_path="$TMP_DIR/storage-helper-race-list.json"
  local list_error="$TMP_DIR/storage-helper-race-list.err"
  local final_list_path="$TMP_DIR/storage-helper-race-final-list.json"
  local pod_name list_pid=""
  # Invoked indirectly by the trap installed immediately below.
  # shellcheck disable=SC2317,SC2329
  cleanup_storage_helper_pod_snapshot_race() {
    if [[ "$list_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$list_pid" 2>/dev/null; then
      kill -TERM "$list_pid" 2>/dev/null || :
      wait "$list_pid" 2>/dev/null || :
    fi
  }
  trap cleanup_storage_helper_pod_snapshot_race EXIT INT TERM
  reset_stub
  seed_stale_restore_helper
  pod_name="$(cat "$STUB_STATE_DIR/pod-name")"
  STUB_MODE=helper-pod-list-delete-race \
    "$TMP_DIR/bin/kubectl" --context fixture-context --request-timeout=45s \
      get pod -n hcce -o json >"$list_path" 2>"$list_error" &
  # The complete test runs in this deliberate function subshell, so the PID is
  # consumed in the same scope in which the background process is created.
  # shellcheck disable=SC2031
  list_pid=$!
  for _ in {1..500}; do
    [[ -e "$STUB_STATE_DIR/helper-pod-list-snapshot-opened" ]] && break
    kill -0 "$list_pid" 2>/dev/null || break
    sleep 0.01
  done
  [[ -e "$STUB_STATE_DIR/helper-pod-list-snapshot-opened" ]] || return 1
  jq -cn '{apiVersion:"v1",kind:"DeleteOptions",propagationPolicy:"Foreground",
    preconditions:{uid:"restore-pod-uid"}}' |
    STUB_MODE=helper-pod-list-delete-race \
      "$TMP_DIR/bin/kubectl" --context fixture-context --request-timeout=45s \
        delete --raw="/api/v1/namespaces/hcce/pods/$pod_name" -f - >/dev/null ||
    return 1
  wait "$list_pid" || return 1
  list_pid=""
  jq -e --arg name "$pod_name" '
    .apiVersion == "v1" and .kind == "PodList" and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (.items | length) == 1 and
    .items[0].apiVersion == "v1" and .items[0].kind == "Pod" and
    .items[0].metadata.name == $name and
    .items[0].metadata.namespace == "hcce" and
    .items[0].metadata.uid == "restore-pod-uid" and
    (.items[0].metadata.resourceVersion | type == "string" and length > 0) and
    (.items[0].metadata.labels | type == "object") and
    (.items[0].spec | type == "object")
  ' "$list_path" >/dev/null || return 1
  [[ -e "$STUB_STATE_DIR/helper-pod-delete-finished" &&
     ! -e "$STUB_STATE_DIR/storage-helper-pod-live.json" ]] || return 1
  "$TMP_DIR/bin/kubectl" --context fixture-context --request-timeout=45s \
    get pod -n hcce -o json >"$final_list_path" || return 1
  jq -e '.apiVersion == "v1" and .kind == "PodList" and .items == []' \
    "$final_list_path" >/dev/null || return 1
  seed_stale_restore_helper
  : >"$list_error"
  STUB_MODE=helper-pod-list-open-missing-race \
    "$TMP_DIR/bin/kubectl" --context fixture-context --request-timeout=45s \
      get pod -n hcce -o json >"$final_list_path" 2>"$list_error" || return 1
  [[ ! -s "$list_error" ]] || return 1
  jq -e '.apiVersion == "v1" and .kind == "PodList" and .items == []' \
    "$final_list_path" >/dev/null || return 1
  [[ ! -e "$STUB_STATE_DIR/storage-helper-pod-live.json" ]]
)

if recovery_focus_selected freeze-cluster-ha-shape; then
  ha_values="$TMP_DIR/freeze-cluster-ha-values.yaml"
  cp "$VALUES_PROCESS_LOCAL_FIXTURE" "$ha_values"
  cat >>"$ha_values" <<'YAML'
HUB_DOMAIN: hubs.fixture.invalid
ADM_EMAIL: fixture@example.invalid
DB_USER: fixture-db-user
DB_PASS: fixture-secret-sentinel
SMTP_SERVER: smtp.fixture.invalid
SMTP_PORT: 2525
SMTP_USER: fixture-smtp-user
SMTP_PASS: fixture-secret-sentinel
NODE_COOKIE: fixture-secret-sentinel
GUARDIAN_KEY: fixture-secret-sentinel
PHX_KEY: fixture-secret-sentinel
PERMS_KEY: fixture-secret-sentinel
BOT_ACCESS_KEY: fixture-secret-sentinel
OPENAI_API_KEY: fixture-secret-sentinel
GENERATE_PERSISTENT_VOLUMES: true
PERSISTENT_VOLUME_STORAGE_CLASS: do-block-storage
PERSISTENT_VOLUME_SIZE: 10Gi
YAML
  chmod 600 "$ha_values"
  ha_capture_env=(
    CAPTURE_STATE_FORMAT=freeze-bundle-v1
    RECOVERY_CHECKPOINT_CAPTURE_RUNNER_MODE=process-local
    EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid
    VALUES_FILE="$ha_values" STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON"
    FREEZE_DNS_PROVIDER=fixture-dns FREEZE_SMTP_PROVIDER=fixture-smtp
    FREEZE_ROOM_ID=VJopCY3 FREEZE_SCENE_ID=f6VKtim
    FREEZE_SPOKE_PROJECT_ID=qa3U3Ke FREEZE_RESPONSIBLE_OWNER=fixture-owner
    FREEZE_COST_GATE_CHECKED_AT=2026-08-09T12:00:00Z
    FREEZE_ESTIMATED_MONTHLY_USD=65
  )

  for accepted_ha_shape in absent false; do
    reset_stub
    ha_output="$TMP_DIR/freeze-cluster-ha-$accepted_ha_shape"
    expect_success "freeze capture accepts cluster HA $accepted_ha_shape" \
      env "${ha_capture_env[@]}" STUB_DOCTL_CLUSTER_HA="$accepted_ha_shape" \
      "$ROOT_DIR/deployment/capture-instance-state.sh" "$ha_output"
    if jq -e '.cluster.ha_control_plane == false' \
        "$ha_output/infrastructure-recipe.json" >/dev/null; then
      pass "cluster HA $accepted_ha_shape emits ha_control_plane false"
    else
      fail "cluster HA $accepted_ha_shape normalization" \
        'infrastructure recipe did not emit false'
    fi
  done

  for rejected_ha_shape in true string; do
    reset_stub
    expect_failure "freeze capture rejects cluster HA $rejected_ha_shape" \
      'exact low-cost source recipe' \
      env "${ha_capture_env[@]}" STUB_DOCTL_CLUSTER_HA="$rejected_ha_shape" \
      "$ROOT_DIR/deployment/capture-instance-state.sh" \
      "$TMP_DIR/freeze-cluster-ha-$rejected_ha_shape"
  done

  recovery_finish_focus 'Focused cluster HA shape'
fi

if recovery_focus_selected inventory-mozilla-repositories; then
  printf -v inventory_digest '%064d' 0
  mozilla_inventory="$TMP_DIR/process-local-schema4-mozilla-inventory.json"
  mozilla_lookalike="$TMP_DIR/process-local-schema4-mozilla-lookalike.json"
  mozilla_cross_pair="$TMP_DIR/process-local-schema4-mozilla-cross-pair.json"
  jq --arg digest "$inventory_digest" '
    {schema_version:4,namespace:"hcce",namespace_uid:"fixture-uid",
      bot_runner_runtime:{generation:"legacy-absent",mode:"process-local",image:null,
        control_plane:{state:"legacy-absent"},recovery_epoch:{state:"legacy-absent"}},
      deployments:[.items[] | {name:.metadata.name,uid:.metadata.uid,
        replicas:.spec.replicas,init_containers:[],
        containers:[.spec.template.spec.containers[] | {name,image}]}]} |
    (.deployments[] | select(.name == "pgbouncer") |
      .containers[] | select(.name == "pgbouncer") | .image) =
        ("docker.io/mozillareality/pgbouncer@sha256:" + $digest) |
    (.deployments[] | select(.name == "pgbouncer-t") |
      .containers[] | select(.name == "pgbouncer-t") | .image) =
        ("docker.io/mozillareality/pgbouncer@sha256:" + $digest) |
    (.deployments[] | select(.name == "pgsql") |
      .containers[] | select(.name == "postgresql") | .image) =
        ("docker.io/mozillareality/postgres@sha256:" + $digest) |
    (.deployments[] | select(.name == "reticulum") |
      .containers[] | select(.name == "postgrest") | .image) =
        ("docker.io/mozillareality/postgrest@sha256:" + $digest)
  ' "$LEGACY_DEPLOYMENTS_JSON" >"$mozilla_inventory"
  jq --arg digest "$inventory_digest" '
    (.deployments[] | select(.name == "pgbouncer") |
      .containers[] | select(.name == "pgbouncer") | .image) =
        ("docker.io/mozillareality/pgbouncer-lookalike@sha256:" + $digest)
  ' "$mozilla_inventory" >"$mozilla_lookalike"
  jq --arg digest "$inventory_digest" '
    (.deployments[] | select(.name == "reticulum") |
      .containers[] | select(.name == "postgrest") | .image) =
        ("docker.io/mozillareality/postgres@sha256:" + $digest)
  ' "$mozilla_inventory" >"$mozilla_cross_pair"

  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_success 'schema-4 process-local inventory accepts exact historical Mozilla repositories' \
    bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid "" No' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$mozilla_inventory"
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'schema-4 process-local inventory rejects a Mozilla lookalike' '' \
    bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid "" No' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$mozilla_lookalike"
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'schema-4 process-local inventory rejects a Mozilla cross-pair repository' '' \
    bash -c 'source "$1"; recovery_deployment_inventory_is_acceptable "$2" hcce fixture-uid "" No' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$mozilla_cross_pair"

  recovery_finish_focus 'Focused Mozilla inventory'
fi

if recovery_focus_selected freeze-ret-config-scope; then
  inert_section=$'\n[ret."Elixir.Ret.BotOrchestrator"]\nendpoint = "http://bot-orchestrator.<POD_NS>:5001"\naccess_key = "<BOT_ACCESS_KEY>"\n'
  inert_ret_config="$TMP_DIR/freeze-ret-config-inert.json"
  inert_other_key="$TMP_DIR/freeze-ret-config-other-key.json"
  inert_isolated_marker="$TMP_DIR/freeze-ret-config-isolated-marker.json"
  jq --arg section "$inert_section" \
    '.data["config.toml.template"] += $section' \
    "$LEGACY_RET_CONFIG_JSON" >"$inert_ret_config"
  jq --arg section "$inert_section" '.data.other = $section' \
    "$LEGACY_RET_CONFIG_JSON" >"$inert_other_key"
  jq --arg section "$inert_section" '
    .data["config.toml.template"] += $section |
    .data.other = "<BOT_RUNNER_ACCESS_KEY>"
  ' "$LEGACY_RET_CONFIG_JSON" >"$inert_isolated_marker"

  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_success 'freeze helper accepts the exact inert section in config.toml.template' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RET_CONFIG_JSON="$inert_ret_config" \
    bash -c 'source "$1"; recovery_require_live_process_local_freeze_checkpoint_exact "$2" freeze-bundle-v1 process-local' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$VALUES_PROCESS_LOCAL_FIXTURE"

  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'freeze helper rejects the inert section outside config.toml.template' \
    'Reticulum config contains isolated-runner markers' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RET_CONFIG_JSON="$inert_other_key" \
    bash -c 'source "$1"; recovery_require_live_process_local_freeze_checkpoint_exact "$2" freeze-bundle-v1 process-local' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$VALUES_PROCESS_LOCAL_FIXTURE"

  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'strict helper rejects the exact inert section despite freeze env markers' \
    'Reticulum config contains isolated-runner markers' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    CHECKPOINT_FORMAT=freeze-bundle-v1 CAPTURE_STATE_FORMAT=freeze-bundle-v1 \
    RECOVERY_CHECKPOINT_CAPTURE_RUNNER_MODE=process-local \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RET_CONFIG_JSON="$inert_ret_config" \
    bash -c 'source "$1"; recovery_require_live_process_local_runner_exact "$2"' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$VALUES_PROCESS_LOCAL_FIXTURE"

  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'freeze helper rejects an isolated marker in any ret-config key' \
    'Reticulum config contains isolated-runner markers' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RET_CONFIG_JSON="$inert_isolated_marker" \
    bash -c 'source "$1"; recovery_require_live_process_local_freeze_checkpoint_exact "$2" freeze-bundle-v1 process-local' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$VALUES_PROCESS_LOCAL_FIXTURE"

  recovery_finish_focus 'Focused freeze ret-config scope'
fi

if recovery_focus_selected freeze-rolling-current-rs; then
  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_success 'RollingUpdate boundary accepts the exact controller-injected current RS' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON" \
    bash -c 'source "$1"; recovery_capture_process_local_freeze_parent_boundary_exact ready-one >/dev/null' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_success 'RollingUpdate boundary accepts omitted item GVK under exact typed lists' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON" \
    STUB_MODE=rolling-list-item-gvk-omitted \
    bash -c 'source "$1"; recovery_capture_process_local_freeze_parent_boundary_exact ready-one >/dev/null' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

  for current_rs_drift in \
    rolling-rs-hash-mismatch rolling-rs-revision-mismatch \
    rolling-rs-template-drift; do
    reset_stub
    # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
    expect_failure "RollingUpdate boundary rejects $current_rs_drift" \
      'not at the exact ready-one boundary' \
      env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
      STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON" \
      STUB_MODE="$current_rs_drift" \
      bash -c 'source "$1"; recovery_capture_process_local_freeze_parent_boundary_exact ready-one >/dev/null' \
        _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  done

  for item_gvk_spoof in \
    rolling-rs-current-gvk-spoof rolling-rs-historical-gvk-spoof \
    rolling-pod-gvk-spoof; do
    reset_stub
    # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
    expect_failure "RollingUpdate boundary rejects $item_gvk_spoof" \
      'not at the exact ready-one boundary' \
      env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
      STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON" \
      STUB_MODE="$item_gvk_spoof" \
      bash -c 'source "$1"; recovery_capture_process_local_freeze_parent_boundary_exact ready-one >/dev/null' \
        _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"
  done

  recovery_finish_focus 'Focused current ReplicaSet'
fi

if recovery_focus_selected freeze-checkpoint-admission-fence ||
   [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-policy-create-lost ||
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-policy-aba ||
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-pre-scale-signal ||
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-matrix-pre-scale ||
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-matrix-post-scale ||
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-dry-run ]]; then
  fence_values="$TMP_DIR/freeze-fence-values.yaml"
  fence_node_bin="$TMP_DIR/freeze-fence-bin"
  fence_node_log="$STUB_STATE_DIR/freeze-fence-watcher-node.log"
  fence_helper_image="ghcr.io/yengalvez/reticulum@sha256:$(printf '6%.0s' {1..64})"
  cp "$VALUES_PROCESS_LOCAL_FIXTURE" "$fence_values"
  cat >>"$fence_values" <<'YAML'
HUB_DOMAIN: hubs.fixture.invalid
ADM_EMAIL: fixture@example.invalid
DB_USER: fixture-db-user
DB_PASS: fixture-secret-sentinel
SMTP_SERVER: smtp.fixture.invalid
SMTP_PORT: 2525
SMTP_USER: fixture-smtp-user
SMTP_PASS: fixture-secret-sentinel
NODE_COOKIE: fixture-secret-sentinel
GUARDIAN_KEY: fixture-secret-sentinel
PHX_KEY: fixture-secret-sentinel
PERMS_KEY: fixture-secret-sentinel
BOT_ACCESS_KEY: fixture-secret-sentinel
OPENAI_API_KEY: fixture-secret-sentinel
GENERATE_PERSISTENT_VOLUMES: true
PERSISTENT_VOLUME_STORAGE_CLASS: do-block-storage
PERSISTENT_VOLUME_SIZE: 10Gi
YAML
  chmod 600 "$fence_values"
  mkdir -p "$fence_node_bin"
  real_fence_node="$(command -v node)"
  cat >"$fence_node_bin/node" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == */watch-checkpoint-writers.mjs ]]; then
  printf '%s\n' "$*" >>"$STUB_FENCE_NODE_LOG"
fi
exec "$STUB_REAL_NODE" "$@"
STUB
  chmod 700 "$fence_node_bin/node"
  # shellcheck disable=SC2031 # Consume the parent PATH value; do not rely on a fixture subshell mutation.
  fence_common_env=(
    ALLOW_CHECKPOINT_DOWNTIME=1 CHECKPOINT_FORMAT=freeze-bundle-v1
    CLIENT_INSTANCE_ID=fixture-client-001
    FREEZE_DNS_PROVIDER=fixture-dns FREEZE_SMTP_PROVIDER=fixture-smtp
    FREEZE_ROOM_ID=VJopCY3 FREEZE_SCENE_ID=f6VKtim
    FREEZE_SPOKE_PROJECT_ID=qa3U3Ke FREEZE_RESPONSIBLE_OWNER=fixture-owner
    FREEZE_COST_GATE_CHECKED_AT=2026-08-09T12:00:00Z
    FREEZE_ESTIMATED_MONTHLY_USD=65
    EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$fence_values"
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON"
    RECOVERY_STREAM_POLL_SECONDS=0.01
    PATH="$fence_node_bin:$PATH" STUB_REAL_NODE="$real_fence_node"
    STUB_FENCE_NODE_LOG="$fence_node_log"
  )

  all_fence_writers_are() {
    local expected="$1" deployment
    for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
      [[ "$(cat "$STUB_STATE_DIR/replicas-$deployment" 2>/dev/null || printf 1)" == \
         "$expected" ]] || return 1
    done
  }

  fence_lease_is_owned() {
    jq -e '(.spec.holderIdentity // "") != ""' \
      "$STUB_STATE_DIR/serialization-lease.json" >/dev/null 2>&1
  }

  fence_abort_on_failure() {
    if [[ "$FAIL_COUNT" -ne 0 ]]; then
      printf '%s focused freeze admission fence test(s) failed; %s passed.\n' \
        "$FAIL_COUNT" "$PASS_COUNT" >&2
      exit 1
    fi
  }

  run_freeze_fence_library_case() {
    local action="$1" mode="${2:-}"
    # shellcheck disable=SC2016,SC2031 # PATH is explicit; positional parameters expand in the child shell.
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce STUB_MODE="$mode" \
      RECOVERY_WAIT_RETRY_DELAY_SECONDS=0 \
      STUB_FREEZE_FENCE_CAPABILITY_MARKER="$STUB_STATE_DIR/freeze-fence-capability-issued" \
      STUB_REAL_NODE="$real_fence_node" STUB_FENCE_NODE_LOG="$fence_node_log" \
      PATH="$fence_node_bin:$PATH" \
      bash -c '
        set -Eeuo pipefail
        source "$1"
        cleanup_freeze_fence_library_case() {
          recovery_cleanup_partial_freeze_checkpoint_fence >/dev/null 2>&1 || :
          recovery_release_operation_serialization >/dev/null 2>&1 || :
        }
        trap cleanup_freeze_fence_library_case EXIT INT TERM
        NAMESPACE=hcce
        RECOVERY_NAMESPACE_UID=fixture-uid
        RECOVERY_OPERATION_ID=0123456789abcdef0123456789abcdef
        RECOVERY_OPERATION_LOCK_UID=restore-lock-uid
        RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=lock-rv-1
        recovery_acquire_operation_serialization root-recovery
        recovery_require_operation_lock() { return 0; }
        recovery_create_freeze_checkpoint_fence "$2"
        [[ -z "${STUB_FREEZE_FENCE_CAPABILITY_MARKER:-}" ]] ||
          printf issued >"$STUB_FREEZE_FENCE_CAPABILITY_MARKER"
        case "$3" in
          create) : ;;
          create-probe-delete)
            recovery_probe_freeze_checkpoint_fence \
              "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY"
            recovery_delete_freeze_checkpoint_fence \
              "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY"
            ;;
          *) return 2 ;;
        esac
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
        "$fence_helper_image" "$action"
  }

  run_fence_signal_case() {
    local mode="$1" marker="$2" output="$3" log="$4" driver status=0
    FENCE_SIGNAL_STATUS="unset"
    # shellcheck disable=SC2016 # Positional parameters and $$ expand in the child shell.
    env "${fence_common_env[@]}" STUB_MODE="$mode" \
      bash -c '
        export STUB_CHECKPOINT_DRIVER_PID=$$
        exec "$1" "$2"
      ' _ "$ROOT_DIR/deployment/create-checkpoint.sh" "$output" >"$log" 2>&1 &
    # shellcheck disable=SC2031 # Capture the background PID created by this function, not a subshell value.
    driver=$!
    for _ in {1..300}; do
      [[ -e "$STUB_STATE_DIR/$marker" ]] && break
      kill -0 "$driver" 2>/dev/null || break
      sleep 0.01
    done
    if [[ ! -e "$STUB_STATE_DIR/$marker" ]]; then
      if wait "$driver"; then status=0; else status=$?; fi
      FENCE_SIGNAL_STATUS="$status"
      return 1
    fi
    if wait "$driver"; then status=0; else status=$?; fi
    FENCE_SIGNAL_STATUS="$status"
    [[ "$FENCE_SIGNAL_STATUS" == 143 &&
       -e "$STUB_STATE_DIR/${marker%-ready}-sent" ]]
  }

  assert_freeze_fence_pre_scale_signal_boundary() {
    local output="$1" log="$2" pass_label="$3" fail_label="$4"
    local status143=false sent=false policy_absent=false binding_absent=false
    local lock_absent=false lease_free=false writers_original=false
    local bundle_absent=false
    reset_stub
    run_fence_signal_case freeze-fence-create-signal \
      freeze-fence-create-signal-ready "$output" "$log" || :
    if [[ "$FENCE_SIGNAL_STATUS" == 143 ]]; then status143=true; fi
    if [[ -e "$STUB_STATE_DIR/freeze-fence-create-signal-sent" ]]; then sent=true; fi
    if [[ ! -e "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" ]]; then
      policy_absent=true
    fi
    if [[ ! -e "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" ]]; then
      binding_absent=true
    fi
    if [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then lock_absent=true; fi
    if ! fence_lease_is_owned; then lease_free=true; fi
    if ! any_deployment_replica_mutation; then writers_original=true; fi
    if [[ ! -e "$output" ]]; then bundle_absent=true; fi
    if [[ "$status143" == true && "$sent" == true &&
          "$policy_absent" == true && "$binding_absent" == true &&
          "$lock_absent" == true && "$lease_free" == true &&
          "$writers_original" == true && "$bundle_absent" == true ]]; then
      pass "$pass_label"
    else
      fail "$fail_label" \
        "status143=$status143 sent=$sent policy_absent=$policy_absent binding_absent=$binding_absent lock_absent=$lock_absent lease_free=$lease_free writers_original=$writers_original bundle_absent=$bundle_absent"
    fi
  }

  assert_freeze_fence_post_scale_signal_boundary() {
    local output="$1" log="$2" pass_label="$3" fail_label="$4"
    local status143=false sent=false policy_absent=false binding_absent=false
    local writers_resumed=false delete_before_resume=false
    local policy_delete_line first_resume_line
    reset_stub
    run_fence_signal_case freeze-fence-delete-signal \
      freeze-fence-delete-signal-ready "$output" "$log" || :
    if [[ "$FENCE_SIGNAL_STATUS" == 143 ]]; then status143=true; fi
    if [[ -e "$STUB_STATE_DIR/freeze-fence-delete-signal-sent" ]]; then sent=true; fi
    if [[ ! -e "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" ]]; then
      policy_absent=true
    fi
    if [[ ! -e "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" ]]; then
      binding_absent=true
    fi
    if all_fence_writers_are 1; then writers_resumed=true; fi
    policy_delete_line="$(grep -n \
      'validatingadmissionpolicies/freeze-checkpoint' "$KUBECTL_LOG" |
      tail -1 | cut -d: -f1 || :)"
    first_resume_line="$(deployment_patch_first_line bot-orchestrator 1)"
    if [[ -n "$policy_delete_line" && -n "$first_resume_line" &&
          "$policy_delete_line" -lt "$first_resume_line" ]]; then
      delete_before_resume=true
    fi
    if [[ "$status143" == true && "$sent" == true &&
          "$policy_absent" == true && "$binding_absent" == true &&
          "$writers_resumed" == true && "$delete_before_resume" == true ]]; then
      pass "$pass_label"
    else
      fail "$fail_label" \
        "status143=$status143 sent=$sent policy_absent=$policy_absent binding_absent=$binding_absent writers_resumed=$writers_resumed delete_before_resume=$delete_before_resume"
    fi
  }

  if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-pre-scale-signal ]]; then
    assert_freeze_fence_pre_scale_signal_boundary \
      "$TMP_DIR/freeze-fence-pre-scale-signal" \
      "$TMP_DIR/freeze-fence-pre-scale-signal.log" \
      'pre-scale TERM removes its pair, preserves writers and publishes no bundle' \
      'pre-scale TERM isolated cleanup boundary'
    fence_abort_on_failure
    printf 'Focused pre-scale signal test passed: %s.\n' "$PASS_COUNT"
    exit 0
  fi

  if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-matrix-pre-scale ]]; then
    assert_freeze_fence_pre_scale_signal_boundary \
      "$TMP_DIR/freeze-fence-matrix-pre-scale" \
      "$TMP_DIR/freeze-fence-matrix-pre-scale.log" \
      'pre-scale signal removes only its exact pair before releasing lock and Lease' \
      'pre-scale signal cleanup boundary'
    fence_abort_on_failure
    printf 'Focused matrix pre-scale signal test passed: %s.\n' "$PASS_COUNT"
    exit 0
  fi

  if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-matrix-post-scale ]]; then
    assert_freeze_fence_post_scale_signal_boundary \
      "$TMP_DIR/freeze-fence-matrix-post-scale" \
      "$TMP_DIR/freeze-fence-matrix-post-scale.log" \
      'post-scale signal resumes only after confirmed binding and policy removal' \
      'post-scale signal cleanup boundary'
    fence_abort_on_failure
    printf 'Focused matrix post-scale signal test passed: %s.\n' "$PASS_COUNT"
    exit 0
  fi

  assert_freeze_fence_dry_run_preflight() {
    local mode="$1" expected_dry_runs="$2"
    local persistent_creates dry_runs
    reset_stub
    seed_serialization_lease
    expect_failure "$mode rejects the noncanonical server dry-run response" '' \
      run_freeze_fence_library_case create "$mode"
    persistent_creates="$(grep -Ec ' create -f - -o json$' "$KUBECTL_LOG" || :)"
    dry_runs="$(grep -Ec ' create --dry-run=server -f - -o json$' \
      "$KUBECTL_LOG" || :)"
    if [[ "$persistent_creates" == 0 && "$dry_runs" == "$expected_dry_runs" &&
          ! -e "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" &&
          ! -e "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" ]]; then
      pass "$mode performs zero persistent CREATE operations"
    else
      fail "$mode dry-run zero-mutation boundary" \
        "persistent_creates=$persistent_creates dry_runs=$dry_runs"
    fi
  }

  if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-dry-run ]]; then
    for dry_run_case in \
      freeze-fence-dry-run-policy-drift:1 \
      freeze-fence-dry-run-binding-drift:2; do
      assert_freeze_fence_dry_run_preflight \
        "${dry_run_case%%:*}" "${dry_run_case##*:}"
      fence_abort_on_failure
    done
    printf 'Focused freeze fence server dry-run tests passed: %s.\n' "$PASS_COUNT"
    exit 0
  fi

  if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-policy-create-lost ]]; then
    reset_stub
    seed_serialization_lease
    expect_success 'lost policy CREATE adopts the one exact committed policy and completes its pair' \
      run_freeze_fence_library_case create-probe-delete \
        freeze-fence-policy-create-lost
    policy_create_count="$(cat \
      "$STUB_STATE_DIR/freeze-fence-policy-create-count" 2>/dev/null || printf 0)"
    binding_create_count="$(cat \
      "$STUB_STATE_DIR/freeze-fence-binding-create-count" 2>/dev/null || printf 0)"
    policy_create_line="$(grep -n 'create -f - -o json' "$KUBECTL_LOG" |
      head -1 | cut -d: -f1 || :)"
    policy_reconcile_line="$(grep -n \
      'get validatingadmissionpolicy freeze-checkpoint-pod-create-fence.yenhubs.org -o json' \
      "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
    if [[ "$policy_create_count" == 1 && "$binding_create_count" == 1 &&
          -n "$policy_create_line" && -n "$policy_reconcile_line" &&
          "$policy_create_line" -lt "$policy_reconcile_line" ]]; then
      pass 'lost policy response performs exactly one policy CREATE before exact GET adoption'
    else
      fail 'lost policy CREATE/GET causal cardinality' "$(cat "$KUBECTL_LOG")"
    fi
    fence_abort_on_failure
    printf 'Focused lost policy CREATE test passed: %s.\n' "$PASS_COUNT"
    exit 0
  fi

  if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == freeze-fence-policy-aba ]]; then
    reset_stub
    seed_serialization_lease
    expect_failure 'post-adoption policy ABA fails acquisition' '' \
      run_freeze_fence_library_case create freeze-fence-policy-aba
    policy_live_get_count="$(cat \
      "$STUB_STATE_DIR/freeze-fence-policy-live-get-count" \
      2>/dev/null || printf 0)"
    if [[ "$policy_live_get_count" -ge 2 &&
          "$(jq -r '.metadata.uid' \
          "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json")" == \
            freeze-fence-policy-replacement-uid &&
          ! -e "$STUB_STATE_DIR/freeze-fence-capability-issued" ]] &&
       ! any_deployment_replica_mutation; then
      pass 'policy ABA fixture replaces UID after adoption without capability or resume'
    else
      fail 'policy ABA isolated stage boundary' \
        "gets=$policy_live_get_count capability_marker=$(test -e "$STUB_STATE_DIR/freeze-fence-capability-issued" && printf present || printf absent)"
    fi
    fence_abort_on_failure
    printf 'Focused policy ABA test passed: %s.\n' "$PASS_COUNT"
    exit 0
  fi

  expect_success 'pure admission fence builder and request validator reject every helper variant' \
    "$real_fence_node" --test \
      "$ROOT_DIR/tests/scripts/freeze-checkpoint-admission-fence.test.mjs"
  fence_abort_on_failure

  # shellcheck disable=SC2016 # The exact probe is built inside the isolated shell.
  expect_success 'shell helper probe carries the exact bounded termination grace' \
    bash -c '
      set -euo pipefail
      NAMESPACE=hcce
      source "$1"
      input="$(jq -cn \
        --arg namespace hcce --arg namespace_uid fixture-uid \
        --arg operation_id 0123456789abcdef0123456789abcdef \
        --arg lock_uid restore-lock-uid --arg lock_resource_version lock-rv-1 \
        --arg lease_uid serialization-lease-uid \
        --arg lease_holder root-recovery:0123456789abcdef0123456789abcdef \
        --arg helper_image "$2" \
        "{namespace:\$namespace,namespace_uid:\$namespace_uid,
          operation_id:\$operation_id,lock_uid:\$lock_uid,
          lock_resource_version:\$lock_resource_version,lease_uid:\$lease_uid,
          lease_holder:\$lease_holder,helper_image:\$helper_image}")"
      recovery_freeze_checkpoint_fence_probe_document "$input" helper |
        jq -e ".spec.terminationGracePeriodSeconds == 1"
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$fence_helper_image"
  fence_abort_on_failure

  for preexisting_mode in freeze-fence-preexisting freeze-fence-partial-preexisting; do
    reset_stub
    seed_serialization_lease
    expect_failure "$preexisting_mode is rejected before any fence or writer mutation" '' \
      run_freeze_fence_library_case create "$preexisting_mode"
    if any_deployment_replica_mutation; then
      fail "$preexisting_mode zero-writer-mutation boundary" "$(cat "$KUBECTL_LOG")"
    else
      pass "$preexisting_mode leaves writer replicas untouched"
    fi
    fence_abort_on_failure
  done

  for lost_create_mode in freeze-fence-policy-create-lost freeze-fence-binding-create-lost; do
    reset_stub
    seed_serialization_lease
    expect_success "$lost_create_mode adopts only the exact committed object" \
      run_freeze_fence_library_case create-probe-delete "$lost_create_mode"
    if [[ "$(grep -Ec 'create -f - -o json' "$KUBECTL_LOG" || :)" == 2 ]]; then
      pass "$lost_create_mode performs no create retry"
    else
      fail "$lost_create_mode create cardinality" "$(cat "$KUBECTL_LOG")"
    fi
    fence_abort_on_failure
  done

  for create_get_failure_mode in \
    freeze-fence-policy-create-get-failure \
    freeze-fence-binding-create-get-failure; do
    reset_stub
    create_get_failure_output="$TMP_DIR/$create_get_failure_mode"
    expect_failure "$create_get_failure_mode fails closed after committed CREATE" '' \
      env "${fence_common_env[@]}" STUB_MODE="$create_get_failure_mode" \
      "$ROOT_DIR/deployment/create-checkpoint.sh" "$create_get_failure_output"
    policy_create_count="$(cat \
      "$STUB_STATE_DIR/freeze-fence-policy-create-count" 2>/dev/null || printf 0)"
    binding_create_count="$(cat \
      "$STUB_STATE_DIR/freeze-fence-binding-create-count" 2>/dev/null || printf 0)"
    expected_binding_create_count=1
    if [[ "$create_get_failure_mode" == freeze-fence-policy-create-get-failure ]]; then
      expected_binding_create_count=0
    fi
    create_get_count="$(grep -Ec \
      'get validatingadmissionpolicy(binding)? freeze-checkpoint-pod-create-fence.yenhubs.org( --ignore-not-found)? -o json' \
      "$KUBECTL_LOG" || :)"
    dry_run_count="$(grep -Ec ' create --dry-run=server -f - -o json$' \
      "$KUBECTL_LOG" || :)"
    if [[ "$policy_create_count" == 1 &&
          "$binding_create_count" == "$expected_binding_create_count" &&
          "$create_get_count" -ge 4 &&
          -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
       fence_lease_is_owned && ! any_deployment_replica_mutation &&
       [[ ! -e "$create_get_failure_output" ]] &&
       [[ "$dry_run_count" == 2 ]]; then
      pass "$create_get_failure_mode retains lock and Lease without continuing"
    else
      fail "$create_get_failure_mode post-CREATE GET fail-closed boundary" \
        "policy_create=$policy_create_count binding_create=$binding_create_count gets=$create_get_count dry_runs=$dry_run_count"
    fi
    fence_abort_on_failure
  done

  assert_freeze_fence_dry_run_preflight freeze-fence-dry-run-policy-drift 1
  fence_abort_on_failure
  assert_freeze_fence_dry_run_preflight freeze-fence-dry-run-binding-drift 2
  fence_abort_on_failure

  for drift_mode in freeze-fence-policy-aba freeze-fence-binding-drift; do
    reset_stub
    seed_serialization_lease
    expect_failure "$drift_mode cannot become a fence capability" '' \
      run_freeze_fence_library_case create "$drift_mode"
    if [[ "$drift_mode" == freeze-fence-policy-aba ]]; then
      if [[ "$(cat "$STUB_STATE_DIR/freeze-fence-policy-live-get-count" \
             2>/dev/null || printf 0)" -ge 2 ]] &&
         [[ "$(jq -r '.metadata.uid' \
             "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json")" == \
            freeze-fence-policy-replacement-uid ]]; then
        pass 'policy ABA occurs only after the original GET adoption boundary'
      else
        fail 'policy ABA fixture stage diagnostic' 'replacement was not post-adoption'
      fi
    fi
    fence_abort_on_failure
  done

  reset_stub
  fence_positive_output="$TMP_DIR/freeze-fence-positive"
  expect_success 'freeze fence creates, probes, streams, reconciles lost deletes and resumes' \
    env "${fence_common_env[@]}" STUB_MODE=freeze-fence-delete-committed-lost \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$fence_positive_output"
  if [[ -d "$fence_positive_output" ]] && all_fence_writers_are 1 &&
     [[ ! -e "$STUB_STATE_DIR/freeze-checkpoint-fence-policy.json" &&
        ! -e "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" &&
        ! -e "$STUB_STATE_DIR/db-source-monitor-inflight-observed" &&
        ! -s "$fence_node_log" ]]; then
    pass 'the H5-B3 lane publishes only after exact fence removal and never starts the writer watcher'
  else
    fail 'positive H5-B3 publication/fence/watcher boundary' "$(cat "$KUBECTL_LOG")"
  fi
  fence_abort_on_failure

  for barrier_mode in freeze-fence-db-barrier-loss freeze-fence-storage-barrier-loss; do
    reset_stub
    expect_failure "$barrier_mode aborts before publication" '' \
      env "${fence_common_env[@]}" STUB_MODE="$barrier_mode" \
      "$ROOT_DIR/deployment/create-checkpoint.sh" "$TMP_DIR/$barrier_mode"
    if [[ ! -e "$TMP_DIR/$barrier_mode" ]] && all_fence_writers_are 0 &&
       [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && fence_lease_is_owned; then
      pass "$barrier_mode retains five zero writers under the exact lock and Lease"
    else
      fail "$barrier_mode fail-closed boundary" "$(cat "$KUBECTL_LOG")"
    fi
    fence_abort_on_failure
  done

  reset_stub
  expect_failure 'ambiguous present fence delete retains the zero boundary' '' \
    env "${fence_common_env[@]}" STUB_MODE=freeze-fence-delete-ambiguous-present \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
      "$TMP_DIR/freeze-fence-delete-ambiguous-present"
  if all_fence_writers_are 0 && [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     fence_lease_is_owned &&
     [[ -e "$STUB_STATE_DIR/freeze-checkpoint-fence-binding.json" ]]; then
    pass 'ambiguous present delete retains writers zero, fence, lock and Lease'
  else
    fail 'ambiguous present delete fail-closed boundary' "$(cat "$KUBECTL_LOG")"
  fi
  fence_abort_on_failure

  assert_freeze_fence_pre_scale_signal_boundary \
    "$TMP_DIR/freeze-fence-pre-scale-signal" \
    "$TMP_DIR/freeze-fence-pre-scale-signal.log" \
    'pre-scale signal removes only its exact pair before releasing lock and Lease' \
    'pre-scale signal cleanup boundary'
  fence_abort_on_failure

  assert_freeze_fence_post_scale_signal_boundary \
    "$TMP_DIR/freeze-fence-post-scale-signal" \
    "$TMP_DIR/freeze-fence-post-scale-signal.log" \
    'post-scale signal resumes only after confirmed binding and policy removal' \
    'post-scale signal cleanup boundary'
  fence_abort_on_failure

  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'freeze environment cannot relax the strict historical process-local helper' \
    'does not match its exact checkpoint contract' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    CHECKPOINT_FORMAT=freeze-bundle-v1 CAPTURE_STATE_FORMAT=freeze-bundle-v1 \
    RECOVERY_CHECKPOINT_CAPTURE_RUNNER_MODE=process-local \
    STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON" \
    bash -c 'source "$1"; recovery_require_live_process_local_runner_exact "$2"' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$fence_values"
  # shellcheck disable=SC2016 # The grep patterns intentionally match literal shell variables.
  if grep -q 'checkpoint_uses_freeze_admission_fence; then' \
       "$ROOT_DIR/deployment/create-checkpoint.sh" &&
     grep -q 'if \[\[ -n "$PARENT_FREEZE_FENCE_CAPABILITY" \]\]; then' \
       "$ROOT_DIR/deployment/backup-retdb.sh" \
       "$ROOT_DIR/deployment/backup-ret-storage-quiesced.sh"; then
    pass 'legacy and durable branches remain outside the capability-selected exception'
  else
    fail 'strict legacy/durable branch regression' 'capability branch is not explicit'
  fi
  fence_abort_on_failure

  recovery_finish_focus 'Focused freeze admission fence'
fi

if recovery_focus_selected freeze-rolling-checkpoint; then
  rolling_values="$TMP_DIR/freeze-rolling-values.yaml"
  cp "$VALUES_PROCESS_LOCAL_FIXTURE" "$rolling_values"
  cat >>"$rolling_values" <<'YAML'
HUB_DOMAIN: hubs.fixture.invalid
ADM_EMAIL: fixture@example.invalid
DB_USER: fixture-db-user
DB_PASS: fixture-secret-sentinel
SMTP_SERVER: smtp.fixture.invalid
SMTP_PORT: 2525
SMTP_USER: fixture-smtp-user
SMTP_PASS: fixture-secret-sentinel
NODE_COOKIE: fixture-secret-sentinel
GUARDIAN_KEY: fixture-secret-sentinel
PHX_KEY: fixture-secret-sentinel
PERMS_KEY: fixture-secret-sentinel
BOT_ACCESS_KEY: fixture-secret-sentinel
OPENAI_API_KEY: fixture-secret-sentinel
GENERATE_PERSISTENT_VOLUMES: true
PERSISTENT_VOLUME_STORAGE_CLASS: do-block-storage
PERSISTENT_VOLUME_SIZE: 10Gi
YAML
  chmod 600 "$rolling_values"
  rolling_common_env=(
    ALLOW_CHECKPOINT_DOWNTIME=1 CHECKPOINT_FORMAT=freeze-bundle-v1
    CLIENT_INSTANCE_ID=fixture-client-001
    FREEZE_DNS_PROVIDER=fixture-dns FREEZE_SMTP_PROVIDER=fixture-smtp
    FREEZE_ROOM_ID=VJopCY3 FREEZE_SCENE_ID=f6VKtim
    FREEZE_SPOKE_PROJECT_ID=qa3U3Ke FREEZE_RESPONSIBLE_OWNER=fixture-owner
    FREEZE_COST_GATE_CHECKED_AT=2026-08-09T12:00:00Z
    FREEZE_ESTIMATED_MONTHLY_USD=65
    EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$rolling_values"
    STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON"
    RECOVERY_STREAM_POLL_SECONDS=0.01
  )
  inert_ret_config="$TMP_DIR/freeze-inert-runner-ret-config.json"
  jq '.data["config.toml.template"] +=
    "\n[ret.\"Elixir.Ret.BotOrchestrator\"]\nendpoint = \"http://bot-orchestrator.<POD_NS>:5001\"\naccess_key = \"<BOT_ACCESS_KEY>\"\n"' \
    "$LEGACY_RET_CONFIG_JSON" >"$inert_ret_config"

  reset_stub
  rolling_output="$TMP_DIR/freeze-rolling-positive"
  expect_success 'freeze-only RollingUpdate checkpoint reaches exact 1-0-1 boundaries' \
    env "${rolling_common_env[@]}" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$rolling_output"
  rolling_parent_patch_count="$(
    grep -Ec 'patch deployment bot-orchestrator ' "$KUBECTL_LOG" || :
  )"
  if [[ "$rolling_parent_patch_count" == 2 &&
        "$(deployment_patch_count bot-orchestrator 0)" == 1 &&
        "$(deployment_patch_count bot-orchestrator 1)" == 1 &&
        "$(cat "$STUB_STATE_DIR/max-pods-bot-orchestrator" 2>/dev/null || :)" == 1 ]] &&
     [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 1 ]] &&
     ! grep 'patch deployment bot-orchestrator ' "$KUBECTL_LOG" |
       grep -q 'checkpoint-resume-operation' &&
     [[ "$(grep 'patch deployment bot-orchestrator ' "$KUBECTL_LOG" |
       grep -c '"path":"/metadata/generation".*"path":"/spec"' || :)" == 2 ]]; then
    pass 'RollingUpdate parent uses two full-spec replica-only CAS operations and never exceeds one Pod'
  else
    fail 'RollingUpdate parent exact replica-only CAS trace' "$(cat "$KUBECTL_LOG")"
  fi

  reset_stub
  expect_success 'freeze checkpoint accepts one exact inert process-local Reticulum section' \
    env "${rolling_common_env[@]}" STUB_RET_CONFIG_JSON="$inert_ret_config" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/rolling-inert-ret-config"

  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'strict helper rejects the same inert Reticulum section despite freeze env markers' \
    'Reticulum config contains isolated-runner markers' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    CHECKPOINT_FORMAT=freeze-bundle-v1 CAPTURE_STATE_FORMAT=freeze-bundle-v1 \
    RECOVERY_CHECKPOINT_CAPTURE_RUNNER_MODE=process-local \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RET_CONFIG_JSON="$inert_ret_config" \
    bash -c 'source "$1"; recovery_require_live_process_local_runner_exact "$2"' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$rolling_values"

  freeze_ret_env="$TMP_DIR/freeze-inert-ret-config-live-env.json"
  jq '
    (.items[] | select(.metadata.name == "reticulum") |
      .spec.template.spec.containers[] | select(.name == "reticulum") |
      .env) = [{name:"turkeyCfg_BOT_RUNNER_ACCESS_KEY",value:"fixture"}]
  ' "$LEGACY_ROLLING_DEPLOYMENTS_JSON" >"$freeze_ret_env"
  reset_stub
  expect_failure 'freeze inert Reticulum section cannot permit a live runner env binding' \
    '' \
    env "${rolling_common_env[@]}" STUB_DEPLOYMENTS_JSON="$freeze_ret_env" \
    STUB_RET_CONFIG_JSON="$inert_ret_config" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/rolling-inert-ret-config-live-env"

  freeze_runner_secret="$TMP_DIR/freeze-inert-ret-config-live-secret.json"
  jq '.data.BOT_RUNNER_ACCESS_KEY = "eA=="' \
    "$LEGACY_CONFIGS_SECRET_JSON" >"$freeze_runner_secret"
  reset_stub
  expect_failure 'freeze inert Reticulum section cannot permit a live runner Secret key' \
    'configs Secret contains isolated-runner credentials' \
    env "${rolling_common_env[@]}" STUB_RET_CONFIG_JSON="$inert_ret_config" \
    STUB_CONFIGS_SECRET_JSON="$freeze_runner_secret" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/rolling-inert-ret-config-live-secret"

  reset_stub
  expect_success 'committed RollingUpdate resume with lost PATCH response reconciles' \
    env "${rolling_common_env[@]}" STUB_MODE=rolling-resume-committed-lost \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/rolling-resume-committed-lost"
  if [[ -e "$STUB_STATE_DIR/rolling-resume-reconcile-seen" &&
        "$(deployment_patch_count bot-orchestrator 1)" == 1 &&
        "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 1 &&
        ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'lost committed RollingUpdate resume is adopted once and releases the lock'
  else
    fail 'lost committed RollingUpdate resume reconciliation' "$(cat "$KUBECTL_LOG")"
  fi

  for rolling_lost_mode in \
    rolling-resume-uncommitted-lost rolling-resume-ambiguous-lost; do
    reset_stub
    expect_failure "$rolling_lost_mode fails closed" '' \
      env "${rolling_common_env[@]}" STUB_MODE="$rolling_lost_mode" \
      "$ROOT_DIR/deployment/create-checkpoint.sh" \
      "$TMP_DIR/$rolling_lost_mode"
    if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 &&
          -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
      pass "$rolling_lost_mode retains parent zero under the operation lock"
    else
      fail "$rolling_lost_mode fail-closed boundary" "$(cat "$KUBECTL_LOG")"
    fi
  done

  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'strict process-local helper still rejects RollingUpdate outside freeze capture' \
    'does not match its exact checkpoint contract' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    VALUES_FILE="$rolling_values" STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON" \
    bash -c 'source "$1"; recovery_require_live_process_local_runner_exact "$2"' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$rolling_values"
  reset_stub
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'freeze environment markers cannot widen the historical restore gate' \
    'does not match its exact checkpoint contract' \
    env EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce \
    CHECKPOINT_FORMAT=freeze-bundle-v1 CAPTURE_STATE_FORMAT=freeze-bundle-v1 \
    RECOVERY_CHECKPOINT_CAPTURE_RUNNER_MODE=process-local \
    STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON" \
    bash -c 'source "$1"; recovery_require_live_process_local_runner_exact "$2"' \
      _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$rolling_values"
  reset_stub
  expect_failure 'legacy checkpoint format cannot select the RollingUpdate exception' \
    'does not match its exact checkpoint contract' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$rolling_values" STUB_DEPLOYMENTS_JSON="$LEGACY_ROLLING_DEPLOYMENTS_JSON" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$TMP_DIR/rolling-not-freeze"
  if any_deployment_replica_mutation; then
    fail 'non-freeze RollingUpdate rejection mutates writer replicas' "$(cat "$KUBECTL_LOG")"
  else
    pass 'non-freeze RollingUpdate rejection performs zero writer replica mutations'
  fi

  reset_stub
  expect_failure 'Recreate to RollingUpdate lock-window drift fails before downtime' \
    'changed across lock acquisition' \
    env "${rolling_common_env[@]}" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_MODE=rolling-strategy-window-drift \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/rolling-strategy-window-drift"
  if any_deployment_replica_mutation; then
    fail 'strategy lock-window drift mutates writer replicas' "$(cat "$KUBECTL_LOG")"
  else
    pass 'strategy lock-window drift performs zero writer replica mutations'
  fi

  for rolling_preflight_mode in \
    rolling-preflight-deployment-drift rolling-preflight-rollout \
    rolling-preflight-replicaset rolling-preflight-historical-active \
    rolling-preflight-pod rolling-preflight-hpa; do
    reset_stub
    expect_failure "freeze RollingUpdate preflight rejects $rolling_preflight_mode" '' \
      env "${rolling_common_env[@]}" STUB_MODE="$rolling_preflight_mode" \
      "$ROOT_DIR/deployment/create-checkpoint.sh" \
      "$TMP_DIR/$rolling_preflight_mode"
    if any_deployment_replica_mutation; then
      fail "$rolling_preflight_mode mutates writer replicas during preflight" \
        "$(cat "$KUBECTL_LOG")"
    else
      pass "$rolling_preflight_mode performs zero writer replica mutations"
    fi
  done

  reset_stub
  expect_failure 'post-downscale RollingUpdate drift blocks all parent resume' '' \
    env "${rolling_common_env[@]}" STUB_MODE=rolling-post-downscale-drift \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/rolling-post-downscale-drift"
  if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 &&
        "$(deployment_patch_count bot-orchestrator 1)" == 0 &&
        -e "$STUB_STATE_DIR/restore-lock.yaml" ]]; then
    pass 'post-downscale RollingUpdate drift retains parent zero under the operation lock'
  else
    fail 'post-downscale RollingUpdate drift fail-closed boundary' "$(cat "$KUBECTL_LOG")"
  fi

  recovery_finish_focus 'Focused freeze RollingUpdate'
fi

if recovery_focus_selected freeze-bundle-create; then
  freeze_values="$TMP_DIR/freeze-bundle-values.yaml"
  freeze_output="$TMP_DIR/freeze-bundle-created"
  cp "$VALUES_PROCESS_LOCAL_FIXTURE" "$freeze_values"
  cat >>"$freeze_values" <<'YAML'
HUB_DOMAIN: hubs.fixture.invalid
ADM_EMAIL: fixture@example.invalid
DB_USER: fixture-db-user
DB_PASS: fixture-secret-sentinel
SMTP_SERVER: smtp.fixture.invalid
SMTP_PORT: 2525
SMTP_USER: fixture-smtp-user
SMTP_PASS: fixture-secret-sentinel
NODE_COOKIE: fixture-secret-sentinel
GUARDIAN_KEY: fixture-secret-sentinel
PHX_KEY: fixture-secret-sentinel
PERMS_KEY: fixture-secret-sentinel
BOT_ACCESS_KEY: fixture-secret-sentinel
OPENAI_API_KEY: fixture-secret-sentinel
GENERATE_PERSISTENT_VOLUMES: true
PERSISTENT_VOLUME_STORAGE_CLASS: do-block-storage
PERSISTENT_VOLUME_SIZE: 10Gi
YAML
  chmod 600 "$freeze_values"
  reset_stub
  expect_success 'freeze checkpoint publishes the exact v1 bundle and then resumes writers' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 CHECKPOINT_FORMAT=freeze-bundle-v1 \
    CLIENT_INSTANCE_ID=fixture-client-001 \
    FREEZE_DNS_PROVIDER=fixture-dns FREEZE_SMTP_PROVIDER=fixture-smtp \
    FREEZE_ROOM_ID=VJopCY3 FREEZE_SCENE_ID=f6VKtim \
    FREEZE_SPOKE_PROJECT_ID=qa3U3Ke FREEZE_RESPONSIBLE_OWNER=fixture-owner \
    FREEZE_COST_GATE_CHECKED_AT=2026-08-09T12:00:00Z \
    FREEZE_ESTIMATED_MONTHLY_USD=65 \
    EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$freeze_values" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_CHECKPOINT_OUTPUT_PATH="$freeze_output" \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$freeze_output"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_success 'published freeze checkpoint passes the standalone exact validator' bash -c '
    set -euo pipefail
    source "$1"
    recovery_verify_freeze_bundle_directory "$2" "$3"
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$freeze_output" "$STAMP"
  if [[ -e "$STUB_STATE_DIR/checkpoint-publication-before-resume" &&
        ! -e "$STUB_STATE_DIR/checkpoint-resume-before-publication" ]]; then
    pass 'freeze publication is complete before the first writer resumes'
  else
    fail 'freeze publication precedes writer resume' "$(cat "$KUBECTL_LOG")"
  fi
  if [[ "$(find "$freeze_output" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d '[:space:]')" == 9 ]] &&
     ! grep -R -Fq 'fixture-secret-sentinel' "$freeze_output"; then
    pass 'created freeze bundle has nine direct files and no secret sentinel'
  else
    fail 'created freeze bundle exact redaction' \
      "$(find "$freeze_output" -mindepth 1 -maxdepth 1 -print)"
  fi
  recovery_finish_focus 'Focused freeze creation'
fi

if recovery_focus_selected freeze-materialize; then
  FREEZE_BUNDLE="$TMP_DIR/freeze-bundle-materialize"
  make_freeze_bundle "$FREEZE_BUNDLE"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_success 'freeze bundle materializes one private byte-invariant restore snapshot' \
    bash -c '
      set -euo pipefail
      source "$1"
      recovery_materialize_checkpoint "$2/retdb-$3.sql.gz" "$4"
      [[ "$RECOVERY_CHECKPOINT_METADATA_SCHEMA" == freeze-bundle-v1 &&
         "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent &&
         "$RECOVERY_FREEZE_ID" == "99999999999999999999999999999999" &&
         "$RECOVERY_FREEZE_CLIENT_INSTANCE_ID" == fixture-client-001 &&
         "$RECOVERY_FREEZE_SOURCE_CLUSTER_UID" == source-cluster-uid &&
         "$RECOVERY_CHECKPOINT_NAMESPACE_UID" == source-namespace-uid &&
         "$RECOVERY_CHECKPOINT_PVC_UID" == source-pvc-uid &&
         "$RECOVERY_FREEZE_MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ ]]
      [[ "$(find "$(dirname "$RECOVERY_CHECKPOINT_METADATA_COPY")" \
          -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d "[:space:]")" == 9 ]]
      recovery_verify_freeze_bundle_directory \
        "$(dirname "$RECOVERY_CHECKPOINT_METADATA_COPY")" "$3"
      private_dir="$RECOVERY_MATERIALIZED_DIR"
      recovery_cleanup_materialized_checkpoint
      [[ ! -e "$private_dir" && "$RECOVERY_MATERIALIZED_OWNED" == 0 ]]
    ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_BUNDLE" \
      "$STAMP" "$ROOT_DIR/deployment/validate-checkpoint.sh"
  recovery_finish_focus 'Focused freeze materialization'
fi

if recovery_focus_selected cold-rebind-preflight; then
  FREEZE_BUNDLE="$TMP_DIR/freeze-bundle-cold-preflight"
  FREEZE_RECEIPT="$TMP_DIR/freeze-receipt-cold-preflight.json"
  COLD_DEPLOYMENTS="$TMP_DIR/cold-target-deployments.json"
  COLD_WRONG_PULL_SECRET="$TMP_DIR/cold-target-wrong-pull-secret.json"
  make_freeze_bundle "$FREEZE_BUNDLE"
  make_freeze_receipt "$FREEZE_BUNDLE" "$FREEZE_RECEIPT"
  make_cold_rebind_target_deployments "$COLD_DEPLOYMENTS"
  jq '(.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.imagePullSecrets) = [{name:"wrong-pull-secret"}]' \
    "$COLD_DEPLOYMENTS" >"$COLD_WRONG_PULL_SECRET"
  reset_stub
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '0\n' >"$STUB_STATE_DIR/replicas-$deployment"
  done
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_success 'cold rebind binds source content and distinct target identities read-only' \
    env RESTORE_TARGET_MODE=cold-rebind EXPECTED_KUBE_CONTEXT=fixture-context \
      EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
      STUB_DEPLOYMENTS_JSON="$COLD_DEPLOYMENTS" \
      STUB_RET_CONFIG_JSON="$COLD_REBIND_RET_CONFIG_JSON" \
      bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        source "$1"
        recovery_materialize_checkpoint "$2/retdb-$3.sql.gz" "$4"
        VALUES_FILE="$5"
        recovery_require_cluster_identity
        recovery_require_pvc_identity ret-pvc
        recovery_require_cold_rebind_target_bootstrap "$VALUES_FILE"
        RECOVERY_COLD_REBIND_OPERATION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        confirmation="$(recovery_restore_rebind_confirmation_value)"
        [[ "$confirmation" == cold-rebind:fixture-context:hcce:99999999999999999999999999999999:* &&
           "$confirmation" == *:source-cluster-uid:source-namespace-uid:source-pvc-uid:fixture-cluster-anchor-uid:fixture-uid:fixture-pvc-uid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:fixture-client-001 ]]
        recovery_cleanup_materialized_checkpoint
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_BUNDLE" \
        "$STAMP" "$ROOT_DIR/deployment/validate-checkpoint.sh" \
        "$VALUES_PROCESS_LOCAL_FIXTURE"
  : >"$KUBECTL_LOG"
  expect_success 'target reactivation preflight accepts the exact cold bootstrap without mutation' \
    env RESTORE_TARGET_MODE=cold-rebind BACKUP_DIR="$FREEZE_BUNDLE" \
      FREEZE_RECEIPT_PATH="$FREEZE_RECEIPT" VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid STUB_DEPLOYMENTS_JSON="$COLD_DEPLOYMENTS" \
      STUB_RET_CONFIG_JSON="$COLD_REBIND_RET_CONFIG_JSON" \
      "$ROOT_DIR/deployment/preflight-reactivation.sh"
  if grep -Eq '(^| )(create|patch|replace|delete|apply|exec)( |$)' "$KUBECTL_LOG"; then
    fail 'cold target preflight is strictly read-only' "$(cat "$KUBECTL_LOG")"
  else
    pass 'cold target preflight is strictly read-only'
  fi
  typed_list_paths=(
    /apis/apps/v1/namespaces/hcce/deployments
    /api/v1/namespaces/hcce/persistentvolumeclaims
    /apis/batch/v1/namespaces/hcce/jobs
    /apis/batch/v1/namespaces/hcce/cronjobs
    /apis/apps/v1/namespaces/hcce/daemonsets
    /apis/apps/v1/namespaces/hcce/statefulsets
    /api/v1/namespaces/hcce/pods
  )
  typed_list_reads_exact=1
  for typed_list_path in "${typed_list_paths[@]}"; do
    grep -Fq -- "get --raw $typed_list_path" "$KUBECTL_LOG" ||
      typed_list_reads_exact=0
  done
  if [[ "$typed_list_reads_exact" == 1 ]]; then
    pass 'cold target preflight reads every guarded collection from its typed API endpoint'
  else
    fail 'cold target preflight missed a guarded typed collection endpoint' \
      "$(cat "$KUBECTL_LOG")"
  fi
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'cold rebind rejects a noncanonical bot image pull secret' \
    'exact checkpoint contract' \
    env RESTORE_TARGET_MODE=cold-rebind EXPECTED_KUBE_CONTEXT=fixture-context \
      EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
      STUB_DEPLOYMENTS_JSON="$COLD_WRONG_PULL_SECRET" \
      STUB_RET_CONFIG_JSON="$COLD_REBIND_RET_CONFIG_JSON" \
      bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        source "$1"
        recovery_materialize_checkpoint "$2/retdb-$3.sql.gz" "$4"
        recovery_require_cluster_identity
        recovery_require_pvc_identity ret-pvc
        recovery_require_cold_rebind_target_bootstrap "$5"
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_BUNDLE" \
        "$STAMP" "$ROOT_DIR/deployment/validate-checkpoint.sh" \
        "$VALUES_PROCESS_LOCAL_FIXTURE"
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  expect_failure 'cold rebind requires the exact process-local Reticulum block' \
    'Reticulum config' \
    env RESTORE_TARGET_MODE=cold-rebind EXPECTED_KUBE_CONTEXT=fixture-context \
      EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
      STUB_DEPLOYMENTS_JSON="$COLD_DEPLOYMENTS" \
      STUB_RET_CONFIG_JSON="$LEGACY_RET_CONFIG_JSON" \
      bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        source "$1"
        recovery_materialize_checkpoint "$2/retdb-$3.sql.gz" "$4"
        recovery_require_cluster_identity
        recovery_require_pvc_identity ret-pvc
        recovery_require_cold_rebind_target_bootstrap "$5"
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_BUNDLE" \
        "$STAMP" "$ROOT_DIR/deployment/validate-checkpoint.sh" \
        "$VALUES_PROCESS_LOCAL_FIXTURE"
  # shellcheck disable=SC2016 # Positional parameters expand inside bash -c.
  expect_failure 'cold rebind rejects reuse of the source PVC UID' \
    'new Namespace/PVC UIDs' env RESTORE_TARGET_MODE=cold-rebind \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=source-pvc-uid STUB_PVC_UID=source-pvc-uid \
      STUB_DEPLOYMENTS_JSON="$COLD_DEPLOYMENTS" \
      STUB_RET_CONFIG_JSON="$COLD_REBIND_RET_CONFIG_JSON" \
      bash -c '
        set -euo pipefail
        NAMESPACE=hcce
        source "$1"
        recovery_materialize_checkpoint "$2/retdb-$3.sql.gz" "$4"
        VALUES_FILE="$5"
        recovery_require_cluster_identity
        recovery_require_pvc_identity ret-pvc
        recovery_require_cold_rebind_target_bootstrap "$VALUES_FILE"
      ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" "$FREEZE_BUNDLE" \
        "$STAMP" "$ROOT_DIR/deployment/validate-checkpoint.sh" \
        "$VALUES_PROCESS_LOCAL_FIXTURE"
  recovery_finish_focus 'Focused cold-rebind preflight'
fi

if recovery_focus_selected cold-rebind-execute; then
  FREEZE_BUNDLE="$TMP_DIR/freeze-bundle-cold-execute"
  FREEZE_RECEIPT="$TMP_DIR/freeze-receipt-cold-execute.json"
  COLD_DEPLOYMENTS="$TMP_DIR/cold-execute-target-deployments.json"
  COLD_OPERATION_ID=88888888888888888888888888888888
  make_freeze_bundle "$FREEZE_BUNDLE"
  make_freeze_receipt "$FREEZE_BUNDLE" "$FREEZE_RECEIPT"
  make_cold_rebind_target_deployments "$COLD_DEPLOYMENTS"
  cold_manifest_sha="$(sha256_digest "$FREEZE_BUNDLE/SHA256SUMS")"
  cold_dump_sha="$(sha256_digest "$FREEZE_BUNDLE/retdb-$STAMP.sql.gz")"
  cold_storage_sha="$(sha256_digest "$FREEZE_BUNDLE/ret-storage-$STAMP.tar.gz")"
  cold_inventory_sha="$(sha256_digest "$FREEZE_BUNDLE/deployment-images.json")"
  COLD_CONFIRMATION="cold-rebind:fixture-context:hcce:99999999999999999999999999999999:$cold_manifest_sha:$cold_dump_sha:$cold_storage_sha:$cold_inventory_sha:source-cluster-uid:source-namespace-uid:source-pvc-uid:fixture-cluster-anchor-uid:fixture-uid:fixture-pvc-uid:$COLD_OPERATION_ID:fixture-client-001"
  reset_stub
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '0\n' >"$STUB_STATE_DIR/replicas-$deployment"
  done
  expect_success 'cold rebind restores DB and media together then resumes the exact target' \
    env RESTORE_TARGET_MODE=cold-rebind RESTORE_CHECKPOINT_COLD_REBIND=1 \
      COLD_REBIND_OPERATION_ID="$COLD_OPERATION_ID" \
      CONFIRM_COLD_REBIND_RESTORE="$COLD_CONFIRMATION" \
      FREEZE_RECEIPT_PATH="$FREEZE_RECEIPT" \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      STUB_DEPLOYMENTS_JSON="$COLD_DEPLOYMENTS" \
      STUB_RET_CONFIG_JSON="$COLD_REBIND_RET_CONFIG_JSON" \
      STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
      KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
      STUB_CHECKPOINT_WRITER_DISCOVER_MONITOR=1 \
      STUB_LIVE_REACTIVATION_VALUES_CONTENT_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      HCCE_MANIFEST_PATH="$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" \
      STUB_LIVE_REACTIVATION_MANIFEST_FILE="$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" \
      RECOVERY_STREAM_POLL_SECONDS=0.01 \
      "$ROOT_DIR/deployment/restore-checkpoint.sh" "$FREEZE_BUNDLE"
  if checkpoint_all_writers_at 1 && checkpoint_all_writer_rollouts_observed &&
     checkpoint_resume_receipts_absent &&
     [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     [[ "$(cat "$STUB_STATE_DIR/live-reactivation-verifier-count" \
       2>/dev/null || printf 0)" == 1 ]]; then
    pass 'cold rebind ends with five writers live, verified and lock-free'
  else
    fail 'cold rebind exact terminal state' "$(tail -n 160 "$KUBECTL_LOG")"
  fi
  reset_stub
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '0\n' >"$STUB_STATE_DIR/replicas-$deployment"
  done
  expect_failure 'cold rebind live-verifier failure returns to five zero writers' \
    'Cold rebind external live verification failed.' \
    env RESTORE_TARGET_MODE=cold-rebind RESTORE_CHECKPOINT_COLD_REBIND=1 \
      COLD_REBIND_OPERATION_ID="$COLD_OPERATION_ID" \
      CONFIRM_COLD_REBIND_RESTORE="$COLD_CONFIRMATION" \
      FREEZE_RECEIPT_PATH="$FREEZE_RECEIPT" \
      EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
      EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      STUB_DEPLOYMENTS_JSON="$COLD_DEPLOYMENTS" \
      STUB_RET_CONFIG_JSON="$COLD_REBIND_RET_CONFIG_JSON" \
      STUB_RUNNER_NAMESPACE='' STUB_RUNNER_POD_PROFILE='' \
      STUB_MODE=cold-rebind-live-verifier-fail \
      KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer" \
      STUB_CHECKPOINT_WRITER_DISCOVER_MONITOR=1 \
      STUB_LIVE_REACTIVATION_VALUES_CONTENT_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      HCCE_MANIFEST_PATH="$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" \
      STUB_LIVE_REACTIVATION_MANIFEST_FILE="$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" \
      RECOVERY_STREAM_POLL_SECONDS=0.01 \
      "$ROOT_DIR/deployment/restore-checkpoint.sh" "$FREEZE_BUNDLE"
  if checkpoint_all_writers_at 0 && checkpoint_resume_receipts_absent &&
     [[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
     [[ "$LAST_OUTPUT" == *'consumers remain at zero'* ]] &&
     [[ "$LAST_OUTPUT" != *'Automatic fail-closed quiesce could not be completed.'* ]]; then
    pass 'cold rebind failure retains its lock after exact automatic fail-close'
  else
    cold_failure_states=""
    for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
      cold_failure_states+="$deployment=$(cat \
        "$STUB_STATE_DIR/replicas-$deployment" 2>/dev/null || printf missing) "
    done
    cold_failure_lock=absent
    [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] || cold_failure_lock=present
    fail 'cold rebind exact failure boundary' \
      "states=$cold_failure_states lock=$cold_failure_lock output=$LAST_OUTPUT"
  fi
  recovery_finish_focus 'Focused cold-rebind execute'
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == storage-helper-pod-snapshot-race ]]; then
  expect_success 'atomic helper Pod snapshot survives LIST/delete open races without diagnostics' \
    run_storage_helper_pod_snapshot_race_test
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused helper Pod snapshot race test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused helper Pod snapshot race tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-context-isolation ]]; then
  STUB_MODE=legacy-receipt-r-exit-91
  STUB_CHECKPOINT_WRITER_QUERY=1
  KUBECTL_BIN="$TMP_DIR/bin/kubectl-checkpoint-writer"
  export STUB_MODE STUB_CHECKPOINT_WRITER_QUERY KUBECTL_BIN
  initialize_restore_fence_test_environment
  if [[ -z "${STUB_MODE+x}" && -z "${STUB_CHECKPOINT_WRITER_QUERY+x}" &&
        "$KUBECTL_BIN" == "$TMP_DIR/bin/kubectl" ]]; then
    pass 'restore fixture discards writer-monitor kubectl and mode contamination'
  else
    fail 'restore fixture environment isolation' \
      "mode=${STUB_MODE-unset} query=${STUB_CHECKPOINT_WRITER_QUERY-unset} kubectl=$KUBECTL_BIN"
  fi
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused restore-context isolation test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused restore-context isolation tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-execute-cas ]]; then
  initialize_restore_fence_test_context
  run_restore_execute_cas_tests "${YENHUBS_RECOVERY_TEST_CASE:-}"
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused restore execute-CAS test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused restore execute-CAS tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-repeat-positive ]]; then
  initialize_restore_fence_test_context
  for restore_repeat_iteration in 1 2 3; do
    reset_stub
    if LAST_OUTPUT="$(prepare_fence_fixture 2>&1)"; then
      pass "repeat restore $restore_repeat_iteration prepares its exact source fence"
    else
      fail "repeat restore $restore_repeat_iteration prepares its exact source fence" \
        "$LAST_OUTPUT"
      continue
    fi
    if LAST_OUTPUT="$(apply_restore_fence_fixture 2>&1)"; then
      pass "repeat restore $restore_repeat_iteration applies its exact active fence"
    else
      fail "repeat restore $restore_repeat_iteration applies its exact active fence" \
        "$LAST_OUTPUT"
      continue
    fi
    : >"$KUBECTL_LOG"
    expect_success "repeat restore $restore_repeat_iteration completes while fenced" \
      execute_fenced_fixture
    restore_repeat_drop_line="$(
      grep -n 'dropdb' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :
    )"
    restore_repeat_extract_line="$(
      grep -n 'tar -C /storage -xf -' "$KUBECTL_LOG" |
        head -1 | cut -d: -f1 || :
    )"
    restore_repeat_lock_replace_line="$(
      grep -n '^fixture:restore-lock-cas-replace$' "$KUBECTL_LOG" |
        head -1 | cut -d: -f1 || :
    )"
    restore_repeat_all_zero=true
    for restore_repeat_consumer in \
      reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
      if [[ "$(cat "$STUB_STATE_DIR/replicas-$restore_repeat_consumer" \
            2>/dev/null || :)" != 0 ]]; then
        restore_repeat_all_zero=false
      fi
    done
    if [[ "$restore_repeat_drop_line" =~ ^[0-9]+$ &&
          "$restore_repeat_extract_line" =~ ^[0-9]+$ &&
          "$restore_repeat_lock_replace_line" =~ ^[0-9]+$ &&
          "$restore_repeat_drop_line" -lt "$restore_repeat_extract_line" &&
          "$restore_repeat_extract_line" -lt "$restore_repeat_lock_replace_line" &&
          "$(grep -c '^fixture:restore-lock-cas-replace$' \
            "$KUBECTL_LOG" || :)" == 1 &&
          "$restore_repeat_all_zero" == true &&
          ! -e "$STUB_STATE_DIR/pod-created" &&
          ! -e "$STUB_STATE_DIR/network-policy.yaml" ]] &&
       grep -Eq \
         '/apis/apps/v1/namespaces/hcce/deployments\?.*watch=true' \
         "$KUBECTL_LOG" &&
       grep -Eq \
         '/api/v1/namespaces/hcce-bot-runners/pods\?.*sendInitialEvents=true.*watch=true' \
         "$KUBECTL_LOG" &&
       restore_lock_state_is restore-complete-awaiting-reactivation lock-rv-2 &&
       recovery_operation_fence_binding_state_is active \
         recovery-operation-fence-binding-rv-2 &&
       recovery_operation_fence_binding_was_not_replaced; then
      pass "repeat restore $restore_repeat_iteration retains the exact completed fail-closed state"
    else
      fail "repeat restore $restore_repeat_iteration exact completed state" \
        "$(cat "$KUBECTL_LOG")"
    fi
  done
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused repeated positive restore test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused repeated positive restore tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-finalize-positive ]]; then
  initialize_restore_fence_test_context
  reset_stub
  expect_success 'positive finalizer fixture prepares its exact source fence' \
    prepare_fence_fixture
  apply_restore_fence_fixture
  expect_success 'positive finalizer fixture executes the fenced restore' \
    execute_fenced_fixture
  run_restore_finalize_positive_test
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused positive restore-finalizer test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused positive restore-finalizer tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-clear-stale-final-evidence ]]; then
  initialize_restore_fence_test_context
  run_restore_clear_stale_final_evidence_test
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused restore clear-stale final-evidence test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused restore clear-stale final-evidence tests passed: %s.\n' \
    "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-clear-stale-success ]]; then
  initialize_restore_fence_test_context
  run_restore_clear_stale_success_test
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused restore clear-stale success test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused restore clear-stale success tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == h5-full-red-stale ]]; then
  initialize_restore_fence_test_context
  run_restore_clear_stale_final_evidence_test
  run_restore_clear_stale_success_test
  run_stale_helper_cleanup_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused H5 stale-helper regression test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused H5 stale-helper regression tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == recovery-operation-fence ]]; then
  run_recovery_operation_fence_library_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused recovery-operation fence test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused recovery-operation fence tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == durable-monitor-library ]]; then
  run_durable_runner_monitor_library_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused durable-monitor library test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused durable-monitor library tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == storage-helper-contract ]]; then
  run_storage_helper_contract_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused storage-helper contract test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused storage-helper contract tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == storage-backup-monitor-extra ]]; then
  reset_stub
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
  STUB_MODE=backup-monitor-extra
  export STUB_MODE
  expect_failure 'coordinated storage monitor catches a transient extra ret-pvc consumer' \
    'monitor failed' run_checkpoint_backup_child storage \
    "$TMP_DIR/monitor-extra-focus" legacy-absent "" "" "" \
    "$GOOD_CHECKPOINT/deployment-images.json"
  unset STUB_MODE
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused storage backup monitor test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused storage backup monitor tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == stream-guards ]]; then
  run_stream_guard_timing_contract_tests
  run_multi_guard_stream_regression_tests
  run_stream_guard_abort_tests
  run_parent_death_stream_test
  run_stream_capability_authority_tamper_tests
  run_watchdog_identity_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused guarded-stream test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused guarded-stream tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == multi-stream-guards ]]; then
  run_multi_guard_stream_regression_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused multi-guard stream test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused multi-guard stream tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == watchdog-identity ]]; then
  run_watchdog_identity_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused watchdog-identity test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused watchdog-identity tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == preflight-reactivation ]]; then
  run_reactivation_preflight_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused reactivation-preflight test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused reactivation-preflight tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-target-mode ]]; then
  run_restore_target_mode_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused restore-target-mode test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused restore-target-mode tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-resume-diagnostic ]]; then
  diagnostic_mode="${YENHUBS_RECOVERY_TEST_CASE:-checkpoint-resume-lost-response}"
  diagnostic_runner_mode="${YENHUBS_RECOVERY_TEST_RUNNER_MODE:-durable}"
  reset_stub
  diagnostic_output="$TMP_DIR/checkpoint-resume-diagnostic"
  diagnostic_status=0
  if run_checkpoint_resume_fixture \
      "$diagnostic_runner_mode" "$diagnostic_mode" "$diagnostic_output"; then
    diagnostic_status=0
  else
    diagnostic_status=$?
  fi
  printf 'checkpoint-resume-diagnostic status=%s runner=%s mode=%s\n' \
    "$diagnostic_status" "$diagnostic_runner_mode" "$diagnostic_mode"
  printf '%s\n' '--- final state ---'
  for diagnostic_writer in \
    reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    printf '%s replicas=%s rv=%s receipt=%s\n' \
      "$diagnostic_writer" \
      "$(cat "$STUB_STATE_DIR/replicas-$diagnostic_writer" 2>/dev/null || printf missing)" \
      "$(cat "$STUB_STATE_DIR/rv-$diagnostic_writer" 2>/dev/null || printf missing)" \
      "$(cat "$STUB_STATE_DIR/checkpoint-resume-receipt-$diagnostic_writer" 2>/dev/null || printf absent)"
  done
  printf 'lock=%s output=%s\n' \
    "$([[ -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && printf present || printf absent)" \
    "$([[ -e "$diagnostic_output" ]] && printf present || printf absent)"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == runner-identity ]]; then
  run_runner_identity_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused runner identity test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused runner identity tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-writer-additional ]]; then
  run_checkpoint_writer_additional_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused additional checkpoint writer test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused additional checkpoint writer tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-writer-terminal ]]; then
  run_checkpoint_writer_terminal_handoff_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused terminal checkpoint writer test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused terminal checkpoint writer tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == legacy-restore-receipt ]]; then
  run_legacy_receipt_watcher_tests
  if [[ "${YENHUBS_RECOVERY_TEST_CASE:-}" == shell-happy ]]; then
    run_legacy_receipt_shell_tests
  elif [[ -z "${YENHUBS_RECOVERY_TEST_CASE:-}" ]]; then
    run_legacy_receipt_shell_tests
  fi
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused legacy restore-receipt test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused legacy restore-receipt tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-writer-fence ]]; then
  run_checkpoint_writer_fence_contract_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused checkpoint writer-fence test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused checkpoint writer-fence tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == h5-full-red-writer-positive ]]; then
  case "${YENHUBS_RECOVERY_TEST_CASE:-}" in
    backup)
      expect_success 'standalone checkpoint-backup writer monitor completes under its synthetic Lease' \
        run_checkpoint_writer_monitor_success
      ;;
    restore)
      expect_success 'standalone checkpoint-restore writer monitor completes under its synthetic Lease' \
        run_checkpoint_writer_monitor_success "" durable-v2 checkpoint-restore
      ;;
    stale)
      expect_success 'standalone writer monitor still rejects an explicitly stale Lease' \
        run_checkpoint_writer_monitor_failure "" stale-lease
      ;;
    "")
      expect_success 'standalone checkpoint-backup writer monitor completes under its synthetic Lease' \
        run_checkpoint_writer_monitor_success
      expect_success 'standalone checkpoint-restore writer monitor completes under its synthetic Lease' \
        run_checkpoint_writer_monitor_success "" durable-v2 checkpoint-restore
      ;;
    *) exit 2 ;;
  esac
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused positive writer-monitor regression test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused positive writer-monitor regression tests passed: %s.\n' \
    "$PASS_COUNT"
  exit 0
fi

if recovery_focus_selected checkpoint-writer-list-gvk; then
  run_checkpoint_writer_list_item_gvk_tests
  recovery_finish_focus 'Focused checkpoint writer item-GVK'
fi

if recovery_focus_selected checkpoint-writer-pod-defaults; then
  run_checkpoint_writer_live_pod_defaults_tests
  recovery_finish_focus 'Focused checkpoint writer Pod-default'
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == h5-full-red-writer ]]; then
  run_checkpoint_writer_list_item_gvk_tests
  run_checkpoint_writer_live_pod_defaults_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused H5 writer-monitor regression test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused H5 writer-monitor regression tests passed: %s.\n' \
    "$PASS_COUNT"
  exit 0
fi

if [[ "$H5_FINAL_RECOVERY_FOCUS" == true ]]; then
  # verify-project already ran the default recovery suite once.  h5-final is
  # additive, so stop here instead of falling through and repeating it.
  printf 'Aggregated H5-only recovery tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-writers ]]; then
  run_checkpoint_writer_monitor_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused checkpoint writer-monitor test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused checkpoint writer-monitor tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-durable ]]; then
  case "${YENHUBS_RECOVERY_TEST_CASE:-}" in
    runner|intent)
      run_durable_reconciled_profile_checkpoint_test \
        "$TMP_DIR/checkpoint-durable-focus" "$YENHUBS_RECOVERY_TEST_CASE"
      ;;
    stable-runner)
      run_durable_runner_profile_checkpoint_tests \
        "$TMP_DIR/checkpoint-durable-focus"
      ;;
    '')
      run_durable_runner_profile_checkpoint_tests "$TMP_DIR/checkpoint-durable-focus"
      ;;
    *)
      printf 'Unknown checkpoint-durable test case.\n' >&2
      exit 2
      ;;
  esac
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused durable checkpoint test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused durable checkpoint tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-durable-fence-drift ]]; then
  run_durable_runner_fence_drift_checkpoint_tests \
    "$TMP_DIR/checkpoint-durable-fence-drift-focus"
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused durable fence-drift test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused durable fence-drift tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-finalization ]]; then
  case "${YENHUBS_RECOVERY_TEST_CASE:-}" in
    diagnostic)
      run_checkpoint_finalization_diagnostic_tests \
        "$TMP_DIR/checkpoint-finalization-focus/diagnostics"
      ;;
    first-resume)
      run_checkpoint_dormant_fence_aba_tests \
        "$TMP_DIR/checkpoint-finalization-focus/dormant-aba" \
        checkpoint-dormant-fence-aba-before-first-resume
      ;;
    lock-release)
      run_checkpoint_dormant_fence_aba_tests \
        "$TMP_DIR/checkpoint-finalization-focus/dormant-aba" \
        checkpoint-dormant-fence-aba-before-lock-release
      ;;
    '')
      run_checkpoint_finalization_diagnostic_tests \
        "$TMP_DIR/checkpoint-finalization-focus/diagnostics"
      run_checkpoint_dormant_fence_aba_tests \
        "$TMP_DIR/checkpoint-finalization-focus/dormant-aba"
      ;;
    *)
      printf 'Unknown checkpoint-finalization test case.\n' >&2
      exit 2
      ;;
  esac
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused checkpoint-finalization test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused checkpoint-finalization tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-children ]]; then
  run_checkpoint_backup_child_guard_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused checkpoint child-guard test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused checkpoint child-guard tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-child-guards ]]; then
  run_restore_child_stream_guard_tests
  run_durable_restore_child_capability_swap_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused restore child-guard test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused restore child-guard tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-durable-child-guards ]]; then
  run_durable_restore_child_capability_swap_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused durable restore child-guard test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused durable restore child-guard tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-durable-child-case ]]; then
  durable_child_case="${YENHUBS_RECOVERY_TEST_CHILD:-}"
  durable_child_mode="${YENHUBS_RECOVERY_TEST_CASE:-}"
  case "$durable_child_case" in
    db|storage) ;;
    *)
      printf 'restore-durable-child-case requires YENHUBS_RECOVERY_TEST_CHILD=db|storage.\n' >&2
      exit 2
      ;;
  esac
  case "$durable_child_mode" in
    swap-pids|swap-progress|swap-authority|inflight-pid|inflight-progress|inflight-authority) ;;
    *)
      printf '%s\n' \
        'restore-durable-child-case requires one allowed YENHUBS_RECOVERY_TEST_CASE.' >&2
      exit 2
      ;;
  esac
  run_durable_restore_child_capability_swap_tests \
    "$durable_child_case" "$durable_child_mode"
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused durable restore child case test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused durable restore child case passed: child=%s mode=%s tests=%s.\n' \
    "$durable_child_case" "$durable_child_mode" "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-durable-db-inflight-pid ]]; then
  run_durable_restore_child_capability_swap_tests db inflight-pid
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused durable DB in-flight PID test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused durable DB in-flight PID tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-legacy-child-guards ]]; then
  run_restore_child_stream_guard_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused legacy restore child-guard test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused legacy restore child-guard tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == h5-full-red-restore-concurrency ]]; then
  reset_stub
  expect_success 'focused exact DB restore holds the writer monitor under its parent heartbeat' \
    run_guarded_legacy_restore_child db \
    "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
  reset_stub
  expect_failure 'focused DB restore still rejects an active UUID mismatch' \
    'does not exactly match' run_guarded_legacy_restore_child db \
    "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" restored-uuid-mismatch
  reset_stub
  expect_failure 'focused storage restore rejects an initial extra PVC consumer' \
    'Unexpected pods consume PVC' run_guarded_legacy_restore_child storage \
    "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" extra-consumer
  reset_stub
  expect_failure 'focused storage monitor catches a transient extra PVC consumer' \
    'Unexpected pods consume PVC' run_guarded_legacy_restore_child storage \
    "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" monitor-extra
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused restore-concurrency regression test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused restore-concurrency regression tests passed: %s.\n' \
    "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-legacy-runner-reappearance ]]; then
  run_legacy_restore_runner_reappearance_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused legacy runner-reappearance test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused legacy runner-reappearance tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == restore-lock-probe ]]; then
  run_legacy_restore_lock_contract_probe
  printf 'Focused restore-lock probe passed.\n'
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == private-directory-helper ]]; then
  run_private_directory_helper_tests
  run_private_directory_setup_signal_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused private-directory helper test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused private-directory helper tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == runner-source-evidence ]]; then
  run_runner_source_evidence_tests
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused runner source-evidence test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused runner source-evidence tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

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
  run_checkpoint_local_input_preflight_tests \
    "$TMP_DIR/checkpoint-local-input-preflight-focus"
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
        RECOVERY_STREAM_POLL_SECONDS=0.01 \
        "$ROOT_DIR/deployment/create-checkpoint.sh" \
        "$checkpoint_focus_parent/$checkpoint_focus_mode"
      if any_deployment_replica_mutation; then
        fail "focused $checkpoint_focus_mode preflight does not mutate replicas" \
          "$(cat "$KUBECTL_LOG")"
      else
        pass "focused $checkpoint_focus_mode preflight does not mutate replicas"
      fi
    done
  fi

  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  expect_failure 'focused adjacent Cloud drift gate blocks parent resume' \
    'active runner control plane is not exact' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=checkpoint-active-control-plane-drift \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$checkpoint_focus_parent/adjacent-drift"
  checkpoint_focus_parent_resume_count="$(deployment_patch_count bot-orchestrator 1)"
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
  seed_recovery_operation_fence_binding_state dormant
  expect_success 'focused checkpoint UID-deletes an isolated orphan and resumes' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=checkpoint-orphan-runner \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$checkpoint_orphan_output"
  orphan_focus_zero="$(deployment_patch_first_line bot-orchestrator 0)"
  orphan_focus_delete="$(grep -n \
    "delete --raw=/api/v1/namespaces/hcce-bot-runners/pods/$RUNNER_FIXTURE_NAME" \
    "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
  orphan_focus_dump="$(grep -n 'pg_dump -U' "$KUBECTL_LOG" |
    head -1 | cut -d: -f1 || :)"
  orphan_focus_resume="$(deployment_patch_first_line bot-orchestrator 1)"
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
  expect_failure 'focused process-local capture rejects runner-namespace bot-images-pull Secret' \
    'partial Kubernetes runner bindings' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_RESIDUAL=runner-pull-secret VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    "$ROOT_DIR/deployment/capture-instance-state.sh" \
    "$TMP_DIR/process-local-focus-runner-pull-secret"
  reset_stub
  expect_success 'focused process-local checkpoint publishes and resumes exactly' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$process_local_checkpoint"
  reset_stub
  expect_failure 'focused mixed PostgreSQL identity blocks checkpoint before downtime' \
    'historical AUD-065 contract' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_MIXED_PGSQL_DEPLOYMENTS_JSON" \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-focus-checkpoint-mixed-pgsql"
  if any_deployment_replica_mutation; then
    fail 'focused mixed PostgreSQL identity performs zero writer replica mutations' \
      "$(cat "$KUBECTL_LOG")"
  else
    pass 'focused mixed PostgreSQL identity performs zero writer replica mutations'
  fi
  reset_stub
  expect_failure 'focused process-local mode drift blocks every writer resume' \
    'Checkpoint runner mode changed while writers were fenced' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_MODE=checkpoint-process-local-mode-drift \
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-focus-mode-drift"
  if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
     [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]] &&
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
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-focus-adjacent-drift"
  if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
     [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]] &&
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
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-focus-parent-wait"
  if checkpoint_process_local_pre_watcher_outcome_is_safe; then
    pass 'focused pre-watcher failure reaches exact rollback or retains parent authority fail-closed'
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
    'Checkpoint runner mode changed while writers were fenced' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$partial_process_local" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$TMP_DIR/process-local-partial"
  if any_deployment_replica_mutation; then
    fail 'focused partial isolated binding mutates writer replicas' "$(cat "$KUBECTL_LOG")"
  else
    pass 'focused partial isolated binding performs zero writer replica mutations'
  fi
  reset_stub
  expect_failure 'focused residual runner Namespace never falls back to process-local' \
    'Checkpoint runner mode changed while writers were fenced' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$TMP_DIR/process-local-namespace"
  if any_deployment_replica_mutation; then
    fail 'focused residual runner Namespace mutates writer replicas' "$(cat "$KUBECTL_LOG")"
  else
    pass 'focused residual runner Namespace performs zero writer replica mutations'
  fi
  for residual_resource in role validatingadmissionpolicy; do
    reset_stub
    expect_failure "focused residual $residual_resource never falls back to process-local" \
      'Checkpoint runner mode changed while writers were fenced' \
      env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
      EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
      VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
      STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
      STUB_RUNNER_RESIDUAL="$residual_resource" \
      "$ROOT_DIR/deployment/create-checkpoint.sh" \
      "$TMP_DIR/process-local-residual-$residual_resource"
    if any_deployment_replica_mutation; then
      fail "focused residual $residual_resource mutates writer replicas" "$(cat "$KUBECTL_LOG")"
    else
      pass "focused residual $residual_resource performs zero writer replica mutations"
    fi
  done
  annotated_process_local="$TMP_DIR/process-local-focus-annotated.json"
  jq '(.items[] | select(.metadata.name == "pgbouncer") |
      .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"]) = "active"' \
    "$LEGACY_DEPLOYMENTS_JSON" >"$annotated_process_local"
  reset_stub
  expect_failure 'focused non-parent runner annotation never falls back to process-local' \
    'Checkpoint runner mode changed while writers were fenced' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$annotated_process_local" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$TMP_DIR/process-local-annotated"
  if any_deployment_replica_mutation; then
    fail 'focused non-parent runner annotation mutates writer replicas' "$(cat "$KUBECTL_LOG")"
  else
    pass 'focused non-parent runner annotation performs zero writer replica mutations'
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
    grep -Fq -- "--request-timeout=45s get lease yenhubs-operation-serialization -n hcce -o json" "$3"
    [[ "$RECOVERY_SERIALIZATION_LEASE_HOLDER" =~ ^root-recovery: ]]
    recovery_release_operation_serialization
    jq -e '\''(.metadata | has("deletionTimestamp") | not) and
      (.spec | keys | sort) == ["leaseDurationSeconds","leaseTransitions"]'\'' \
      "$2" >/dev/null
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh" \
    "$STUB_STATE_DIR/serialization-lease.json" "$KUBECTL_LOG"

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
# shellcheck disable=SC2031 # PID is captured in the owning top-level shell.
lease_replace_pid=$!
STUB_MODE=replace-payload-concurrency kubectl --context fixture-context \
  --request-timeout=30s replace -f - -o json \
  <"$role_replace_payload" >"$role_replace_output" &
# shellcheck disable=SC2031 # PID is captured in the owning top-level shell.
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

run_parent_death_stream_test

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == sigkill ]]; then
  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    printf '%s focused recovery safety test(s) failed; %s passed.\n' \
      "$FAIL_COUNT" "$PASS_COUNT" >&2
    exit 1
  fi
  printf 'Focused SIGKILL recovery safety tests passed: %s.\n' "$PASS_COUNT"
  exit 0
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" != checkpoint-tail &&
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" != checkpoint-tail-final &&
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" != checkpoint-tail-after-children ]]; then
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
run_runner_identity_tests
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
    watcher_identity=""
    recovery_start_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" \
      watcher_pid watcher_identity
    if recovery_stop_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" \
      "$watcher_pid" "$watcher_identity"; then
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
    watcher_identity=""
    recovery_start_no_managed_bot_runner_watch \
      "$stop_path" "$failure_path" "$ready_path" \
      watcher_pid watcher_identity
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
run_restore_target_mode_tests

# The historical schema-2 child tests below exercise the process-local
# generation. Keep their ambient fixture generation exact; individual cases
# override only the failure surface they are testing.
VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE"
STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON"
unset STUB_RUNNER_NAMESPACE STUB_RUNNER_POD_PROFILE
export VALUES_FILE STUB_DEPLOYMENTS_JSON

reset_stub
expect_failure 'DB restore rejects checksum mismatch before Kubernetes' 'verification failed' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid RESTORE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-retdb.sh" "$TAMPERED/retdb-$STAMP.sql.gz"
assert_no_kube 'checksum rejection performs no kubectl call'

reset_stub
expect_success 'DB restore preflight validates the immutable pair read-only' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-retdb.sh" "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if any_deployment_replica_mutation || grep -Eq 'dropdb| apply ' "$KUBECTL_LOG"; then fail 'DB preflight has no mutation' "$(cat "$KUBECTL_LOG")"; else pass 'DB preflight has no mutation'; fi

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
if any_deployment_replica_mutation; then fail 'bad DB confirmation performs no replica mutation' "$(cat "$KUBECTL_LOG")"; else pass 'bad DB confirmation performs no replica mutation'; fi
reset_stub
seed_restore_lock
corrupt_restore_lock_inventory
expect_failure 'DB child rejects a restore lock bound to another deployment inventory' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  RESTORE_COORDINATED=1 CONFIRM_RESTORE="$CONFIRM_DB" \
  "$ROOT_DIR/deployment/restore-retdb.sh" \
  "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q dropdb "$KUBECTL_LOG"; then
  fail 'wrong DB lock inventory is rejected before database mutation' \
    "$(cat "$KUBECTL_LOG")"
else
  pass 'wrong DB lock inventory is rejected before database mutation'
fi
reset_stub
expect_failure 'consumer timeout blocks DB drop' 'Timed out waiting' \
  run_guarded_legacy_restore_child db \
  "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" timeout
if grep -q dropdb "$KUBECTL_LOG"; then fail 'timeout performs no DB drop' "$(cat "$KUBECTL_LOG")"; else pass 'timeout performs no DB drop'; fi
run_legacy_restore_runner_reappearance_tests
reset_stub
expect_failure 'lock replacement after quiescence blocks before DB mutation' \
  'identity or operation binding changed' run_guarded_legacy_restore_child db \
  "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" restore-lock-replaced-after-quiesce
if grep -q dropdb "$KUBECTL_LOG"; then fail 'post-quiesce lock replacement performs no DB drop' "$(cat "$KUBECTL_LOG")"; else pass 'post-quiesce lock replacement performs no DB drop'; fi
reset_stub
expect_success 'exact DB confirmation restores and holds all consumers quiescent' \
  run_guarded_legacy_restore_child db \
  "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz"
if grep -q dropdb "$KUBECTL_LOG" && [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]]; then pass 'DB child never resumes before storage validation'; else fail 'DB child never resumes before storage validation' "$(cat "$KUBECTL_LOG")"; fi
reset_stub
expect_failure 'DB restore verifies exact active UUID set' 'does not exactly match' \
  run_guarded_legacy_restore_child db \
  "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" restored-uuid-mismatch
reset_stub
expect_failure 'DB restore rejects same-count live relation drift after restore' \
  'does not exactly match the checksummed' run_guarded_legacy_restore_child db \
  "$GOOD_CHECKPOINT/retdb-$STAMP.sql.gz" '' "$DRIFTED_DATABASE_CONTRACT"

reset_stub
expect_success 'storage preflight validates DB/archive/PVC without writes' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_STORAGE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if any_deployment_replica_mutation || grep -Eq ' apply ' "$KUBECTL_LOG"; then fail 'storage preflight has no writes' "$(cat "$KUBECTL_LOG")"; else pass 'storage preflight has no writes'; fi
reset_stub
expect_failure 'storage preflight rejects wrong PVC UID' 'PVC UID mismatch' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=wrong RESTORE_STORAGE_PREFLIGHT=1 "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
expect_failure 'storage preflight rejects empty DB active set' 'baseline is empty' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_STORAGE_PREFLIGHT=1 STUB_MODE=zero-db-active "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
expect_failure 'generic storage confirmation is rejected' 'for this exact target' env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE=ret-pvc "$ROOT_DIR/deployment/restore-ret-storage.sh" "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
reset_stub
seed_restore_lock
corrupt_restore_lock_inventory
expect_failure 'storage child rejects a restore lock bound to another deployment inventory' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid RESTORE_COORDINATED=1 \
  CONFIRM_RESTORE_STORAGE="$CONFIRM_STORAGE" \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -Eq 'create -f -|tar -C /storage -xf -' "$KUBECTL_LOG"; then
  fail 'wrong storage lock inventory is rejected before helper or archive mutation' \
    "$(cat "$KUBECTL_LOG")"
else
  pass 'wrong storage lock inventory is rejected before helper or archive mutation'
fi
reset_stub
expect_failure 'extra PVC consumer blocks restore pod/write' \
  'Unexpected pods consume PVC' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" extra-consumer
reset_stub
expect_failure 'PVC consumer monitor fails extraction on transient extra pod' \
  'Unexpected pods consume PVC' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" monitor-extra
reset_stub
expect_failure 'storage monitor catches managed bot-runner reappearance during PVC write' \
  'monitoring failed' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" runner-reappears-during-storage
reset_stub
expect_failure 'restore pod creation is exclusive across concurrent runs' \
  'exact safe contract' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" helper-pod-create-decoy
if grep -q 'create -f -' "$KUBECTL_LOG" &&
   [[ -e "$STUB_STATE_DIR/pod-created" &&
      -e "$STUB_STATE_DIR/helper-pod-create-decoy" ]] &&
   ! grep -q 'tar -C /storage -xf -' "$KUBECTL_LOG" &&
   ! grep -q 'delete --raw=.*/pods/' "$KUBECTL_LOG"; then
  pass 'failed create never adopts, extracts through or deletes a concurrent pod'
else
  fail 'failed create never adopts, extracts through or deletes a concurrent pod' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
expect_failure 'restore rejects an admitted decoy mount before extraction' \
  'exact safe contract' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" restore-pod-decoy
if grep -q 'tar -C /storage -xf -' "$KUBECTL_LOG"; then fail 'admitted decoy mount is rejected before extraction' "$(cat "$KUBECTL_LOG")"; else pass 'admitted decoy mount is rejected before extraction'; fi
reset_stub
expect_failure 'restore rejects an admitted extra volume before extraction' \
  'exact safe contract' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" restore-pod-extra-volume
if grep -q 'tar -C /storage -xf -' "$KUBECTL_LOG"; then fail 'admitted extra volume is rejected before extraction' "$(cat "$KUBECTL_LOG")"; else pass 'admitted extra volume is rejected before extraction'; fi
reset_stub
expect_failure 'restore monitor rejects same-name pod replacement' \
  'monitoring failed' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" restore-pod-replaced
if grep -q 'delete pod ret-storage-restore' "$KUBECTL_LOG"; then fail 'restore never deletes a same-name replacement pod' "$(cat "$KUBECTL_LOG")"; else pass 'restore never deletes a same-name replacement pod'; fi
reset_stub
expect_failure 'non-empty PVC destination is never merged' 'non-empty or unsafe' \
  run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" destination-nonempty
reset_stub
expect_failure 'storage restore rejects quiesced same-count DB contract drift before PVC write' \
  'does not match the checksummed' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" '' "$DRIFTED_DATABASE_CONTRACT"
if grep -q 'create -f -' "$KUBECTL_LOG"; then fail 'quiesced DB drift creates no restore pod' "$(cat "$KUBECTL_LOG")"; else pass 'quiesced DB drift creates no restore pod'; fi
reset_stub
expect_failure 'storage restore rejects same-count active UUID drift after quiescing' \
  'changed before storage extraction' run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz" active-drift-after
if grep -q 'create -f -' "$KUBECTL_LOG"; then fail 'active UUID drift creates no restore pod' "$(cat "$KUBECTL_LOG")"; else pass 'active UUID drift creates no restore pod'; fi
reset_stub
expect_success 'exact storage confirmation restores exclusively and remains quiescent' \
  run_guarded_legacy_restore_child storage \
  "$GOOD_CHECKPOINT/ret-storage-$STAMP.tar.gz"
if grep -q 'create -f -' "$KUBECTL_LOG" && [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]]; then pass 'storage child never resumes before joint validation'; else fail 'storage child never resumes before joint validation' "$(cat "$KUBECTL_LOG")"; fi
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

# The default recovery path reaches these guards after earlier writer and
# runner fixtures.  Clear their synthetic query profile before producing the
# durable restore fixture, matching the isolated restore selectors.
initialize_restore_fence_test_environment
run_restore_child_stream_guard_tests
run_durable_restore_child_capability_swap_tests
run_private_directory_helper_tests
run_private_directory_setup_signal_tests

initialize_restore_fence_test_context
prime_completed_restore_for_finalizer() {
  reset_stub
  prepare_fence_fixture || return 1
  apply_restore_fence_fixture || return 1
  execute_fenced_fixture || return 1
  apply_active_reactivation_fixture
  FINALIZER_TEST_CONFIRMATION="$(finalize_fence_confirmation)" || return 1
  export FINALIZER_TEST_CONFIRMATION
  rm -f -- "$STUB_STATE_DIR/runner-role-replace-payload.json"
  : >"$KUBECTL_LOG"
}

assert_no_restore_write() {
  local name="$1"
  if any_deployment_replica_mutation ||
     grep -Eq 'dropdb|tar -C /storage -xf -|delete --raw=' "$KUBECTL_LOG"; then
    fail "$name" "$(cat "$KUBECTL_LOG")"
  else
    pass "$name"
  fi
}

for rejected_legacy_phase in \
  RESTORE_CHECKPOINT_PREPARE_FENCE \
  RESTORE_CHECKPOINT_EXECUTE_FENCED \
  RESTORE_CHECKPOINT_FINALIZE_REACTIVATION; do
  reset_stub
  expect_failure "schema-2 checkpoint rejects $rejected_legacy_phase before Kubernetes" \
    'accept only durable-v2 checkpoints' \
    env "$rejected_legacy_phase=1" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
  assert_no_kube "schema-2 $rejected_legacy_phase rejection is pre-mutation and offline"
done

reset_stub
expect_failure 'durable schema-3 checkpoint cannot enter the legacy one-shot path' \
  'accepts only legacy-absent checkpoints' \
  env RESTORE_CHECKPOINT_LEGACY_IN_PLACE=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
assert_no_kube 'durable-as-legacy rejection happens before any Kubernetes access'

reset_stub
expect_success 'historical schema-2 preflight remains readable on the exact legacy generation' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
  STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_PREFLIGHT=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
assert_no_restore_write 'schema-2 legacy preflight performs reads only'

reset_stub
expect_failure 'historical schema-2 preflight cannot cross into durable live state' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
  STUB_RUNNER_NAMESPACE=present RESTORE_CHECKPOINT_PREFLIGHT=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
assert_no_restore_write 'schema-2 to durable mismatch is fail-before-mutation'

reset_stub
expect_success 'schema-3 legacy preflight accepts only the exact legacy live generation' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
  STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_PREFLIGHT=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" \
  "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT"
assert_no_restore_write 'schema-3 legacy preflight performs reads only'

reset_stub
expect_failure 'schema-3 legacy checkpoint cannot cross into durable live state' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
  STUB_RUNNER_NAMESPACE=present RESTORE_CHECKPOINT_PREFLIGHT=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" \
  "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT"
assert_no_restore_write 'schema-3 legacy to durable mismatch is fail-before-mutation'

reset_stub
expect_failure 'durable schema-3 checkpoint cannot cross into legacy live state' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
  STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_PREFLIGHT=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
assert_no_restore_write 'durable to legacy mismatch is fail-before-mutation'

reset_stub
seed_recovery_operation_fence_binding_state dormant \
  recovery-operation-fence-binding-rv-1
expect_success 'durable preflight verifies source epoch A against evidence while binding distinct target epoch B' \
  env -u YENHUBS_RECOVERY_RUNNER_CHECKPOINT_HELPER \
  EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
  STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
  STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
  RESTORE_CHECKPOINT_PREFLIGHT=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
assert_no_restore_write \
  'source A to distinct target B preflight uses the real read-only evidence verifier'

reset_stub
seed_recovery_operation_fence_binding_state dormant \
  recovery-operation-fence-binding-rv-1
expect_failure 'durable preflight rejects source epoch A reused as target epoch A' \
  'Restore is blocked until BOT_RUNNER_RECOVERY_EPOCH is rotated' \
  env -u YENHUBS_RECOVERY_RUNNER_CHECKPOINT_HELPER \
  EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_CONTROL_PLANE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
  STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
  STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
  RESTORE_CHECKPOINT_PREFLIGHT=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
assert_no_restore_write 'same source and target epoch fails before restore mutation'

for source_restore_drift in cutover-journal policy-pods; do
  reset_stub
  seed_recovery_operation_fence_binding_state dormant \
    recovery-operation-fence-binding-rv-1
  case "$source_restore_drift" in
    cutover-journal)
      source_restore_drift_error='runner_cutover_checkpoint_evidence_failed:durable_cutover_journal_invalid'
      ;;
    policy-pods)
      source_restore_drift_error='runner_cutover_checkpoint_evidence_failed:admission_policy_not_observed_or_exact'
      ;;
  esac
  expect_failure "durable preflight rejects source $source_restore_drift drift" \
    "$source_restore_drift_error" \
    env -u YENHUBS_RECOVERY_RUNNER_CHECKPOINT_HELPER \
    EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
    STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
    STUB_RUNNER_RESIDUAL="$source_restore_drift" \
    RESTORE_CHECKPOINT_PREFLIGHT=1 \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  assert_no_restore_write \
    "$source_restore_drift source drift fails before restore mutation"
done

LIVE_EPOCH_DRIFT_JSON="$TMP_DIR/deployments-live-epoch-drift.json"
jq --arg epoch 44444444-4444-4444-8444-444444444444 '
  (.items[] | select(.metadata.name == "reticulum" or
    .metadata.name == "bot-orchestrator") |
    .spec.template.metadata.annotations[
      "yenhubs.org/bot-runner-recovery-epoch"
    ]) = $epoch
' "$KUBERNETES_DEPLOYMENTS_JSON" >"$LIVE_EPOCH_DRIFT_JSON"
reset_stub
seed_recovery_operation_fence_binding_state dormant \
  recovery-operation-fence-binding-rv-1
expect_failure 'durable restore rejects live pre-fence epoch drift from its schema-4 inventory' \
  'Live durable runner epoch does not match the checkpoint pre-fence epoch' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
  STUB_DEPLOYMENTS_JSON="$LIVE_EPOCH_DRIFT_JSON" \
  STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
  RESTORE_CHECKPOINT_PREFLIGHT=1 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
assert_no_restore_write 'pre-fence epoch drift fails before lock or workload mutation'

SCHEMA2_LEGACY_INVENTORY_SHA="$(sha256_digest \
  "$GOOD_CHECKPOINT/deployment-images.json")"
SCHEMA2_LEGACY_CONFIRMATION="legacy-in-place:fixture-context:hcce:fixture-uid:fixture-pvc-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:$SCHEMA2_LEGACY_INVENTORY_SHA:$SCHEMA2_LEGACY_INVENTORY_SHA:legacy-absent"
reset_stub
expect_success 'explicit schema-2 legacy in-place restore binds its historical inventory evidence' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
  STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_LEGACY_IN_PLACE=1 \
  CONFIRM_LEGACY_IN_PLACE_RESTORE="$SCHEMA2_LEGACY_CONFIRMATION" \
  RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
schema2_parent_resume_line="$(deployment_patch_first_line bot-orchestrator 1)"
schema2_parent_last=true
for schema2_non_parent in reticulum pgbouncer pgbouncer-t coturn; do
  schema2_non_parent_line="$(deployment_patch_first_line "$schema2_non_parent" 1)"
  if [[ ! "$schema2_non_parent_line" =~ ^[0-9]+$ ||
        ! "$schema2_parent_resume_line" =~ ^[0-9]+$ ||
        "$schema2_non_parent_line" -ge "$schema2_parent_resume_line" ]]; then
    schema2_parent_last=false
  fi
done
if [[ "$schema2_parent_last" == true ]] &&
   grep -q \
     "yenhubs.org/deployment-inventory-sha256: \"$SCHEMA2_LEGACY_INVENTORY_SHA\"" \
     "$STUB_STATE_DIR"/create-payload-*.yaml &&
   grep -q \
     "yenhubs.org/runner-cutover-evidence-sha256: \"$SCHEMA2_LEGACY_INVENTORY_SHA\"" \
     "$STUB_STATE_DIR"/create-payload-*.yaml &&
   grep -q 'yenhubs.org/runner-runtime-generation: "legacy-absent"' \
     "$STUB_STATE_DIR"/create-payload-*.yaml &&
   ! grep -Eq 'delete --raw=.*/namespaces/hcce-bot-runners/' "$KUBECTL_LOG" &&
   [[ ! -e "$STUB_STATE_DIR/runner-fence-delete-attempted" ]]; then
  pass 'schema-2 legacy lock binds inventory evidence and resumes its parent last'
else
  fail 'schema-2 historical legacy evidence boundary and resume order' \
    "$(cat "$KUBECTL_LOG")"
fi

SCHEMA3_LEGACY_CONFIRMATION="legacy-in-place:fixture-context:hcce:fixture-uid:fixture-pvc-uid:$STAMP:$SCHEMA3_LEGACY_DUMP_SHA:$SCHEMA3_LEGACY_STORAGE_SHA:$SCHEMA3_LEGACY_INVENTORY_SHA:$SCHEMA3_LEGACY_EVIDENCE_SHA:legacy-absent"
reset_stub
expect_success 'schema-3 legacy in-place restore binds its evidence SHA and generation' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
  STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_LEGACY_IN_PLACE=1 \
  CONFIRM_LEGACY_IN_PLACE_RESTORE="$SCHEMA3_LEGACY_CONFIRMATION" \
  RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" \
  "$SCHEMA3_LEGACY_RESTORE_CHECKPOINT"
if grep -q \
     "yenhubs.org/runner-cutover-evidence-sha256: \"$SCHEMA3_LEGACY_EVIDENCE_SHA\"" \
     "$STUB_STATE_DIR"/create-payload-*.yaml &&
   grep -q \
     "yenhubs.org/deployment-inventory-sha256: \"$SCHEMA3_LEGACY_INVENTORY_SHA\"" \
     "$STUB_STATE_DIR"/create-payload-*.yaml &&
   grep -q 'yenhubs.org/runner-runtime-generation: "legacy-absent"' \
     "$STUB_STATE_DIR"/create-payload-*.yaml &&
   ! grep -Eq 'delete --raw=.*/namespaces/hcce-bot-runners/' "$KUBECTL_LOG"; then
  pass 'schema-3 legacy restore consumers require exact evidence lock annotations'
else
  fail 'schema-3 legacy evidence-bound lock' "$(cat "$KUBECTL_LOG")"
fi

LIVE_IMAGE_DRIFT_JSON="$TMP_DIR/deployments-live-image-drift.json"
jq '(.items[] | select(.metadata.name == "reticulum") |
  .spec.template.spec.containers[] | select(.name == "reticulum") | .image) =
  ("ghcr.io/yengalvez/reticulum@sha256:" + ("9" * 64))' \
  "$STUB_DEPLOYMENTS_JSON" >"$LIVE_IMAGE_DRIFT_JSON"
reset_stub
seed_recovery_operation_fence_binding_state dormant \
  recovery-operation-fence-binding-rv-1
expect_failure 'coordinated preflight rejects same-repository live digest drift' \
  'live workload image inventory' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
  RESTORE_CHECKPOINT_PREFLIGHT=1 \
  STUB_DEPLOYMENTS_JSON="$LIVE_IMAGE_DRIFT_JSON" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
if any_deployment_replica_mutation || grep -Eq 'dropdb|tar -C /storage -xf -' "$KUBECTL_LOG"; then
  fail 'live image drift preflight performs no mutation' "$(cat "$KUBECTL_LOG")"
else
  pass 'live image drift preflight performs no mutation'
fi
reset_stub
seed_recovery_operation_fence_binding_state dormant \
  recovery-operation-fence-binding-rv-1

expect_failure 'prepare-fence rejects a generic confirmation before replica mutation' \
  'Refusing restore fence phase' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
  RESTORE_CHECKPOINT_PREPARE_FENCE=1 \
  CONFIRM_PREPARE_RESTORE_FENCE=prepare-fence \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
if any_deployment_replica_mutation; then
  fail 'bad prepare-fence confirmation performs no replica mutation' "$(cat "$KUBECTL_LOG")"
else
  pass 'bad prepare-fence confirmation performs no replica mutation'
fi

reset_stub
seed_recovery_operation_fence_binding_state dormant \
  recovery-operation-fence-binding-rv-1
expect_failure 'a second prepare-fence cannot cross an active global lock' \
  'Another recovery operation owns' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
  RESTORE_CHECKPOINT_PREPARE_FENCE=1 \
  CONFIRM_PREPARE_RESTORE_FENCE="$PREPARE_FENCE_CONFIRMATION" \
  STUB_MODE=restore-lock-exists \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
if grep -q 'create -f -' "$KUBECTL_LOG" &&
   ! any_deployment_replica_mutation &&
   ! grep -Eq 'dropdb|delete --raw=.*/configmaps/' "$KUBECTL_LOG"; then
  pass 'prepare-fence lock contender never mutates replicas, restores or deletes owner state'
else
  fail 'prepare-fence lock contender never mutates owner state' "$(cat "$KUBECTL_LOG")"
fi

run_restore_role_retry_test

for durable_lock_mutation in missing-evidence wrong-generation; do
  reset_stub
  expect_success "exact-lock fixture prepares for $durable_lock_mutation rejection" \
    prepare_fence_fixture
  apply_restore_fence_fixture
  mutated_lock_confirmation="$(execute_fence_confirmation)"
  case "$durable_lock_mutation" in
    missing-evidence)
      awk '!/yenhubs.org\/runner-cutover-evidence-sha256:/' \
        "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
      ;;
    wrong-generation)
      awk '{gsub(/runner-runtime-generation: "durable-v2"/,
        "runner-runtime-generation: \"legacy-absent\""); print}' \
        "$STUB_STATE_DIR/restore-lock.yaml" >"$STUB_STATE_DIR/restore-lock.next"
      ;;
  esac
  mv "$STUB_STATE_DIR/restore-lock.next" "$STUB_STATE_DIR/restore-lock.yaml"
  : >"$KUBECTL_LOG"
  expect_failure "execute rejects restore lock $durable_lock_mutation" \
    'does not match this checkpoint and target' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
    RESTORE_CHECKPOINT_EXECUTE_FENCED=1 \
    CONFIRM_EXECUTE_RESTORE_FENCE="$mutated_lock_confirmation" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  if ! grep -Eq 'dropdb|tar -C /storage -xf -' "$KUBECTL_LOG" &&
     ! grep -q "/namespaces/hcce-bot-runners/pods/$RUNNER_FIXTURE_NAME" \
       "$KUBECTL_LOG"; then
    pass "$durable_lock_mutation mismatch blocks restore and preserves the fence"
  else
    fail "$durable_lock_mutation exact-lock fail-closed behavior" \
      "$(cat "$KUBECTL_LOG")"
  fi
done

for prepare_late_lock_mode in \
  prepare-lock-disappears-after-evidence \
  prepare-lock-replaced-after-evidence; do
  reset_stub
  seed_recovery_operation_fence_binding_state dormant \
    recovery-operation-fence-binding-rv-1
  expect_failure "$prepare_late_lock_mode blocks prepared handoff after the final evidence gate" '' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
    YENHUBS_RECOVERY_RUNNER_CHECKPOINT_HELPER="$RUNNER_CHECKPOINT_HELPER_FIXTURE" \
    STUB_MODE="$prepare_late_lock_mode" \
    RESTORE_CHECKPOINT_PREPARE_FENCE=1 \
    CONFIRM_PREPARE_RESTORE_FENCE="$PREPARE_FENCE_CONFIRMATION" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  prepare_late_all_zero=true
  for prepare_late_consumer in \
    reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ "$(cat "$STUB_STATE_DIR/replicas-$prepare_late_consumer" \
          2>/dev/null || :)" != 0 ]]; then
      prepare_late_all_zero=false
    fi
  done
  prepare_late_lock_state=false
  case "$prepare_late_lock_mode" in
    prepare-lock-disappears-after-evidence)
      [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
        prepare_late_lock_state=true
      ;;
    prepare-lock-replaced-after-evidence)
      [[ -e "$STUB_STATE_DIR/restore-lock.yaml" &&
         "$(cat "$STUB_STATE_DIR/restore-lock-uid")" == replacement-lock-uid ]] &&
        prepare_late_lock_state=true
      ;;
  esac
  if [[ "$prepare_late_all_zero" == true &&
        "$prepare_late_lock_state" == true ]] &&
     [[ "$LAST_OUTPUT" != *'Restore fence prepared and locked'* ]]; then
    pass "$prepare_late_lock_mode cannot emit or adopt a prepared restore fence"
  else
    fail "$prepare_late_lock_mode late lock handoff contract" \
      "$LAST_OUTPUT
$(cat "$KUBECTL_LOG")"
  fi
done

reset_stub
seed_recovery_operation_fence_binding_state dormant \
  recovery-operation-fence-binding-rv-1
expect_failure 'prepare-fence neutralizes runner Role even when parent scale CAS fails' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
  STUB_MODE=prepare-parent-scale-fail \
  RESTORE_CHECKPOINT_PREPARE_FENCE=1 \
  CONFIRM_PREPARE_RESTORE_FENCE="$PREPARE_FENCE_CONFIRMATION" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
parent_scale_failure_line="$(deployment_patch_first_line bot-orchestrator 0)"
role_neutralization_line="$(grep -En 'replace -f - -o json' "$KUBECTL_LOG" |
  head -1 | cut -d: -f1 || :)"
if [[ "$parent_scale_failure_line" =~ ^[0-9]+$ &&
      "$role_neutralization_line" =~ ^[0-9]+$ &&
      "$parent_scale_failure_line" -lt "$role_neutralization_line" &&
      -f "$STUB_STATE_DIR/runner-role-replace-payload.json" ]] &&
   jq -e '.kind == "Role" and .metadata.uid == "runner-role-uid" and
     .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] ==
       "restore-fence" and .rules == []' \
     "$STUB_STATE_DIR/runner-role-replace-payload.json" >/dev/null &&
   [[ "$LAST_OUTPUT" != *'Restore fence prepared and locked'* ]]; then
  pass 'failed parent scale cannot retain runner create/delete authority'
else
  fail 'parent-scale failure Role neutralization ordering' \
    "$LAST_OUTPUT
$(cat "$KUBECTL_LOG")"
fi

reset_stub
expect_success 'dormant execute rejection fixture prepares its exact source fence' \
  prepare_fence_fixture
apply_restore_fence_fixture
seed_recovery_operation_fence_binding_state dormant \
  recovery-operation-fence-binding-rv-3
dormant_execute_confirmation="$(execute_fence_confirmation)"
: >"$KUBECTL_LOG"
expect_failure 'execute-fenced rejects a Cloud-deactivated admission fence' \
  'admission fence is not active' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
  RESTORE_CHECKPOINT_EXECUTE_FENCED=1 \
  CONFIRM_EXECUTE_RESTORE_FENCE="$dormant_execute_confirmation" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
if recovery_operation_fence_binding_state_is dormant \
     recovery-operation-fence-binding-rv-3 &&
   recovery_operation_fence_binding_was_not_replaced &&
   restore_lock_state_is restore-fence-prepared lock-rv-1 &&
   [[ ! -e "$STUB_STATE_DIR/restore-lock-replace-payload.json" ]] &&
   ! grep -Eq 'dropdb|tar -C /storage -xf -|delete --raw=' \
     "$KUBECTL_LOG"; then
  pass 'dormant execute rejection preserves the prepared lock and all Cloud-owned fence state'
else
  fail 'dormant execute rejection exact no-mutation boundary' \
    "$(cat "$KUBECTL_LOG")"
fi

run_restore_execute_cas_tests

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
   grep -q "yenhubs.org/pre-fence-epoch: \"$LIVE_RUNNER_EPOCH\"" \
     "$STUB_STATE_DIR/restore-lock.yaml" &&
   grep -q "yenhubs.org/runner-cutover-evidence-sha256: \"$CHECKPOINT_EVIDENCE_SHA\"" \
     "$STUB_STATE_DIR/restore-lock.yaml" &&
   grep -q 'yenhubs.org/runner-runtime-generation: "durable-v2"' \
     "$STUB_STATE_DIR/restore-lock.yaml" &&
   ! grep -Eq 'dropdb|tar -C /storage -xf -' "$KUBECTL_LOG" &&
   [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]] &&
   ! grep -q "/namespaces/hcce-bot-runners/pods/$RUNNER_FIXTURE_NAME" \
     "$KUBECTL_LOG"; then
  pass 'prepare-fence binds schema-3 evidence/generation and preserves its exact durable fence'
else
  fail 'prepare-fence exact persistent contract' "$(cat "$KUBECTL_LOG")"
fi
if recovery_operation_fence_binding_state_is dormant \
     recovery-operation-fence-binding-rv-1 &&
   recovery_operation_fence_binding_was_not_replaced; then
  pass 'PREPARE adopts dormant RV1 without replacing the Cloud-owned fifth fence'
else
  fail 'PREPARE exact dormant fifth-fence identity' "$(cat "$KUBECTL_LOG")"
fi

execute_before_manifest_confirmation="$(execute_fence_confirmation)"
: >"$KUBECTL_LOG"
expect_failure 'execute-fenced rejects the pre-fence live epoch before standard manifest apply' \
  'live restore-fence epoch is not the exact new candidate' env \
  EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_EVIDENCE_LIVE_DIR" \
  RESTORE_CHECKPOINT_EXECUTE_FENCED=1 \
  CONFIRM_EXECUTE_RESTORE_FENCE="$execute_before_manifest_confirmation" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
if grep -Eq 'dropdb|tar -C /storage -xf -' "$KUBECTL_LOG"; then
  fail 'pre-manifest execute performs no restore' "$(cat "$KUBECTL_LOG")"
else
  pass 'pre-manifest execute performs no restore'
fi

apply_restore_fence_fixture
if recovery_operation_fence_binding_state_is active \
     recovery-operation-fence-binding-rv-2 &&
   recovery_operation_fence_binding_was_not_replaced; then
  pass 'standard Cloud restore-fence fixture advances the fifth fence to active RV2'
else
  fail 'standard Cloud restore-fence fixture identity' "$(cat "$KUBECTL_LOG")"
fi
: >"$KUBECTL_LOG"
# shellcheck disable=SC2016 # Expanded by the isolated fixture process.
expect_success 'live recovery phase reads the exact Deployment metadata annotation'   env EXPECTED_KUBE_CONTEXT=fixture-context bash -c '
    set -euo pipefail
    NAMESPACE=hcce
    source "$1"
    recovery_require_live_runner_recovery_phase restore-fence
  ' _ "$ROOT_DIR/deployment/lib/recovery-safety.sh"

: >"$KUBECTL_LOG"
expect_failure 'execute-fenced rejects a generic confirmation after manifest apply' \
  'Refusing restore fence phase' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
  RESTORE_CHECKPOINT_EXECUTE_FENCED=1 \
  CONFIRM_EXECUTE_RESTORE_FENCE=execute-fenced \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
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
   restore_lock_state_is restore-complete-awaiting-reactivation lock-rv-2 &&
   recovery_operation_fence_binding_state_is active \
     recovery-operation-fence-binding-rv-2 &&
   recovery_operation_fence_binding_was_not_replaced &&
   jq -e '
     .kind == "ConfigMap" and
     .metadata.uid == "restore-lock-uid" and
     .metadata.resourceVersion == "lock-rv-1" and
     .metadata.annotations["yenhubs.org/recovery-state"] ==
       "restore-complete-awaiting-reactivation"
   ' "$STUB_STATE_DIR/restore-lock-replace-payload.json" >/dev/null &&
   [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]] &&
   ! grep -q "/namespaces/hcce-bot-runners/pods/$RUNNER_FIXTURE_NAME" \
     "$KUBECTL_LOG" &&
   [[ ! -e "$STUB_STATE_DIR/runner-fence-delete-attempted" ]] &&
   ! grep -Eq -- 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock'      "$KUBECTL_LOG"; then
  pass 'durable children accept the stable fence and CAS only after joint validation'
else
  fail 'execute-fenced persistent post-restore fence contract' "$(cat "$KUBECTL_LOG")"
fi

run_restore_finalize_positive_test

prime_completed_restore_for_finalizer
seed_recovery_operation_fence_binding_state active \
  recovery-operation-fence-binding-rv-4
: >"$KUBECTL_LOG"
expect_failure 'finalizer rejects an admission fence that is still active' \
  'admission_pair_not_exact' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
  RESTORE_CHECKPOINT_FINALIZE_REACTIVATION=1 \
  CONFIRM_FINALIZE_RESTORE_REACTIVATION="$FINALIZER_TEST_CONFIRMATION" \
  STUB_RUNNER_NAMESPACE=present \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
finalize_active_all_unchanged=true
for finalize_active_consumer in \
  reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ "$(cat "$STUB_STATE_DIR/replicas-$finalize_active_consumer" \
        2>/dev/null || :)" != 1 ]]; then
    finalize_active_all_unchanged=false
  fi
done
if [[ "$finalize_active_all_unchanged" == true &&
      "$(cat "$STUB_STATE_DIR/runner-role-phase")" == active ]] &&
   restore_lock_state_is restore-complete-awaiting-reactivation lock-rv-2 &&
   recovery_operation_fence_binding_state_is active \
     recovery-operation-fence-binding-rv-4 &&
   recovery_operation_fence_binding_was_not_replaced &&
   ! any_deployment_replica_mutation &&
   ! grep -Eq -- \
     'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock' \
     "$KUBECTL_LOG"; then
  pass 'active fifth-fence FINALIZE rejection is read-only and retains lock/workloads'
else
  fail 'active fifth-fence FINALIZE fail-closed contract' "$(cat "$KUBECTL_LOG")"
fi

prime_completed_restore_for_finalizer
finalize_confirmation="$FINALIZER_TEST_CONFIRMATION"
expect_failure 'finalizer fail-close CAS-neutralizes the exact captured runner Role' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
  RESTORE_CHECKPOINT_FINALIZE_REACTIVATION=1 \
  CONFIRM_FINALIZE_RESTORE_REACTIVATION="$finalize_confirmation" \
  STUB_MODE=finalizer-failclose STUB_RUNNER_NAMESPACE=present \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
finalizer_all_fences_attempted=true
for finalizer_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$finalizer_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$finalizer_consumer")" != 0 ]] ||
     [[ "$(deployment_patch_count "$finalizer_consumer" 0)" == 0 ]]; then
    finalizer_all_fences_attempted=false
  fi
done
if [[ "$finalizer_all_fences_attempted" == true &&
      ! -e "$STUB_STATE_DIR/restore-lock.yaml" &&
      "$(cat "$STUB_STATE_DIR/runner-role-uid")" == runner-role-uid &&
      "$(cat "$STUB_STATE_DIR/runner-role-phase")" == restore-fence ]] &&
   jq -e '. == []' "$STUB_STATE_DIR/runner-role-rules.json" >/dev/null &&
   jq -e '.kind == "Role" and .metadata.uid == "runner-role-uid" and
     .metadata.resourceVersion == "runner-role-rv-3" and
     .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] ==
       "restore-fence" and .rules == []' \
     "$STUB_STATE_DIR/runner-role-replace-payload.json" >/dev/null &&
   ! grep -q "/namespaces/hcce-bot-runners/pods/$RUNNER_FIXTURE_NAME" \
     "$KUBECTL_LOG" &&
   [[ ! -e "$STUB_STATE_DIR/runner-fence-delete-attempted" ]]; then
  pass 'finalizer fail-close uses the captured Role UID/RV CAS before preserving absence'
else
  fail 'finalizer exact Role fail-close contract' "$(cat "$KUBECTL_LOG")"
fi

prime_completed_restore_for_finalizer
expect_failure 'finalizer reconciles a lost Role replace response only via same-UID inert readback' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
  RESTORE_CHECKPOINT_FINALIZE_REACTIVATION=1 \
  CONFIRM_FINALIZE_RESTORE_REACTIVATION="$FINALIZER_TEST_CONFIRMATION" \
  STUB_MODE=finalizer-role-lost-response STUB_RUNNER_NAMESPACE=present \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
if [[ -e "$STUB_STATE_DIR/finalizer-role-lost-response" &&
      "$(cat "$STUB_STATE_DIR/runner-role-uid")" == runner-role-uid &&
      "$(cat "$STUB_STATE_DIR/runner-role-phase")" == restore-fence ]] &&
   jq -e '. == []' "$STUB_STATE_DIR/runner-role-rules.json" >/dev/null; then
  pass 'lost Role response accepts only the inert contract on the captured UID'
else
  fail 'lost Role response reconciliation' "$(cat "$KUBECTL_LOG")"
fi

for finalizer_role_cas_mode in finalizer-role-cas-replaced finalizer-role-cas-drift; do
  prime_completed_restore_for_finalizer
  expect_failure "$finalizer_role_cas_mode rejects unknown Role state after the captured CAS window" '' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
    RESTORE_CHECKPOINT_FINALIZE_REACTIVATION=1 \
    CONFIRM_FINALIZE_RESTORE_REACTIVATION="$FINALIZER_TEST_CONFIRMATION" \
    STUB_MODE="$finalizer_role_cas_mode" STUB_RUNNER_NAMESPACE=present \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  finalizer_cas_all_zero=true
  for finalizer_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    if [[ "$(cat "$STUB_STATE_DIR/replicas-$finalizer_consumer" 2>/dev/null || :)" != 0 ]]; then
      finalizer_cas_all_zero=false
    fi
  done
  if [[ "$finalizer_cas_all_zero" == true &&
        "$(cat "$STUB_STATE_DIR/runner-role-phase")" == active ]] &&
     jq -e '. == [{apiGroups:[""],resources:["pods"],
       verbs:["create","delete","get","list","patch"]}]' \
       "$STUB_STATE_DIR/runner-role-rules.json" >/dev/null; then
    pass "$finalizer_role_cas_mode leaves the unknown capable Role untouched while fencing deployments"
  else
    fail "$finalizer_role_cas_mode unknown Role no-adoption contract" \
      "$(cat "$KUBECTL_LOG")"
  fi
done

prime_completed_restore_for_finalizer
expect_failure 'finalizer fail-close does not adopt a preexisting replacement Role or Deployment' '' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
  RESTORE_CHECKPOINT_FINALIZE_REACTIVATION=1 \
  CONFIRM_FINALIZE_RESTORE_REACTIVATION="$FINALIZER_TEST_CONFIRMATION" \
  STUB_MODE=finalizer-failclose-drift STUB_RUNNER_NAMESPACE=present \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
finalizer_all_fences_attempted=true
for finalizer_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ "$(cat "$STUB_STATE_DIR/replicas-$finalizer_consumer" 2>/dev/null || :)" != 0 ]] ||
     [[ "$(deployment_patch_count "$finalizer_consumer" 0)" == 0 ]]; then
    finalizer_all_fences_attempted=false
  fi
done
if [[ "$finalizer_all_fences_attempted" == true &&
      "$(cat "$STUB_STATE_DIR/runner-role-uid")" == replacement-runner-role-uid &&
      "$(cat "$STUB_STATE_DIR/runner-role-phase")" == active ]] &&
   jq -e '. == [{apiGroups:[""],resources:["pods","secrets"],verbs:["*"]}]' \
     "$STUB_STATE_DIR/runner-role-rules.json" >/dev/null &&
   [[ ! -e "$STUB_STATE_DIR/runner-role-replace-payload.json" ]]; then
  pass 'replacement Role remains untouched while every known Deployment is reduced'
else
  fail 'replacement Role no-adoption fail-close contract' "$(cat "$KUBECTL_LOG")"
fi

reset_stub
expect_success 'failure fixture prepares a new persistent fence' prepare_fence_fixture
apply_restore_fence_fixture
failed_execute_confirmation="$(execute_fence_confirmation)"
: >"$KUBECTL_LOG"
expect_failure 'coordinated storage failure retains every consumer at zero and the exact lock' \
  'non-empty or unsafe' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
  RESTORE_CHECKPOINT_EXECUTE_FENCED=1 \
  CONFIRM_EXECUTE_RESTORE_FENCE="$failed_execute_confirmation" \
  STUB_MODE=destination-nonempty RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
failure_held_zero=true
for failed_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  if [[ ! -f "$STUB_STATE_DIR/replicas-$failed_consumer" ||
        "$(cat "$STUB_STATE_DIR/replicas-$failed_consumer")" != 0 ]]; then
    failure_held_zero=false
  fi
done
if [[ "$failure_held_zero" == true && -f "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]] &&
   ! grep -Eq -- 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock'      "$KUBECTL_LOG"; then
  pass 'failed execute-fenced has no partial resume or lock release'
else
  fail 'failed execute-fenced remains fail-closed' "$(cat "$KUBECTL_LOG")"
fi

reset_stub
seed_schema2_legacy_stale_restore_lock available
LEGACY_CLEAR_EVIDENCE_SHA="$(sha256_digest \
  "$GOOD_CHECKPOINT/deployment-images.json")"
CONFIRM_CLEAR_LOCK="restore-lock:fixture-context:hcce:fixture-uid:$STAMP:$DUMP_SHA:$STORAGE_SHA:restore-lock-uid:fixture-pvc-uid:$LEGACY_CLEAR_EVIDENCE_SHA:legacy-absent"
: >"$KUBECTL_LOG"
expect_failure 'stale restore lock refuses clearance while any fixed consumer is active' \
  'Every DB consumer must already be at zero' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
  STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
  CONFIRM_CLEAR_RESTORE_LOCK="$CONFIRM_CLEAR_LOCK" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if [[ -f "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   ! any_deployment_replica_mutation &&
   ! grep -Eq 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG"; then
  pass 'stale-lock quiescence gate neither scales workloads nor deletes the lock'
else
  fail 'stale-lock quiescence gate is mutation-free' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
seed_schema2_legacy_stale_restore_lock available
seed_stale_restore_helper
expect_failure 'bad stale-lock confirmation preserves the exact helper and policy' \
  'for this exact target' env EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
  STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
  CONFIRM_CLEAR_RESTORE_LOCK=restore-lock \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if [[ -e "$STUB_STATE_DIR/pod-created" && -e "$STUB_STATE_DIR/network-policy.yaml" &&
      -e "$STUB_STATE_DIR/restore-lock.yaml" ]] && ! grep -q 'delete --raw=' "$KUBECTL_LOG"; then
  pass 'bad stale-lock confirmation performs no helper, policy or lock deletion'
else
  fail 'bad stale-lock confirmation performs no helper, policy or lock deletion' "$(cat "$KUBECTL_LOG")"
fi
reset_stub
seed_schema2_legacy_stale_restore_lock available
for stale_consumer in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  printf 0 >"$STUB_STATE_DIR/replicas-$stale_consumer"
done
: >"$KUBECTL_LOG"
expect_success 'exact legacy stale-lock clearance is a clear-only recovery action' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" STUB_RUNNER_NAMESPACE= \
  STUB_RUNNER_POD_PROFILE= RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
  CONFIRM_CLEAR_RESTORE_LOCK="$CONFIRM_CLEAR_LOCK" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$GOOD_CHECKPOINT"
if [[ ! -e "$STUB_STATE_DIR/restore-lock.yaml" ]] &&
   grep -q 'delete --raw=.*/configmaps/yenhubs-recovery-operation-lock ' "$KUBECTL_LOG" &&
   jq -e '.preconditions == {uid:"restore-lock-uid",resourceVersion:"lock-rv-1"}' \
     "$STUB_STATE_DIR/delete-options-1.json" >/dev/null &&
   ! any_deployment_replica_mutation && ! grep -Eq 'rollout status' "$KUBECTL_LOG"; then
  pass 'legacy stale-lock clearance deletes only the pinned lock and resumes nothing'
else
  fail 'legacy stale-lock clearance deletes only the pinned lock and resumes nothing' \
    "$(cat "$KUBECTL_LOG")"
fi

for active_clear_lock_state in \
  restore-fence-prepared \
  restore-complete-awaiting-reactivation; do
  reset_stub
  expect_success "$active_clear_lock_state clear rejection fixture prepares its source fence" \
    prepare_fence_fixture
  apply_restore_fence_fixture
  active_clear_expected_lock_rv=lock-rv-1
  if [[ "$active_clear_lock_state" == \
        restore-complete-awaiting-reactivation ]]; then
    expect_success 'active clear rejection fixture reaches completed restore state' \
      execute_fenced_fixture
    active_clear_expected_lock_rv=lock-rv-2
  fi
  active_clear_operation_id="$(test_yaml_field 'yenhubs.org/operation-id:' \
    "$STUB_STATE_DIR/restore-lock.yaml")"
  active_clear_operation_token="$(test_yaml_field 'yenhubs.org/recovery-token:' \
    "$STUB_STATE_DIR/restore-lock.yaml")"
  seed_stale_restore_helper "$active_clear_operation_id" \
    "$active_clear_operation_token"
  ACTIVE_CLEAR_CONFIRMATION="restore-lock:fixture-context:hcce:fixture-uid:$STAMP:$DURABLE_RESTORE_DUMP_SHA:$DURABLE_RESTORE_STORAGE_SHA:restore-lock-uid:fixture-pvc-uid:$CHECKPOINT_EVIDENCE_SHA:durable-v2"
  : >"$KUBECTL_LOG"
  expect_failure "clear-stale retains $active_clear_lock_state while the fifth fence is active" \
    'separate, reviewed Cloud-owned recovery procedure' \
    env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
    EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$RESTORE_FENCE_VALUES_FIXTURE" \
    HCCE_MANIFEST_PATH="$RUNNER_RESTORE_FENCE_MANIFEST_FIXTURE" \
    RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_RESTORE_FENCE_LIVE_DIR" \
    RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
    CONFIRM_CLEAR_RESTORE_LOCK="$ACTIVE_CLEAR_CONFIRMATION" \
    "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
  if [[ -e "$STUB_STATE_DIR/pod-created" &&
        -e "$STUB_STATE_DIR/network-policy.yaml" ]] &&
     restore_lock_state_is "$active_clear_lock_state" \
       "$active_clear_expected_lock_rv" &&
     recovery_operation_fence_binding_state_is active \
       recovery-operation-fence-binding-rv-2 &&
     recovery_operation_fence_binding_was_not_replaced &&
     ! any_deployment_replica_mutation &&
     ! grep -q 'delete --raw=' "$KUBECTL_LOG"; then
    pass "$active_clear_lock_state active-fence rejection preserves helper, policy and lock"
  else
    fail "$active_clear_lock_state active-fence clear-stale fail-closed contract" \
      "$(cat "$KUBECTL_LOG")"
  fi
done

reset_stub
expect_success 'durable clear-stale receipt fixture prepares a persistent restore fence' \
  prepare_fence_fixture
apply_restore_fence_fixture
expect_success 'durable clear-stale receipt fixture reaches completed restore state' \
  execute_fenced_fixture
apply_active_reactivation_fixture 0
apply_fail_closed_active_fixture
durable_receipt_operation_id="$(test_yaml_field 'yenhubs.org/operation-id:' \
  "$STUB_STATE_DIR/restore-lock.yaml")"
durable_receipt_operation_token="$(test_yaml_field 'yenhubs.org/recovery-token:' \
  "$STUB_STATE_DIR/restore-lock.yaml")"
seed_stale_restore_helper "$durable_receipt_operation_id" \
  "$durable_receipt_operation_token"
printf '%s' "$durable_receipt_operation_id" \
  >"$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum"
DURABLE_RECEIPT_CLEAR_CONFIRMATION="restore-lock:fixture-context:hcce:fixture-uid:$STAMP:$DURABLE_RESTORE_DUMP_SHA:$DURABLE_RESTORE_STORAGE_SHA:restore-lock-uid:fixture-pvc-uid:$CHECKPOINT_EVIDENCE_SHA:durable-v2"
: >"$KUBECTL_LOG"
expect_failure 'durable clear-stale rejects every checkpoint resume receipt' \
  'checkpoint resume receipt ownership is not exact' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$RESTORE_VALUES_FIXTURE" \
  HCCE_MANIFEST_PATH="$RUNNER_ACTIVE_TARGET_MANIFEST_FIXTURE" \
  RUNNER_EVIDENCE_LIVE_DIR="$RUNNER_ACTIVE_TARGET_LIVE_DIR" \
  RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
  CONFIRM_CLEAR_RESTORE_LOCK="$DURABLE_RECEIPT_CLEAR_CONFIRMATION" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" "$DURABLE_RESTORE_CHECKPOINT"
if [[ -e "$STUB_STATE_DIR/pod-created" &&
      -e "$STUB_STATE_DIR/network-policy.yaml" &&
      -e "$STUB_STATE_DIR/restore-lock.yaml" &&
      "$(cat "$STUB_STATE_DIR/checkpoint-resume-receipt-reticulum")" == \
        "$durable_receipt_operation_id" ]] &&
   ! any_deployment_replica_mutation &&
   ! grep -Eq 'delete --raw=|"op":"remove","path":"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"' \
     "$KUBECTL_LOG"; then
  pass 'durable receipt rejection preserves helper, policy, receipt and exact lock'
else
  fail 'durable receipt rejection is mutation-free and fail-closed' \
    "$(cat "$KUBECTL_LOG")"
fi

run_restore_clear_stale_final_evidence_test
run_restore_clear_stale_success_test

run_stale_helper_cleanup_tests

STUB_DEPLOYMENTS_JSON="$RESTORE_PHASE_PREVIOUS_DEPLOYMENTS_JSON"
export STUB_DEPLOYMENTS_JSON
unset STUB_RUNNER_NAMESPACE STUB_RUNNER_POD_PROFILE

reset_stub
DB_BACKUP="$TMP_DIR/backup/retdb-$STAMP.sql.gz"
expect_failure 'standalone DB backup is disabled in favor of atomic checkpoints' \
  'Standalone database backup is superseded' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  "$ROOT_DIR/deployment/backup-retdb.sh" "$DB_BACKUP"
if [[ ! -e "$DB_BACKUP" &&
      ! -e "$(dirname "$DB_BACKUP")/database-contract.json" &&
      ! -s "$KUBECTL_LOG" ]]; then
  pass 'standalone DB backup fails before Kubernetes and output creation'
else
  fail 'standalone DB backup no-I/O contract' "$(cat "$KUBECTL_LOG")"
fi

reset_stub
STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
DB_BACKUP_ROOT="$TMP_DIR/coordinated-db-backup"
expect_success 'coordinated DB backup validates complete SQL marker/COPY contract' \
  run_checkpoint_backup_child db "$DB_BACKUP_ROOT" legacy-absent "" "" "" \
    "$GOOD_CHECKPOINT/deployment-images.json"
DB_BACKUP="$DB_BACKUP_ROOT/retdb-$STAMP.sql.gz"
if [[ -f "$DB_BACKUP" && "$(file_mode "$DB_BACKUP")" == 600 ]]; then
  pass 'coordinated DB backup is mode 0600'
else
  fail 'coordinated DB backup is mode 0600' \
    "mode=$(file_mode "$DB_BACKUP" 2>/dev/null || printf missing)"
fi

reset_stub
STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
STUB_MODE='contract-drift-after'
export STUB_MODE
expect_failure 'coordinated DB backup rejects live contract drift during pg_dump' \
  'changed while the dump' run_checkpoint_backup_child db \
  "$TMP_DIR/drift-backup" legacy-absent "" "" "" \
  "$GOOD_CHECKPOINT/deployment-images.json"
unset STUB_MODE

reset_stub
STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
STUB_SQL_PLAIN="$ZERO_ACTIVE_PLAIN"
export STUB_SQL_PLAIN
expect_failure 'coordinated DB backup rejects source/dump active mismatch' \
  'complete critical' run_checkpoint_backup_child db "$TMP_DIR/bad-backup" \
  legacy-absent "" "" "" "$GOOD_CHECKPOINT/deployment-images.json"
STUB_SQL_PLAIN="$SQL_PLAIN"
export STUB_SQL_PLAIN

reset_stub
STORAGE_BACKUP="$TMP_DIR/backup/ret-storage-$STAMP.tar.gz"
expect_failure 'standalone storage-only backup is disabled in favor of atomic checkpoints' \
  'Standalone ret-pvc backup is superseded' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  YENHUBS_PARENT_WRITER_MONITOR_PID=999999 \
  "$ROOT_DIR/deployment/backup-ret-storage.sh" "$STORAGE_BACKUP"
if [[ ! -e "$STORAGE_BACKUP" && ! -s "$KUBECTL_LOG" ]]; then
  pass 'standalone storage backup fails before Kubernetes and output creation'
else
  fail 'standalone storage backup no-I/O contract' "$(cat "$KUBECTL_LOG")"
fi

reset_stub
STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
STORAGE_BACKUP_ROOT="$TMP_DIR/coordinated-storage-backup"
expect_success 'coordinated storage backup validates complete pairs and pinned PVC/pod identity' \
  run_checkpoint_backup_child storage "$STORAGE_BACKUP_ROOT" legacy-absent \
  "" "" "" "$GOOD_CHECKPOINT/deployment-images.json"
STORAGE_BACKUP="$STORAGE_BACKUP_ROOT/ret-storage-$STAMP.tar.gz"
if [[ -f "$STORAGE_BACKUP" && "$(file_mode "$STORAGE_BACKUP")" == 600 ]]; then
  pass 'coordinated storage backup is mode 0600'
else
  fail 'coordinated storage backup is mode 0600' \
    "mode=$(file_mode "$STORAGE_BACKUP" 2>/dev/null || printf missing)"
fi

reset_stub
STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
expect_failure 'coordinated storage backup rejects the wrong PVC UID before tar' \
  'PVC UID mismatch' run_checkpoint_backup_child storage "$TMP_DIR/wrong-pvc" \
  legacy-absent "" "" "" "$GOOD_CHECKPOINT/deployment-images.json" healthy wrong

reset_stub
STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
STUB_MODE=backup-extra-consumer
export STUB_MODE
expect_failure 'coordinated storage backup rejects any extra ret-pvc consumer before tar' \
  'Unexpected pods consume PVC' run_checkpoint_backup_child storage \
  "$TMP_DIR/extra-consumer" legacy-absent "" "" "" \
  "$GOOD_CHECKPOINT/deployment-images.json"
unset STUB_MODE

reset_stub
STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
STUB_MODE=backup-monitor-extra
export STUB_MODE
expect_failure 'coordinated storage monitor catches a transient extra ret-pvc consumer' \
  'monitor failed' run_checkpoint_backup_child storage "$TMP_DIR/monitor-extra" \
  legacy-absent "" "" "" "$GOOD_CHECKPOINT/deployment-images.json"
unset STUB_MODE

reset_stub
CAPTURE_DIR="$TMP_DIR/captured-state"
expect_success 'legacy state capture does not require an unbuilt runner candidate digest' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  "$ROOT_DIR/deployment/capture-instance-state.sh" "$CAPTURE_DIR"
if grep -R -q SECRET_SENTINEL "$CAPTURE_DIR"; then fail 'capture excludes env/args/commands/annotations/values' 'secret sentinel leaked'; else pass 'capture excludes env/args/commands/annotations/values'; fi
if jq -e '.items[0].data_keys == ["credential"] and .items[0].binary_data_keys == ["certificate"]' "$CAPTURE_DIR/k8s-configmaps-redacted.json" >/dev/null && jq -e '
  .schema_version == 4 and .bot_runner_runtime == {
    generation:"legacy-absent",mode:"process-local",image:null,
    control_plane:{state:"legacy-absent"},
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
cp "$DURABLE_RESTORE_CHECKPOINT/deployment-images.json" \
  "$KUBERNETES_RUNNER_INVENTORY"
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
    "$KUBERNETES_RUNNER_INVENTORY" >"$BAD_RUNNER_INVENTORY"
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
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-tail ]]; then
  reset_stub
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard
  STUB_SQL_PLAIN="$ZERO_ACTIVE_PLAIN"
  export STUB_SQL_PLAIN
  expect_failure 'focused DB mismatch restores its SQL fixture before checkpoint tail' \
    'complete critical' run_checkpoint_backup_child db \
    "$TMP_DIR/focused-bad-backup" legacy-absent "" "" "" \
    "$GOOD_CHECKPOINT/deployment-images.json"
  STUB_SQL_PLAIN="$SQL_PLAIN"
  export STUB_SQL_PLAIN
fi

if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" != checkpoint-tail-final &&
      "${YENHUBS_RECOVERY_TEST_FOCUS:-}" != checkpoint-tail-after-children ]]; then
CREATE_PARENT="$TMP_DIR/atomic-create"
CREATE_PROCESS_LOCAL="$CREATE_PARENT/process-local-checkpoint"
reset_stub
expect_success 'process-local checkpoint publishes and resumes the exact accepted legacy boundary' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_PROCESS_LOCAL"
if jq -e '.schema_version == 4 and
    .bot_runner_runtime.generation == "legacy-absent" and
    .bot_runner_runtime.mode == "process-local" and
    .bot_runner_runtime.control_plane == {state:"legacy-absent"} and
    .bot_runner_runtime.recovery_epoch == {state:"legacy-absent"}' \
    "$CREATE_PROCESS_LOCAL/deployment-images.json" >/dev/null &&
   jq -e '.schema_version == 3 and .runtime_generation == "legacy-absent" and
     (.runner_cutover_evidence_sha256 | test("^[a-f0-9]{64}$"))' \
     "$CREATE_PROCESS_LOCAL/checkpoint-metadata.json" >/dev/null &&
   jq -e '.schema_version == 3 and .runtime_generation == "legacy-absent" and
     .recovery_operation_fence_state == "dormant" and
     .quiescence == {runners:0,intents:0,fences:[]}' \
     "$CREATE_PROCESS_LOCAL/runner-cutover-evidence.json" >/dev/null &&
   [[ ! -e "$STUB_STATE_DIR/runner-control-plane-verifier-count" ]] &&
   [[ "$(deployment_patch_count bot-orchestrator 0)" == 1 ]] &&
   [[ "$(deployment_patch_count bot-orchestrator 1)" == 1 ]]; then
  pass 'process-local checkpoint does not consult candidate manifest and restores its parent'
else
  fail 'process-local checkpoint mode binding and exact resume' "$(cat "$KUBECTL_LOG")"
fi
if [[ -d "$CREATE_PROCESS_LOCAL" ]]; then
  run_schema3_evidence_layout_tests "$CREATE_PROCESS_LOCAL"
  run_schema3_evidence_materialization_test "$CREATE_PROCESS_LOCAL"
else
  fail 'schema 3 evidence layout regressions execute' 'process-local checkpoint missing'
  fail 'schema 3 evidence materialization regression executes' 'process-local checkpoint missing'
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
  RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_PROCESS_LOCAL_DRIFT"
if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
   [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]] &&
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
  'Checkpoint runner mode changed while writers were fenced' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$CHECKPOINT_PARTIAL_PROCESS_LOCAL" \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_PARENT/process-local-partial"
if any_deployment_replica_mutation; then
  fail 'partial isolated binding mutated writer replicas' "$(cat "$KUBECTL_LOG")"
else
  pass 'partial isolated binding performs zero writer replica mutations'
fi
reset_stub
expect_failure 'residual runner Namespace cannot fall back to process-local checkpoint' \
  'Checkpoint runner mode changed while writers were fenced' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  STUB_RUNNER_NAMESPACE=present \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_PARENT/process-local-namespace"
if any_deployment_replica_mutation; then
  fail 'residual runner Namespace mutated writer replicas' "$(cat "$KUBECTL_LOG")"
else
  pass 'residual runner Namespace performs zero writer replica mutations'
fi
reset_stub
expect_failure 'adjacent process-local drift blocks parent resume' \
  'Checkpoint runner mode changed while writers were fenced' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
  STUB_MODE=checkpoint-process-local-adjacent-drift \
  RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$CREATE_PARENT/process-local-adjacent-drift"
if [[ "$(cat "$STUB_STATE_DIR/replicas-bot-orchestrator" 2>/dev/null || :)" == 0 ]] &&
   [[ "$(deployment_patch_count bot-orchestrator 1)" == 0 ]] &&
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
  RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$CREATE_PARENT/process-local-parent-wait"
if checkpoint_process_local_pre_watcher_outcome_is_safe; then
  pass 'pre-watcher quiesce failure reaches exact rollback or retains parent authority fail-closed'
else
  fail 'pre-watcher quiesce failure strands parent or lock' "$(cat "$KUBECTL_LOG")"
fi
for residual_resource in \
  parent-serviceaccount parent-role parent-rolebinding cutover-journal \
  runner-pull-secret runner-serviceaccount guard-serviceaccount \
  runner-quota guard-quota runner-role runner-rolebinding \
  runner-network-default-deny runner-network-egress \
  policy-pods binding-pods policy-durable binding-durable \
  policy-journal binding-journal policy-parent binding-parent; do
  reset_stub
  expect_failure "residual $residual_resource cannot fall back to process-local checkpoint" \
    'Checkpoint runner mode changed while writers were fenced' \
    env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
    VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
    STUB_DEPLOYMENTS_JSON="$LEGACY_DEPLOYMENTS_JSON" \
    STUB_RUNNER_RESIDUAL="$residual_resource" \
    "$ROOT_DIR/deployment/create-checkpoint.sh" \
    "$CREATE_PARENT/process-local-residual-$residual_resource"
  if any_deployment_replica_mutation; then
    fail "residual $residual_resource mutated writer replicas" "$(cat "$KUBECTL_LOG")"
  else
    pass "residual $residual_resource performs zero writer replica mutations"
  fi
done
ANNOTATED_PROCESS_LOCAL="$TMP_DIR/deployments-process-local-non-parent-annotation.json"
jq '(.items[] | select(.metadata.name == "pgbouncer") |
    .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"]) = "active"' \
  "$LEGACY_DEPLOYMENTS_JSON" >"$ANNOTATED_PROCESS_LOCAL"
reset_stub
expect_failure 'non-parent runner annotation cannot fall back to process-local checkpoint' \
  'Checkpoint runner mode changed while writers were fenced' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_PROCESS_LOCAL_FIXTURE" \
  STUB_DEPLOYMENTS_JSON="$ANNOTATED_PROCESS_LOCAL" \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$CREATE_PARENT/process-local-non-parent-annotation"
if any_deployment_replica_mutation; then
  fail 'non-parent runner annotation mutated writer replicas' "$(cat "$KUBECTL_LOG")"
else
  pass 'non-parent runner annotation performs zero writer replica mutations'
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
    RECOVERY_STREAM_POLL_SECONDS=0.01 \
    "$ROOT_DIR/deployment/create-checkpoint.sh" "$checkpoint_preflight_output"
  if ! any_deployment_replica_mutation; then
    pass "$checkpoint_preflight_case performs zero writer replica mutations"
  else
    fail "$checkpoint_preflight_case mutated writer replicas during preflight" \
      "$(cat "$KUBECTL_LOG")"
  fi
done
reset_stub
seed_recovery_operation_fence_binding_state dormant
expect_success 'checkpoint creation publishes one fully verified directory atomically' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" RECOVERY_STREAM_POLL_SECONDS=0.01 "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_FINAL"
if jq -e '.schema_version == 4 and
      .bot_runner_runtime.generation == "durable-v2" and
      .bot_runner_runtime.mode == "kubernetes-pod"' \
      "$CREATE_FINAL/deployment-images.json" >/dev/null &&
   jq -e '.schema_version == 3 and .runtime_generation == "durable-v2" and
      (.runner_cutover_evidence_sha256 | test("^[a-f0-9]{64}$"))' \
      "$CREATE_FINAL/checkpoint-metadata.json" >/dev/null &&
   jq -e '.schema_version == 3 and .runtime_generation == "durable-v2" and
      .recovery_operation_fence_state == "active" and
      .journal.state == "present" and
      .journal.hmac_verification == "verified-owner-key" and
      .admission.state == "present" and
      .admission.parent_resources.state == "present"' \
      "$CREATE_FINAL/runner-cutover-evidence.json" >/dev/null; then
  pass 'schema 3 durable checkpoint binds schema 4 inventory and complete schema 3 evidence'
else
  fail 'schema 3 durable generation and evidence binding' 'published contract is incomplete'
fi
checkpoint_dump_line="$(grep -n 'pg_dump -U' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
checkpoint_archive_line="$(grep -n 'tar -C /storage -cf - owned' "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
checkpoint_resume_line="$(deployment_patch_first_line bot-orchestrator 1)"
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
checkpoint_parent_resume_line="$(deployment_patch_first_line bot-orchestrator 1)"
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
run_checkpoint_local_input_preflight_tests "$CREATE_PARENT/local-input-preflight"
run_checkpoint_input_snapshot_test "$CREATE_PARENT/local-input-mutation"
run_durable_runner_profile_checkpoint_tests "$CREATE_PARENT/durable-runner-profiles"
run_checkpoint_finalization_diagnostic_tests "$CREATE_PARENT/finalization-diagnostics"
run_checkpoint_dormant_fence_aba_tests "$CREATE_PARENT/dormant-fence-aba"
run_runner_source_evidence_tests
else
  initialize_durable_restore_fixture || exit 1
  CREATE_PARENT="$TMP_DIR/atomic-create"
  CREATE_FINAL="$DURABLE_RESTORE_CHECKPOINT"
  STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON"
  STUB_RUNNER_NAMESPACE=present
  export STUB_DEPLOYMENTS_JSON STUB_RUNNER_NAMESPACE
fi
if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" != checkpoint-tail-after-children ]]; then
run_checkpoint_backup_child_guard_tests
fi
CREATE_ORPHAN_RUNNER="$CREATE_PARENT/orphan-runner-checkpoint"
reset_stub
seed_recovery_operation_fence_binding_state dormant
expect_success 'checkpoint UID-deletes a dedicated-namespace orphan before backup and resumes only after the stable gate' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=checkpoint-orphan-runner \
  STUB_RUNNER_NAMESPACE=present RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_ORPHAN_RUNNER"
orphan_parent_zero_line="$(deployment_patch_first_line bot-orchestrator 0)"
orphan_delete_line="$(grep -n \
  "delete --raw=/api/v1/namespaces/hcce-bot-runners/pods/$RUNNER_FIXTURE_NAME" \
  "$KUBECTL_LOG" | head -1 | cut -d: -f1 || :)"
orphan_dump_line="$(grep -n 'pg_dump -U' "$KUBECTL_LOG" |
  head -1 | cut -d: -f1 || :)"
orphan_parent_resume_line="$(deployment_patch_first_line bot-orchestrator 1)"
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
seed_recovery_operation_fence_binding_state dormant
expect_failure 'checkpoint revalidates exact active Cloud control plane adjacent to parent resume' \
  'active runner control plane is not exact' \
  env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
  EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid \
  VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=checkpoint-active-control-plane-drift \
  RECOVERY_STREAM_POLL_SECONDS=0.01 \
  "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_CONTROL_PLANE_DRIFT"
control_plane_parent_resume_count="$(deployment_patch_count bot-orchestrator 1)"
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
if [[ -f "$CREATE_FINAL/SHA256SUMS" ]]; then
  published_manifest_sha="$(sha256_digest "$CREATE_FINAL/SHA256SUMS")"
  reset_stub
  expect_failure 'checkpoint creation refuses an existing final directory without overwrite' 'Refusing same-second or existing' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_FINAL"
  if [[ "$(sha256_digest "$CREATE_FINAL/SHA256SUMS")" == "$published_manifest_sha" ]]; then pass 'checkpoint collision preserves the existing published checkpoint'; else fail 'checkpoint collision preserves the existing published checkpoint' 'manifest changed'; fi
else
  fail 'checkpoint collision regressions execute' \
    'published checkpoint SHA256SUMS is unavailable'
fi
CREATE_FAILED="$CREATE_PARENT/failed-checkpoint"
reset_stub
seed_recovery_operation_fence_binding_state dormant
expect_failure 'checkpoint creation never publishes a partial directory on backup failure' 'Unexpected pods consume PVC' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=backup-extra-consumer "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_FAILED"
if [[ ! -e "$CREATE_FAILED" && ! -e "$CREATE_FAILED.yenhubs-publish-lock" ]] && ! find "$CREATE_PARENT" -maxdepth 1 -type d -name '.yenhubs-checkpoint-*' | grep -q .; then pass 'failed checkpoint staging is owned, private and removed'; else fail 'failed checkpoint staging is owned, private and removed' "$(find "$CREATE_PARENT" -maxdepth 1 -print)"; fi
CREATE_EMPTY_ACTIVE="$CREATE_PARENT/empty-active-checkpoint"
reset_stub
seed_recovery_operation_fence_binding_state dormant
expect_failure 'checkpoint creation rejects an empty active DB baseline before helper creation' 'Active owned-file DB baseline is empty or duplicated' env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid VALUES_FILE="$VALUES_FIXTURE" STUB_MODE=zero-db-active "$ROOT_DIR/deployment/create-checkpoint.sh" "$CREATE_EMPTY_ACTIVE"
if [[ "$(grep -c 'create -f -$' "$KUBECTL_LOG")" == "1" ]]; then pass 'empty active DB baseline creates only the operation lock'; else fail 'empty active DB baseline creates only the operation lock' "$(cat "$KUBECTL_LOG")"; fi
CREATE_DUPLICATE_ACTIVE="$CREATE_PARENT/duplicate-active-checkpoint"
reset_stub
seed_recovery_operation_fence_binding_state dormant
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
# backup-ret-storage.sh is a fail-closed compatibility stub: the no-I/O test
# above proves that it exits before any signal-sensitive operation.
for recovery_script in \
  "$ROOT_DIR/deployment/backup-retdb.sh" \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$ROOT_DIR/deployment/restore-retdb.sh" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" \
  "$ROOT_DIR/deployment/validate-checkpoint.sh"; do
  if ! grep -Eq "trap .*INT" "$recovery_script"; then missing_signal_trap="$recovery_script"; fi
done
if [[ -n "$missing_signal_trap" ]]; then fail 'recovery scripts install INT traps' "$missing_signal_trap"; else pass 'recovery scripts install INT traps'; fi

if grep -En \
  'recovery_kubectl(_mutate)?[[:space:]]+scale|kubectl[[:space:]]+scale|--raw=[^[:space:]]*/scale([?[:space:]]|$)' \
  "$ROOT_DIR/deployment/create-checkpoint.sh" \
  "$ROOT_DIR/deployment/restore-checkpoint.sh" \
  "$ROOT_DIR/deployment/lib/recovery-safety.sh" >/dev/null; then
  fail 'checkpoint and restore never use kubectl scale or the deployments/scale API' \
    'forbidden scale command or subresource remains in recovery source'
else
  pass 'checkpoint and restore never use kubectl scale or the deployments/scale API'
fi

# Focus branches above are early-exit shortcuts. The default/full route must
# still execute every focused-only safety battery exactly once.
run_reactivation_preflight_tests
run_checkpoint_writer_monitor_tests
run_storage_helper_contract_tests
run_stream_guard_timing_contract_tests
run_multi_guard_stream_regression_tests
run_stream_guard_abort_tests
run_stream_capability_authority_tamper_tests
run_watchdog_identity_tests

if [[ "$FAIL_COUNT" -ne 0 ]]; then
  printf '%s recovery safety test(s) failed; %s passed.\n' "$FAIL_COUNT" "$PASS_COUNT" >&2
  exit 1
fi
printf 'All %s recovery safety tests passed using local fixtures only.\n' "$PASS_COUNT"

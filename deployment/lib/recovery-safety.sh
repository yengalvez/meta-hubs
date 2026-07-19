#!/usr/bin/env bash

# Shared fail-closed guards for backup and restore commands. Callers must set
# NAMESPACE before invoking recovery_require_cluster_identity.

RECOVERY_SAFETY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# These paths are process-local capabilities. Never honor inherited values:
# cleanup may remove only a directory created and marked by this shell.
RECOVERY_MATERIALIZED_DIR=""
RECOVERY_MATERIALIZED_PARENT=""
RECOVERY_MATERIALIZED_MARKER=""
RECOVERY_MATERIALIZED_OWNED=0
RECOVERY_DUMP_COPY=""
RECOVERY_STORAGE_COPY=""
RECOVERY_DATABASE_CONTRACT_COPY=""
RECOVERY_DEPLOYMENT_INVENTORY_COPY=""
RECOVERY_CHECKPOINT_STAMP=""
RECOVERY_DUMP_SHA256=""
RECOVERY_STORAGE_SHA256=""
RECOVERY_DEPLOYMENT_INVENTORY_SHA256=""
RECOVERY_CHECKPOINT_NAMESPACE_UID=""
RECOVERY_CHECKPOINT_PVC_UID=""
RECOVERY_FENCE_PRE_EPOCH="${RECOVERY_FENCE_PRE_EPOCH:-}"
RECOVERY_FENCE_TARGET_EPOCH="${RECOVERY_FENCE_TARGET_EPOCH:-}"
RECOVERY_OPERATION_STATE="${RECOVERY_OPERATION_STATE:-}"
RECOVERY_OPERATION_BINDING_SHA256="${RECOVERY_OPERATION_BINDING_SHA256:-}"
# A caller may enable this process-local capability only after sourcing the
# library and after durably persisting the AUD-065 token/operation ID. Never
# honor an inherited environment marker.
RECOVERY_OPERATION_IDENTITY_PREBOUND=0
RECOVERY_OPERATION_LOCK_GLOBAL_NAME="yenhubs-recovery-operation-lock"
RECOVERY_SERIALIZATION_LEASE_NAME="yenhubs-operation-serialization"
# Lease ownership and heartbeat paths/PIDs are process-local capabilities.
# Never honor inherited values: an environment value must not let cleanup
# signal a foreign PID or overwrite/remove an arbitrary path.
RECOVERY_SERIALIZATION_LEASE_HOLDER=""
RECOVERY_SERIALIZATION_LEASE_UID=""
RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
RECOVERY_SERIALIZATION_HEARTBEAT_PID=""
RECOVERY_SERIALIZATION_HEARTBEAT_STOP=""
RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE=""
RECOVERY_SERIALIZATION_PARENT_PID=""
RECOVERY_SERIALIZATION_PARENT_START_IDENTITY=""
RECOVERY_SERIALIZATION_ADOPTED=0
RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID=""
RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY=""
RECOVERY_NAMESPACE_UID=""
RECOVERY_PVC_UID=""
# Coordinated child processes receive the exact lock resourceVersion from the
# parent. Unlike materialized-file capabilities above, this value is not used
# for local cleanup and must survive sourcing in the child so the full lock
# identity can be revalidated against the API object.
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}"

recovery_kubectl() {
  command kubectl --context "$EXPECTED_KUBE_CONTEXT" --request-timeout=45s "$@"
}

recovery_process_start_identity() {
  local pid="$1" identity
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2
  identity="$(command ps -o lstart= -p "$pid" 2>/dev/null)" || return 1
  identity="$(awk '{$1=$1; print}' <<<"$identity")"
  [[ -n "$identity" ]] || return 1
  printf '%s\n' "$identity"
}

recovery_process_identity_is_live() {
  local pid="$1" expected_start="$2" current_start
  [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$expected_start" ]] || return 2
  kill -0 "$pid" 2>/dev/null || return 1
  current_start="$(recovery_process_start_identity "$pid")" || return 1
  [[ "$current_start" == "$expected_start" ]]
}

recovery_stop_process_group() {
  local leader_pid="$1" group_created=0
  [[ "$leader_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  if kill -TERM -- "-$leader_pid" 2>/dev/null; then
    group_created=1
  else
    # Cover the very small fork-to-setsid race: if the Python launcher has not
    # established its session yet, killing the leader prevents kubectl exec.
    kill -TERM "$leader_pid" 2>/dev/null || :
  fi
  for _ in {1..20}; do
    if [[ "$group_created" == 1 ]]; then
      kill -0 -- "-$leader_pid" 2>/dev/null || break
    else
      kill -0 "$leader_pid" 2>/dev/null || break
    fi
    sleep 0.1
  done
  if [[ "$group_created" == 1 ]]; then
    # Always issue the group KILL after the grace period. On macOS the shell's
    # kill -0 check can stop observing the PGID once its leader exits even
    # while an orphaned descendant that ignored TERM is still in that group.
    kill -KILL -- "-$leader_pid" 2>/dev/null || :
  elif [[ "$group_created" == 0 ]] && kill -0 "$leader_pid" 2>/dev/null; then
    kill -KILL "$leader_pid" 2>/dev/null || :
  fi
  wait "$leader_pid" 2>/dev/null || :
}

recovery_kubectl_mutate() {
  local mutation_status=0
  recovery_require_operation_serialization || return 1
  if recovery_kubectl_stream_supervised 1 30 "$@"; then
    mutation_status=0
  else
    mutation_status=$?
  fi
  recovery_require_operation_serialization || return 1
  [[ "$mutation_status" == 0 ]] || return "$mutation_status"
}

recovery_kubectl_stream_supervised() {
  local require_lease="$1" maximum_seconds="$2"
  shift 2
  local poll_seconds="${RECOVERY_STREAM_POLL_SECONDS:-1}" caller_pid="$$"
  local caller_start_identity
  [[ "$require_lease" == 0 || "$require_lease" == 1 ]] || return 2
  [[ "$maximum_seconds" =~ ^[1-9][0-9]*$ &&
     "$poll_seconds" =~ ^(0\.[0-9]+|[1-9][0-9]*)$ && "$#" -gt 0 ]] || return 2
  caller_start_identity="$(recovery_process_start_identity "$caller_pid")" || return 1
  command -v python3 >/dev/null 2>&1 || return 127
  (
    local stream_pid="" stream_status=0 started="$SECONDS"
    supervised_stream_cleanup() {
      if [[ "$stream_pid" =~ ^[1-9][0-9]*$ ]]; then
        recovery_stop_process_group "$stream_pid"
      fi
    }
    trap 'supervised_stream_cleanup; exit 130' INT TERM
    recovery_process_identity_is_live "$caller_pid" "$caller_start_identity" || return 1
    if [[ "$require_lease" == 1 ]]; then
      recovery_require_operation_serialization || return 1
    fi
    # Python creates a new session and then execs kubectl. The resulting PID is
    # also the process-group leader, so a parent-death or Lease-loss watchdog
    # can terminate kubectl and every local descendant as one unit.
    command python3 -I -c '
import os
import sys
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
' kubectl --context "$EXPECTED_KUBE_CONTEXT" \
        --request-timeout="${maximum_seconds}s" "$@" <&0 &
    stream_pid=$!
    while kill -0 "$stream_pid" 2>/dev/null; do
      if ((SECONDS - started >= maximum_seconds)); then
        supervised_stream_cleanup
        return 1
      fi
      if ! recovery_process_identity_is_live "$caller_pid" "$caller_start_identity"; then
        supervised_stream_cleanup
        return 1
      fi
      if [[ "$require_lease" == 1 ]] &&
         ! recovery_require_operation_serialization; then
        supervised_stream_cleanup
        return 1
      fi
      sleep "$poll_seconds"
    done
    if wait "$stream_pid"; then stream_status=0; else stream_status=$?; fi
    stream_pid=""
    recovery_process_identity_is_live "$caller_pid" "$caller_start_identity" || return 1
    if [[ "$require_lease" == 1 ]]; then
      recovery_require_operation_serialization || return 1
    fi
    return "$stream_status"
  )
}

recovery_kubectl_stream() {
  recovery_kubectl_stream_supervised 0 "$@"
}

recovery_kubectl_stream_mutate() {
  recovery_kubectl_stream_supervised 1 "$@"
}

recovery_kubectl_stream_guarded() {
  recovery_kubectl_stream_supervised 1 "$@"
}

recovery_sha256_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path"
  else
    printf 'Neither shasum nor sha256sum is available.\n' >&2
    return 127
  fi
}

recovery_sha256_digest() {
  local output
  if ! output="$(recovery_sha256_file "$1")"; then
    return 1
  fi
  output="${output%%[[:space:]]*}"
  [[ "$output" =~ ^[a-fA-F0-9]{64}$ ]] || return 1
  printf '%s\n' "$output"
}

recovery_file_size_bytes() {
  local path="$1" size
  if size="$(stat -c '%s' -- "$path" 2>/dev/null)"; then
    :
  elif size="$(stat -f '%z' -- "$path" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$size"
}

recovery_checkpoint_snapshot_artifacts() {
  printf '%s\n' \
    checkpoint-metadata.json \
    configured-value-keys.txt \
    database-contract.json \
    deployment-images.json \
    digitalocean-cluster.json \
    digitalocean-load-balancers.json \
    digitalocean-volumes.json \
    git-state.txt \
    k8s-configmaps-redacted.json \
    k8s-hcce-structure.json
}

recovery_path_has_symlink_component() {
  local input_path="$1"
  local absolute_path current component
  local -a components
  if [[ "$input_path" == /* ]]; then
    absolute_path="$input_path"
  else
    absolute_path="$PWD/$input_path"
  fi
  IFS='/' read -r -a components <<<"$absolute_path"
  current=""
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != "." ]] || continue
    [[ "$component" != ".." ]] || return 0
    current="$current/$component"
    [[ ! -L "$current" ]] || return 0
  done
  return 1
}

recovery_require_regular_direct_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || return 1
  ! recovery_path_has_symlink_component "$path"
}

recovery_checkpoint_artifacts() {
  local stamp="$1"
  [[ "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ ]] || return 2
  recovery_checkpoint_snapshot_artifacts
  printf 'retdb-%s.sql.gz\nret-storage-%s.tar.gz\n' "$stamp" "$stamp"
}

recovery_checkpoint_stamp_from_artifact() {
  local name
  name="$(basename "$1")"
  if [[ "$name" =~ ^retdb-([0-9]{8}-[0-9]{6})\.sql\.gz$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^ret-storage-([0-9]{8}-[0-9]{6})\.tar\.gz$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

recovery_validate_checkpoint_layout() {
  local directory="$1"
  local stamp="$2"
  local expected_names actual_names artifact
  if [[ ! -d "$directory" || -L "$directory" ]] ||
     recovery_path_has_symlink_component "$directory"; then
    printf 'Checkpoint directory is missing, linked or not a directory.\n' >&2
    return 1
  fi
  if ! expected_names="$({ recovery_checkpoint_artifacts "$stamp"; printf 'SHA256SUMS\n'; } | LC_ALL=C sort)"; then
    printf 'Checkpoint stamp is invalid.\n' >&2
    return 1
  fi
  if ! actual_names="$(
    find "$directory" -mindepth 1 -maxdepth 1 -print |
      while IFS= read -r artifact; do basename "$artifact"; done |
      LC_ALL=C sort
  )"; then
    printf 'Could not enumerate checkpoint artifacts.\n' >&2
    return 1
  fi
  if [[ "$actual_names" != "$expected_names" ]]; then
    printf 'Checkpoint directory does not contain the exact allowlisted artifact set.\n' >&2
    return 1
  fi
  while IFS= read -r artifact; do
    if ! recovery_require_regular_direct_file "$directory/$artifact"; then
      printf 'Checkpoint artifact is missing, empty, linked or non-regular: %s.\n' "$artifact" >&2
      return 1
    fi
  done <<<"$expected_names"
}

recovery_validate_sha256_manifest() {
  local directory="$1"
  local stamp="$2"
  local manifest="$directory/SHA256SUMS"
  local expected_names manifest_names line expected_digest artifact actual_digest
  recovery_require_regular_direct_file "$manifest" || {
    printf 'A regular non-empty SHA256SUMS manifest is required.\n' >&2
    return 1
  }
  if ! expected_names="$(recovery_checkpoint_artifacts "$stamp" | LC_ALL=C sort)"; then
    printf 'Checkpoint stamp is invalid.\n' >&2
    return 1
  fi
  if ! manifest_names="$(awk '
    BEGIN { failed=0; count=0 }
    {
      if ($0 !~ /^[a-fA-F0-9]{64}  [A-Za-z0-9][A-Za-z0-9._-]*$/) {
        failed=1
        next
      }
      name=substr($0, 67)
      if (seen[name]++) {
        failed=1
        next
      }
      names[++count]=name
    }
    END {
      if (failed || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print names[item_index]
    }
  ' "$manifest")"; then
    printf 'SHA256SUMS is malformed or contains duplicate/prefixed names.\n' >&2
    return 1
  fi
  manifest_names="$(printf '%s\n' "$manifest_names" | LC_ALL=C sort)"
  if [[ "$manifest_names" != "$expected_names" ]]; then
    printf 'SHA256SUMS does not contain the exact checkpoint artifact set.\n' >&2
    return 1
  fi
  while IFS= read -r line; do
    expected_digest="${line:0:64}"
    artifact="${line:66}"
    if ! recovery_require_regular_direct_file "$directory/$artifact"; then
      printf 'SHA256SUMS references a missing, non-regular or linked artifact.\n' >&2
      return 1
    fi
    if ! actual_digest="$(recovery_sha256_digest "$directory/$artifact")"; then
      printf 'Could not hash checkpoint artifact %s.\n' "$artifact" >&2
      return 1
    fi
    if [[ "$actual_digest" != "$expected_digest" ]]; then
      printf 'SHA256SUMS verification failed for %s.\n' "$artifact" >&2
      return 1
    fi
  done <"$manifest"
}

recovery_checkpoint_metadata_is_acceptable() {
  local metadata_path="$1"
  local expected_stamp="$2"
  recovery_require_regular_direct_file "$metadata_path" || return 1
  jq -e --arg stamp "$expected_stamp" '
    type == "object" and
    (keys | sort) == [
      "created_at_epoch", "created_at_utc", "kube_context", "namespace",
      "namespace_uid", "operation_id", "provenance", "ret_pvc_uid",
      "schema_version", "stamp", "writer_quiescence"
    ] and
    .schema_version == 2 and .stamp == $stamp and
    .provenance == {
      generator:"yenhubs-local-coordinated-checkpoint-v2",
      external_import:false
    } and
    (.created_at_utc | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.created_at_epoch | type == "number" and floor == . and . > 0) and
    (.kube_context | type == "string" and length > 0) and
    (.namespace | type == "string" and length > 0) and
    (.namespace_uid | type == "string" and length > 0) and
    (.ret_pvc_uid | type == "string" and length > 0) and
    (.operation_id | type == "string" and test("^[a-f0-9]{32}$")) and
    (.writer_quiescence | keys | sort) ==
      ["completed_at_utc", "required", "started_at_utc"] and
    .writer_quiescence.required == true and
    (.writer_quiescence.started_at_utc | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.writer_quiescence.completed_at_utc | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    .writer_quiescence.completed_at_utc >= .writer_quiescence.started_at_utc
  ' "$metadata_path" >/dev/null
}

recovery_verify_checkpoint_directory() {
  local directory="$1"
  local stamp="$2"
  recovery_validate_checkpoint_layout "$directory" "$stamp" &&
    recovery_validate_sha256_manifest "$directory" "$stamp" &&
    recovery_checkpoint_metadata_is_acceptable \
      "$directory/checkpoint-metadata.json" "$stamp"
}

recovery_checkpoint_digest_for() {
  local directory="$1"
  local artifact="$2"
  awk -v artifact="$artifact" '
    BEGIN { found=0; digest="" }
    $0 ~ /^[a-fA-F0-9]{64}  [A-Za-z0-9][A-Za-z0-9._-]*$/ && substr($0, 67) == artifact {
      found++
      digest=substr($0, 1, 64)
    }
    END {
      if (found != 1) exit 2
      print digest
    }
  ' "$directory/SHA256SUMS"
}

recovery_database_contract_sql() {
  cat <<'SQL'
select jsonb_build_object(
  'schema_version', 2,
  'sql_dump_sha256', null,
  'provenance', jsonb_build_object(
    'baseline', 'yenhubs-reticulum-pre-sitting-2026-07',
    'compatible_with', jsonb_build_array('pre-sitting-2026-07', 'sitting-candidate-2026-07'),
    'minimum_relation_count', 356,
    'minimum_migration_count', 94,
    'minimum_hubs_count', 17
  ),
  'schemas', (
    select coalesce(jsonb_agg(nspname order by nspname), '[]'::jsonb)
    from pg_namespace where nspname in ('coturn', 'ret0', 'ret0_admin')
  ),
  'relations', (
    select coalesce(jsonb_agg(
      jsonb_build_object('schema', table_schema, 'name', table_name, 'type', table_type)
      order by table_schema, table_name
    ), '[]'::jsonb)
    from information_schema.tables
    where table_schema in ('coturn', 'ret0', 'ret0_admin')
  ),
  'migration_versions', (
    select coalesce(jsonb_agg(version::text order by version), '[]'::jsonb)
    from ret0.schema_migrations
  ),
  'critical_inventory', jsonb_build_object(
    'hub_sids', (
      select coalesce(jsonb_agg(hub_sid::text order by hub_sid), '[]'::jsonb)
      from ret0.hubs
    ),
    'owned_files', (
      select coalesce(jsonb_agg(
        jsonb_build_object('uuid', owned_file_uuid::text, 'state', state::text)
        order by owned_file_uuid
      ), '[]'::jsonb)
      from ret0.owned_files
    ),
    'active_owned_file_uuids', (
      select coalesce(jsonb_agg(owned_file_uuid::text order by owned_file_uuid), '[]'::jsonb)
      from ret0.owned_files where state::text = 'active'
    )
  ),
  'critical_counts', jsonb_build_object(
    'relations', (select count(*) from information_schema.tables where table_schema in ('coturn', 'ret0', 'ret0_admin')),
    'migrations', (select count(*) from ret0.schema_migrations),
    'hubs', (select count(*) from ret0.hubs),
    'owned_files', (select count(*) from ret0.owned_files),
    'active_owned_files', (select count(*) from ret0.owned_files where state::text = 'active')
  )
)::text;
SQL
}

recovery_database_contract_is_acceptable() {
  local contract_path="$1"
  # External checkpoint artifacts are checked with
  # recovery_require_regular_direct_file before this parser is reached. Live
  # snapshots can reside below macOS' canonical /private/var path while
  # mktemp reports the /var alias, so require a direct regular file here but do
  # not reject that operating-system path alias a second time.
  [[ -f "$contract_path" && ! -L "$contract_path" && -s "$contract_path" ]] || return 1
  jq -e '
    type == "object" and
    (keys | sort) == ["critical_counts", "critical_inventory", "migration_versions", "provenance", "relations", "schema_version", "schemas", "sql_dump_sha256"] and
    .schema_version == 2 and
    (.sql_dump_sha256 == null or
      (.sql_dump_sha256 | type == "string" and test("^[a-fA-F0-9]{64}$"))) and
    .provenance == {
      baseline: "yenhubs-reticulum-pre-sitting-2026-07",
      compatible_with: ["pre-sitting-2026-07", "sitting-candidate-2026-07"],
      minimum_relation_count: 356,
      minimum_migration_count: 94,
      minimum_hubs_count: 17
    } and
    .schemas == ["coturn", "ret0", "ret0_admin"] and
    (.relations | type == "array") and
    (.relations | length) == .critical_counts.relations and
    (.relations | length) >= .provenance.minimum_relation_count and
    all(.relations[];
      (keys | sort) == ["name", "schema", "type"] and
      (.schema == "coturn" or .schema == "ret0" or .schema == "ret0_admin") and
      (.name | type == "string" and test("^[A-Za-z_][A-Za-z0-9_]*$")) and
      (.type == "BASE TABLE" or .type == "VIEW" or .type == "FOREIGN")) and
    ([.relations[] | (.schema + "/" + .name)] | unique | length) == (.relations | length) and
    ([.relations[] | select(.schema == "ret0") | .name] | index("schema_migrations")) != null and
    ([.relations[] | select(.schema == "ret0") | .name] | index("hubs")) != null and
    ([.relations[] | select(.schema == "ret0") | .name] | index("owned_files")) != null and
    ([.relations[] | select(.schema == "ret0_admin")] | length) > 0 and
    ([.relations[] | select(.schema == "coturn")] | length) > 0 and
    (.migration_versions | type == "array") and
    all(.migration_versions[]; type == "string" and test("^[0-9]+$")) and
    (.migration_versions | unique | length) == (.migration_versions | length) and
    (.migration_versions | length) == .critical_counts.migrations and
    (.critical_inventory | keys | sort) == ["active_owned_file_uuids", "hub_sids", "owned_files"] and
    (.critical_inventory.hub_sids | type == "array") and
    all(.critical_inventory.hub_sids[];
      type == "string" and test("^[A-Za-z0-9._-]+$")) and
    (.critical_inventory.hub_sids | unique | length) == (.critical_inventory.hub_sids | length) and
    (.critical_inventory.hub_sids | length) == .critical_counts.hubs and
    (.critical_inventory.owned_files | type == "array") and
    all(.critical_inventory.owned_files[];
      (keys | sort) == ["state", "uuid"] and
      (.uuid | type == "string" and test("^[A-Za-z0-9._-]+$")) and
      (.state | type == "string" and test("^[A-Za-z0-9._-]+$"))) and
    ([.critical_inventory.owned_files[].uuid] | unique | length) ==
      (.critical_inventory.owned_files | length) and
    (.critical_inventory.owned_files | length) == .critical_counts.owned_files and
    (.critical_inventory.active_owned_file_uuids | type == "array") and
    all(.critical_inventory.active_owned_file_uuids[];
      type == "string" and test("^[A-Za-z0-9._-]+$")) and
    (.critical_inventory.active_owned_file_uuids | unique | length) ==
      (.critical_inventory.active_owned_file_uuids | length) and
    (.critical_inventory.active_owned_file_uuids | length) == .critical_counts.active_owned_files and
    ([.critical_inventory.owned_files[] | select(.state == "active") | .uuid] | sort) ==
      (.critical_inventory.active_owned_file_uuids | sort) and
    (.critical_counts | keys | sort) == ["active_owned_files", "hubs", "migrations", "owned_files", "relations"] and
    all(.critical_counts[]; type == "number" and floor == . and . >= 0) and
    .critical_counts.migrations >= .provenance.minimum_migration_count and
    .critical_counts.hubs >= .provenance.minimum_hubs_count and
    .critical_counts.owned_files > 0 and
    .critical_counts.active_owned_files > 0 and
    .critical_counts.active_owned_files <= .critical_counts.owned_files
  ' "$contract_path" >/dev/null
}

recovery_capture_live_database_contract() {
  local pgsql_pod="$1"
  local output_path="$2"
  local query
  query="$(recovery_database_contract_sql)" || return 1
  # Expansion is intentionally deferred to the PostgreSQL container.
  # shellcheck disable=SC2016
  if ! printf '%s\n' "$query" |
    recovery_kubectl exec -i -n "$NAMESPACE" "$pgsql_pod" -- sh -ec \
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -At' |
    jq -eS '.' >"$output_path"; then
    rm -f -- "$output_path"
    return 1
  fi
  chmod 600 "$output_path"
  recovery_database_contract_is_acceptable "$output_path"
}

recovery_database_contracts_match() {
  local expected_path="$1"
  local actual_path="$2"
  recovery_database_contract_is_acceptable "$expected_path" &&
    recovery_database_contract_is_acceptable "$actual_path" &&
    cmp -s <(jq -cS 'del(.sql_dump_sha256)' "$expected_path") \
      <(jq -cS 'del(.sql_dump_sha256)' "$actual_path")
}

# Bind every byte of the canonical plain SQL stream to the checksummed sidecar.
# Live contracts deliberately carry null because no dump exists yet; checkpoint
# contracts carry the exact SHA-256 of the decompressed pg_dump output. This
# makes any DDL, COPY block, data row, function, index, constraint or type drift
# fail offline validation, including objects outside the critical inventory.
recovery_bind_database_contract_to_dump() {
  local input_contract="$1"
  local sql_path="$2"
  local output_contract="$3"
  local sql_digest
  recovery_database_contract_is_acceptable "$input_contract" || return 1
  [[ -f "$sql_path" && ! -L "$sql_path" && -s "$sql_path" ]] || return 1
  sql_digest="$(recovery_sha256_digest "$sql_path")" || return 1
  if ! jq -eS --arg digest "$sql_digest" \
    '.sql_dump_sha256 = $digest' "$input_contract" >"$output_contract"; then
    rm -f -- "$output_contract"
    return 1
  fi
  chmod 600 "$output_contract"
  recovery_database_contract_is_acceptable "$output_contract"
}

recovery_deployment_inventory_is_acceptable() {
  local inventory_path="$1"
  local expected_namespace="$2"
  local expected_namespace_uid="$3"
  local expected_images_json="${4:-}"
  local expected_runner_image="${5:-}"
  jq -e \
    --arg namespace "$expected_namespace" \
    --arg namespace_uid "$expected_namespace_uid" \
    --arg expected_runner "$expected_runner_image" \
    --argjson expected_images "${expected_images_json:-null}" '
    def expected_deployments:
      ["bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
       "pgbouncer", "pgbouncer-t", "photomnemonic", "pgsql", "reticulum", "spoke"];
    def expected_pairs:
      ["bot-orchestrator/bot-orchestrator", "coturn/coturn", "dialog/dialog",
       "haproxy/haproxy", "hubs/hubs", "nearspark/nearspark", "pgbouncer/pgbouncer",
       "pgbouncer-t/pgbouncer-t", "photomnemonic/photomnemonic"] +
      (if .bot_runner_runtime.mode == "process-local"
       then ["pgsql/postgresql"]
       elif .bot_runner_runtime.mode == "kubernetes-pod"
       then ["pgsql/pgsql"]
       else [] end) +
      ["reticulum/postgrest", "reticulum/reticulum", "spoke/spoke"];
    def trusted_repository($pair; $image):
      ($image | split("@sha256:")[0]) as $repository |
      if $pair == "bot-orchestrator/bot-orchestrator" then $repository == "ghcr.io/yengalvez/bot-orchestrator"
      elif $pair == "coturn/coturn" then $repository == "ghcr.io/yengalvez/coturn"
      elif $pair == "dialog/dialog" then $repository == "ghcr.io/yengalvez/dialog"
      elif $pair == "haproxy/haproxy" then
        ($repository == "ghcr.io/yengalvez/haproxy" or
         $repository == "docker.io/haproxytech/kubernetes-ingress" or
         $repository == "haproxytech/kubernetes-ingress")
      elif $pair == "hubs/hubs" then $repository == "ghcr.io/yengalvez/hubs"
      elif $pair == "nearspark/nearspark" then
        ($repository == "ghcr.io/yengalvez/nearspark" or
         $repository == "docker.io/mozillareality/nearspark" or
         $repository == "mozillareality/nearspark")
      elif ($pair == "pgbouncer/pgbouncer" or $pair == "pgbouncer-t/pgbouncer-t") then
        ($repository == "ghcr.io/yengalvez/pgbouncer" or
         $repository == "docker.io/edoburu/pgbouncer" or
         $repository == "edoburu/pgbouncer")
      elif $pair == "photomnemonic/photomnemonic" then $repository == "ghcr.io/yengalvez/photomnemonic"
      elif ($pair == "pgsql/pgsql" or $pair == "pgsql/postgresql") then
        ($repository == "ghcr.io/yengalvez/postgres" or
         $repository == "docker.io/library/postgres" or $repository == "postgres")
      elif $pair == "reticulum/postgrest" then
        ($repository == "ghcr.io/yengalvez/postgrest" or
         $repository == "docker.io/postgrest/postgrest" or
         $repository == "postgrest/postgrest")
      elif $pair == "reticulum/reticulum" then $repository == "ghcr.io/yengalvez/reticulum"
      elif $pair == "spoke/spoke" then $repository == "ghcr.io/yengalvez/spoke"
      else false end;
    (keys | sort) ==
      ["bot_runner_runtime", "deployments", "namespace", "namespace_uid", "schema_version"] and
    .schema_version == 3 and
    .namespace == $namespace and
    .namespace_uid == $namespace_uid and
    (.bot_runner_runtime | type == "object" and
      (keys | sort) == ["control_plane", "image", "mode", "recovery_epoch"]) and
    ((.bot_runner_runtime.recovery_epoch == {state:"legacy-absent"}) or
      (.bot_runner_runtime.recovery_epoch | type == "object" and
       (keys | sort) == ["state", "value"] and .state == "bound" and
       (.value | type == "string" and
        test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")))) and
    ((.bot_runner_runtime.mode == "process-local" and
       .bot_runner_runtime.image == null and
       .bot_runner_runtime.recovery_epoch == {state:"legacy-absent"} and
       .bot_runner_runtime.control_plane == {state:"legacy-absent"}) or
      (.bot_runner_runtime.mode == "kubernetes-pod" and
       .bot_runner_runtime.recovery_epoch.state == "bound" and
       (.bot_runner_runtime.image | type == "string" and
        test("^ghcr\\.io/yengalvez/bot-runner@sha256:[a-fA-F0-9]{64}$")) and
       (.bot_runner_runtime.control_plane | type == "object" and
        (keys | sort) == [
          "cluster_resources", "namespaced_resources", "namespaces", "state"
        ] and .state == "kubernetes-active" and
        (.namespaces | type == "array" and length == 2) and
        ([.namespaces[].name] | sort) == ([$namespace, "hcce-bot-runners"] | sort) and
        ([.namespaces[].name] | unique | length) == 2 and
        all(.namespaces[];
          (keys | sort) == ["api_version", "kind", "name", "uid"] and
          .api_version == "v1" and .kind == "Namespace" and
          (.uid | type == "string" and length > 0)) and
        ([.namespaces[] | select(.name == $namespace) | .uid] == [$namespace_uid]) and
        (.namespaced_resources | type == "array" and length == 7) and
        ([.namespaced_resources[] |
          [.api_version, .kind, .namespace, .name]] | sort) == ([
            ["v1", "Secret", "hcce-bot-runners", "bot-images-pull"],
            ["v1", "ServiceAccount", "hcce-bot-runners", "bot-runner"],
            ["v1", "ResourceQuota", "hcce-bot-runners", "bot-runner-capacity"],
            ["rbac.authorization.k8s.io/v1", "Role", "hcce-bot-runners", "bot-orchestrator-runner-pods"],
            ["rbac.authorization.k8s.io/v1", "RoleBinding", "hcce-bot-runners", "bot-orchestrator-runner-pods"],
            ["networking.k8s.io/v1", "NetworkPolicy", "hcce-bot-runners", "bot-runner-default-deny"],
            ["networking.k8s.io/v1", "NetworkPolicy", "hcce-bot-runners", "bot-runner-egress"]
          ] | sort) and
        all(.namespaced_resources[];
          (keys | sort) == ["api_version", "kind", "name", "namespace", "uid"] and
          (.uid | type == "string" and length > 0)) and
        (.cluster_resources | type == "array" and length == 2) and
        ([.cluster_resources[] | [.api_version, .kind, .name]] | sort) == ([
          ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "bot-runner-pods.yenhubs.org"],
          ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "bot-runner-pods.yenhubs.org"]
        ] | sort) and
        all(.cluster_resources[];
          (keys | sort) == ["api_version", "kind", "name", "uid"] and
          (.uid | type == "string" and length > 0))))) and
    ($expected_runner == "" or
      .bot_runner_runtime.mode == "process-local" or
      .bot_runner_runtime.image == $expected_runner) and
    (.deployments | type == "array") and
    ([.deployments[].name] | sort) == (expected_deployments | sort) and
    ([.deployments[].name] | unique | length) == (.deployments | length) and
    ([.deployments[] | select(.name == "bot-orchestrator") | .replicas] == [1]) and
    all(.deployments[];
      (.uid | type == "string" and length > 0) and
      (.replicas | type == "number" and floor == . and . >= 0) and
      (.init_containers | type == "array" and length == 0) and
      (.containers | type == "array" and length > 0) and
      ([.containers[].name] | unique | length) == (.containers | length) and
      all(.containers[];
        (.name | type == "string" and length > 0) and
        (.image | type == "string" and test("@sha256:[a-fA-F0-9]{64}$")))) and
    ([.deployments[] as $deployment
      | $deployment.containers[]
      | ($deployment.name + "/" + .name)] | sort) == (expected_pairs | sort) and
    ([.deployments[] as $deployment | $deployment.containers[] |
      trusted_repository(($deployment.name + "/" + .name); .image)] | all) and
    ($expected_images == null or (
      ($expected_images | type == "object") and
      (($expected_images | keys | sort) == (expected_pairs | sort)) and
      ([.deployments[] as $deployment
        | $deployment.containers[]
        | .image == $expected_images[$deployment.name + "/" + .name]] | all)))
  ' "$inventory_path" >/dev/null
}

recovery_checkpoint_deployment_inventory_is_acceptable() {
  local inventory_path="$1" expected_namespace="$2" origin_namespace_uid
  origin_namespace_uid="$(jq -er \
    '.namespace_uid | select(type == "string" and length > 0)' \
    "$inventory_path")" || return 1
  recovery_deployment_inventory_is_acceptable \
    "$inventory_path" "$expected_namespace" "$origin_namespace_uid"
}

recovery_inventory_core_images_match() {
  local inventory_path="$1"
  local hubs_image="$2"
  local reticulum_image="$3"
  local bot_image="$4"
  jq -e --arg hubs "$hubs_image" --arg reticulum "$reticulum_image" --arg bot "$bot_image" '
    ([.deployments[] | select(.name == "hubs") | .containers[] | select(.name == "hubs") | .image] == [$hubs]) and
    ([.deployments[] | select(.name == "reticulum") | .containers[] | select(.name == "reticulum") | .image] == [$reticulum]) and
    ([.deployments[] | select(.name == "bot-orchestrator") | .containers[] | select(.name == "bot-orchestrator") | .image] == [$bot])
  ' "$inventory_path" >/dev/null
}

recovery_private_values_file_is_acceptable() {
  local values_path="$1" mode owner
  recovery_require_regular_direct_file "$values_path" || return 1
  if mode="$(stat -f '%Lp' "$values_path" 2>/dev/null)"; then
    owner="$(stat -f '%u' "$values_path" 2>/dev/null)" || return 1
  elif mode="$(stat -c '%a' "$values_path" 2>/dev/null)"; then
    owner="$(stat -c '%u' "$values_path" 2>/dev/null)" || return 1
  else
    return 1
  fi
  [[ "$mode" == 600 || "$mode" == 0600 ]] || return 1
  [[ "$owner" == "$(id -u)" ]]
}

recovery_runner_epoch_from_values() {
  local values_path="$1" epoch parser_path="$RECOVERY_SAFETY_DIR/../parse-local-values.mjs"
  recovery_private_values_file_is_acceptable "$values_path" || return 1
  epoch="$(command node "$parser_path" "$values_path" \
    --get BOT_RUNNER_RECOVERY_EPOCH)" || return 1
  [[ "$epoch" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || return 1
  printf '%s\n' "$epoch"
}

recovery_live_runner_epoch() {
  local deployment deployment_json epoch expected_epoch="" first=1
  for deployment in reticulum bot-orchestrator; do
    deployment_json="$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o json
    )" || return 1
    epoch="$(printf '%s' "$deployment_json" | jq -er \
      --arg deployment "$deployment" --arg namespace "$NAMESPACE" '
      select(.apiVersion == "apps/v1" and .kind == "Deployment" and
        .metadata.name == $deployment and .metadata.namespace == $namespace) |
      ((.spec.template.metadata.annotations // {})[
        "yenhubs.org/bot-runner-recovery-epoch"
      ] // "") | select(type == "string")
    ')" || return 1
    [[ -z "$epoch" ||
       "$epoch" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || return 1
    if [[ "$first" == 1 ]]; then
      expected_epoch="$epoch"
      first=0
    elif [[ "$epoch" != "$expected_epoch" ]]; then
      return 1
    fi
  done
  printf '%s\n' "$expected_epoch"
}

recovery_require_restore_epoch_candidate() {
  local inventory_path="$1" values_path="$2"
  local checkpoint_state checkpoint_epoch candidate_epoch live_epoch
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  checkpoint_state="$(jq -er '.bot_runner_runtime.recovery_epoch.state' \
    "$inventory_path")" || return 1
  checkpoint_epoch="$(jq -r '.bot_runner_runtime.recovery_epoch.value // ""' \
    "$inventory_path")" || return 1
  if ! candidate_epoch="$(
    recovery_runner_epoch_from_values "$values_path"
  )"; then
    printf 'A direct owner-only VALUES_FILE with one canonical recovery epoch is required.\n' >&2
    return 1
  fi
  if ! live_epoch="$(recovery_live_runner_epoch)"; then
    printf 'Could not verify the live Reticulum/parent recovery-epoch binding.\n' >&2
    return 1
  fi
  if [[ "$checkpoint_state" == bound && "$candidate_epoch" == "$checkpoint_epoch" ]]; then
    printf 'Restore is blocked until BOT_RUNNER_RECOVERY_EPOCH is rotated through the standard generated-manifest flow.\n' >&2
    return 1
  fi
  if [[ -n "$live_epoch" && "$candidate_epoch" == "$live_epoch" ]]; then
    printf 'The restore-fence epoch candidate must differ from the currently live issuing epoch.\n' >&2
    return 1
  fi
}

recovery_require_live_restore_fence_epoch() {
  local values_path="$1" pre_fence_epoch="$2" candidate_epoch live_epoch
  candidate_epoch="$(recovery_runner_epoch_from_values "$values_path")" || return 1
  live_epoch="$(recovery_live_runner_epoch)" || return 1
  [[ -n "$live_epoch" && "$live_epoch" == "$candidate_epoch" &&
     "$live_epoch" != "$pre_fence_epoch" ]] || {
    printf 'The live restore-fence epoch is not the exact new candidate.\n' >&2
    return 1
  }
}

recovery_require_live_runner_recovery_phase() {
  local expected_phase="$1" deployment deployment_json
  [[ "$expected_phase" == active || "$expected_phase" == restore-fence ]] || return 2
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn pgsql; do
    deployment_json="$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o json
    )" || return 1
    jq -e --arg namespace "$NAMESPACE" --arg name "$deployment" \
      --arg phase "$expected_phase" '
      .apiVersion == "apps/v1" and .kind == "Deployment" and
      .metadata.namespace == $namespace and .metadata.name == $name and
      ((.metadata.annotations // {})[
        "yenhubs.org/bot-runner-recovery-phase"
      ] == $phase)
    ' >/dev/null <<<"$deployment_json" || {
      printf 'Deployment/%s is not bound to recovery phase %s.\n' \
        "$deployment" "$expected_phase" >&2
      return 1
    }
  done
}

recovery_require_live_runner_active_control_plane_exact() {
  local values_path="$1" output
  local verifier="$RECOVERY_SAFETY_DIR/../../hubs-cloud/community-edition/apply/verify-live-runner-control-plane.js"
  local manifest_verifier="$RECOVERY_SAFETY_DIR/../../hubs-cloud/community-edition/generate_script/verify-generated-manifest.js"
  local manifest_path="${HCCE_MANIFEST_PATH:-$RECOVERY_SAFETY_DIR/../../hubs-cloud/community-edition/hcce.yaml}"

  if [[ -n "${YENHUBS_RECOVERY_RUNNER_CONTROL_PLANE_VERIFIER:-}" ]]; then
    recovery_require_local_fixture_attestation || {
      printf 'A runner control-plane verifier override is allowed only in the isolated fixture context.\n' >&2
      return 1
    }
    verifier="$YENHUBS_RECOVERY_RUNNER_CONTROL_PLANE_VERIFIER"
  fi
  if [[ -n "${YENHUBS_RECOVERY_GENERATED_MANIFEST_VERIFIER:-}" ]]; then
    recovery_require_local_fixture_attestation || {
      printf 'A generated-manifest verifier override is allowed only in the isolated fixture context.\n' >&2
      return 1
    }
    manifest_verifier="$YENHUBS_RECOVERY_GENERATED_MANIFEST_VERIFIER"
  fi
  recovery_private_values_file_is_acceptable "$values_path" || {
    printf 'The active runner control-plane gate requires one direct owner-only VALUES_FILE.\n' >&2
    return 1
  }
  recovery_require_regular_direct_file "$verifier" || {
    printf 'The exact Cloud runner control-plane verifier is unavailable or unsafe.\n' >&2
    return 1
  }
  recovery_require_regular_direct_file "$manifest_verifier" || {
    printf 'The exact generated Cloud manifest verifier is unavailable or unsafe.\n' >&2
    return 1
  }
  recovery_require_regular_direct_file "$manifest_path" || {
    printf 'The tracked generated Cloud manifest is unavailable or unsafe.\n' >&2
    return 1
  }
  [[ -n "${EXPECTED_KUBE_CONTEXT:-}" &&
     "$EXPECTED_KUBE_CONTEXT" == "${EXPECTED_KUBE_CONTEXT//[[:space:]]/}" ]] || return 1

  # The Cloud verifier compares every live control-plane object with the
  # generated manifest, including the ValidatingAdmissionPolicy/binding and
  # the four exact effective-RBAC SelfSubjectRulesReviews. Requiring the six
  # consumer annotations to be active makes an inert restore-fence manifest
  # ineligible even if that fenced control plane is otherwise internally exact.
  recovery_require_live_runner_recovery_phase active || return 1
  if ! HCCE_INPUT_VALUES_PATH="$values_path" \
    HCCE_MANIFEST_PATH="$manifest_path" \
      command node "$manifest_verifier" >/dev/null; then
    printf 'The generated Cloud manifest is invalid or does not match its active input values.\n' >&2
    return 1
  fi
  if ! output="$({
    HCCE_INPUT_VALUES_PATH="$values_path" \
    HCCE_MANIFEST_PATH="$manifest_path" \
    KUBECTL_CONTEXT="$EXPECTED_KUBE_CONTEXT" \
      command node "$verifier"
  })"; then
    printf 'The active runner control plane is not exact; refusing parent authority.\n' >&2
    return 1
  fi
  [[ "$output" == runner_live_control_plane_verified ]] || {
    printf 'The active runner control-plane verifier returned an unexpected result.\n' >&2
    return 1
  }
}

# Checkpoint creation must work both before and after the isolated runner
# rollout without ever treating a partial rollout as the legacy runtime.  The
# legacy branch authorizes only capture/resume of the exact process-local
# security boundary that is already live; it is not a deployment gate.
recovery_runner_isolation_residual_state() {
  local deployment deployment_json annotation_present
  local resource name resource_namespace resource_json residual=0
  for deployment in \
    reticulum pgbouncer pgbouncer-t bot-orchestrator coturn pgsql; do
    deployment_json="$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o json
    )" || return 1
    annotation_present="$(jq -r --arg namespace "$NAMESPACE" \
      --arg deployment "$deployment" '
      if .apiVersion == "apps/v1" and .kind == "Deployment" and
         .metadata.namespace == $namespace and .metadata.name == $deployment
      then
        [((.metadata.annotations // {}) | keys),
         ((.spec.template.metadata.annotations // {}) | keys)] |
        flatten |
        any(. == "yenhubs.org/bot-runner-recovery-epoch" or
            . == "yenhubs.org/bot-runner-recovery-phase" or
            . == "yenhubs.org/runner-activation-phase")
      else
        "invalid"
      end
    ' <<<"$deployment_json")" || return 1
    case "$annotation_present" in
      false) ;;
      true) residual=1 ;;
      *) return 1 ;;
    esac
  done
  while IFS=$'\t' read -r resource name resource_namespace; do
    if [[ "$resource_namespace" == cluster ]]; then
      resource_json="$(
        recovery_kubectl get "$resource" "$name" --ignore-not-found -o json
      )" || return 1
    else
      resource_json="$(
        recovery_kubectl get "$resource" "$name" -n "$resource_namespace" \
          --ignore-not-found -o json
      )" || return 1
    fi
    [[ -z "$resource_json" ]] || residual=1
  done <<EOF
namespace	hcce-bot-runners	cluster
serviceaccount	bot-orchestrator	$NAMESPACE
secret	bot-images-pull	$NAMESPACE
role	bot-orchestrator-runner-pods	$NAMESPACE
rolebinding	bot-orchestrator-runner-pods	$NAMESPACE
validatingadmissionpolicy	bot-runner-pods.yenhubs.org	cluster
validatingadmissionpolicybinding	bot-runner-pods.yenhubs.org	cluster
EOF
  if [[ "$residual" == 0 ]]; then
    printf 'absent\n'
  else
    printf 'present\n'
  fi
}

recovery_require_live_process_local_runner_exact() {
  local values_path="$1" expected_image parent_json reticulum_json pgsql_json
  local ret_config_json configs_json residual_state
  local parser_path="$RECOVERY_SAFETY_DIR/../parse-local-values.mjs"

  recovery_private_values_file_is_acceptable "$values_path" || {
    printf 'The process-local checkpoint gate requires one direct owner-only VALUES_FILE.\n' >&2
    return 1
  }
  expected_image="$(command node "$parser_path" "$values_path" \
    --get OVERRIDE_BOT_ORCHESTRATOR_IMAGE)" || return 1
  [[ "$expected_image" =~ ^ghcr\.io/yengalvez/bot-orchestrator@sha256:[a-fA-F0-9]{64}$ ]] || {
    printf 'The process-local bot-orchestrator image is not an exact trusted digest.\n' >&2
    return 1
  }
  parent_json="$(
    recovery_kubectl get deployment bot-orchestrator -n "$NAMESPACE" -o json
  )" || return 1
  reticulum_json="$(
    recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o json
  )" || return 1
  pgsql_json="$(
    recovery_kubectl get deployment pgsql -n "$NAMESPACE" -o json
  )" || return 1
  ret_config_json="$(
    recovery_kubectl get configmap ret-config -n "$NAMESPACE" -o json
  )" || return 1
  configs_json="$(
    recovery_kubectl get secret configs -n "$NAMESPACE" -o json
  )" || return 1

  jq -e --arg namespace "$NAMESPACE" --arg image "$expected_image" '
    def one_env($name):
      [(.spec.template.spec.containers[0].env // [])[] | select(.name == $name)];
    def literal_env($name; $value):
      (one_env($name) | length == 1) and
      (one_env($name)[0] == {name:$name,value:$value});
    def forbidden_runner_binding:
      [(.spec.template.spec.containers[0].env // [])[] | .name] |
      any(. == "BOT_RUNNER_ACCESS_KEY" or
          . == "BOT_ORCHESTRATOR_ACCESS_KEY" or
          . == "DASHBOARD_ACCESS_KEY" or
          . == "BOT_RUNNER_IMAGE" or . == "BOT_RUNNER_RECOVERY_EPOCH" or
          . == "POD_NAMESPACE" or . == "ORCHESTRATOR_POD_NAME" or
          . == "ORCHESTRATOR_POD_UID" or . == "RUNNER_NAMESPACE" or
          . == "RUNNER_POD_NAMESPACE" or . == "RUNNER_CONTROL_URL");
    def has_runner_annotation:
      [((.metadata.annotations // {}) | keys),
       ((.spec.template.metadata.annotations // {}) | keys)] |
      flatten |
      any(. == "yenhubs.org/bot-runner-recovery-epoch" or
          . == "yenhubs.org/bot-runner-recovery-phase" or
          . == "yenhubs.org/runner-activation-phase" or
          . == "yenhubs.org/bot-orchestrator-access-key-checksum");
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "bot-orchestrator" and .metadata.namespace == $namespace and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    .spec.strategy.type == "Recreate" and
    .spec.selector == {matchLabels:{app:"bot-orchestrator"}} and
    .spec.template.metadata.labels.app == "bot-orchestrator" and
    .spec.template.spec.automountServiceAccountToken == false and
    ((.spec.template.spec.serviceAccountName // "default") == "default") and
    ((.spec.template.spec.imagePullSecrets // []) == []) and
    ((.spec.template.spec.initContainers // []) == []) and
    ((.spec.template.spec.ephemeralContainers // []) == []) and
    ((.spec.template.spec.hostNetwork // false) == false) and
    ((.spec.template.spec.hostPID // false) == false) and
    ((.spec.template.spec.hostIPC // false) == false) and
    ((.spec.template.spec.shareProcessNamespace // false) == false) and
    (.spec.template.spec.containers | length == 1) and
    .spec.template.spec.containers[0].name == "bot-orchestrator" and
    .spec.template.spec.containers[0].image == $image and
    ((.spec.template.spec.containers[0].command // []) == []) and
    ((.spec.template.spec.containers[0].args // []) == []) and
    ((.spec.template.spec.containers[0].envFrom // []) == []) and
    (.spec.template.spec.containers[0].lifecycle // null) == null and
    .spec.template.spec.containers[0].securityContext == {
      runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,
      allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,
      capabilities:{drop:["ALL"]},seccompProfile:{type:"RuntimeDefault"}
    } and
    (.spec.template.spec.containers[0].volumeMounts | length == 1) and
    .spec.template.spec.containers[0].volumeMounts[0].name == "bot-orchestrator-tmp" and
    .spec.template.spec.containers[0].volumeMounts[0].mountPath == "/tmp" and
    ((.spec.template.spec.containers[0].volumeMounts[0].subPath // "") == "") and
    (.spec.template.spec.volumes | length == 1) and
    .spec.template.spec.volumes[0] == {
      name:"bot-orchestrator-tmp",emptyDir:{sizeLimit:"256Mi"}
    } and
    (one_env("BOT_ACCESS_KEY") | length == 1) and
    (one_env("BOT_ACCESS_KEY")[0].name == "BOT_ACCESS_KEY") and
    (one_env("BOT_ACCESS_KEY")[0].valueFrom.secretKeyRef.name == "configs") and
    (one_env("BOT_ACCESS_KEY")[0].valueFrom.secretKeyRef.key == "BOT_ACCESS_KEY") and
    ((one_env("BOT_ACCESS_KEY")[0].valueFrom.secretKeyRef.optional // false) == false) and
    literal_env("RUNNER_AUTOSTART"; "true") and
    literal_env("RUNNER_BACKEND"; "ghost") and
    literal_env("GHOST_RUNNER_SCRIPT"; "/app/run-ghost-runner.js") and
    (forbidden_runner_binding | not) and (has_runner_annotation | not)
  ' >/dev/null <<<"$parent_json" || {
    printf 'The live process-local bot runtime does not match its exact checkpoint contract.\n' >&2
    return 1
  }
  jq -e --arg namespace "$NAMESPACE" '
    def candidate_env:
      [.spec.template.spec.containers[] |
        select(.name == "reticulum") | (.env // [])[] | .name] |
      any(. == "turkeyCfg_BOT_RUNNER_ACCESS_KEY" or
          . == "turkeyCfg_BOT_ORCHESTRATOR_ACCESS_KEY" or
          . == "turkeyCfg_DASHBOARD_ACCESS_KEY" or
          . == "turkeyCfg_BOT_RUNNER_RECOVERY_EPOCH");
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "reticulum" and .metadata.namespace == $namespace and
    (.spec.template.spec.containers | type == "array") and
    ([.spec.template.spec.containers[] | select(.name == "reticulum")] | length == 1) and
    (candidate_env | not) and
    ([((.metadata.annotations // {}) | keys),
      ((.spec.template.metadata.annotations // {}) | keys)] |
      flatten |
      any(. == "yenhubs.org/bot-runner-recovery-epoch" or
          . == "yenhubs.org/bot-runner-recovery-phase" or
          . == "yenhubs.org/runner-activation-phase" or
          . == "yenhubs.org/bot-runner-access-key-checksum" or
          . == "yenhubs.org/bot-orchestrator-access-key-checksum" or
          . == "yenhubs.org/dashboard-access-key-checksum") | not)
  ' >/dev/null <<<"$reticulum_json" || {
    printf 'Reticulum has partial isolated-runner recovery bindings.\n' >&2
    return 1
  }
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "pgsql" and .metadata.namespace == $namespace and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    ((.spec.template.spec.initContainers // []) == []) and
    (.spec.template.spec.containers | type == "array" and length == 1) and
    .spec.template.spec.containers[0].name == "postgresql"
  ' >/dev/null <<<"$pgsql_json" || {
    printf 'The live process-local PostgreSQL container does not match the historical AUD-065 contract.\n' >&2
    return 1
  }
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "v1" and .kind == "Secret" and
    .metadata.name == "configs" and .metadata.namespace == $namespace and
    .metadata.deletionTimestamp == null and
    (([(.data // {}), (.stringData // {})] | map(keys) | add) as $keys |
      (["BOT_RUNNER_ACCESS_KEY", "BOT_ORCHESTRATOR_ACCESS_KEY",
        "DASHBOARD_ACCESS_KEY"] | all(. as $name | ($keys | index($name)) == null)))
  ' >/dev/null <<<"$configs_json" || {
    printf 'The live configs Secret contains isolated-runner credentials; refusing process-local fallback.\n' >&2
    return 1
  }
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "v1" and .kind == "ConfigMap" and
    .metadata.name == "ret-config" and .metadata.namespace == $namespace and
    .metadata.deletionTimestamp == null and
    ([((.data // {})[] | select(type == "string"))] | join("\n")) as $text |
    (["<BOT_RUNNER_ACCESS_KEY>", "<BOT_ORCHESTRATOR_ACCESS_KEY>",
      "<DASHBOARD_ACCESS_KEY>", "<BOT_RUNNER_RECOVERY_EPOCH>",
      "Ret.BotOrchestrator"] | all(. as $marker | ($text | contains($marker) | not)))
  ' >/dev/null <<<"$ret_config_json" || {
    printf 'The live Reticulum config contains isolated-runner markers; refusing process-local fallback.\n' >&2
    return 1
  }
  residual_state="$(recovery_runner_isolation_residual_state)" || return 1
  [[ "$residual_state" == absent ]] || {
    printf 'Isolated-runner resources or annotations remain; refusing process-local fallback.\n' >&2
    return 1
  }
  recovery_require_no_managed_bot_runner_pods || return 1
}

recovery_checkpoint_runner_mode_candidate() {
  local parent_json reticulum_json residual_state
  parent_json="$(
    recovery_kubectl get deployment bot-orchestrator -n "$NAMESPACE" -o json
  )" || return 1
  reticulum_json="$(
    recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o json
  )" || return 1
  residual_state="$(recovery_runner_isolation_residual_state)" || return 1
  jq -ern --arg namespace "$NAMESPACE" --argjson parent "$parent_json" \
    --argjson reticulum "$reticulum_json" \
    --arg residual_state "$residual_state" '
    def valid_deployment($value; $name):
      $value.apiVersion == "apps/v1" and $value.kind == "Deployment" and
      $value.metadata.name == $name and $value.metadata.namespace == $namespace;
    def runner_annotations($value):
      [((($value.metadata.annotations // {}) | keys)),
       ((($value.spec.template.metadata.annotations // {}) | keys))] |
      flatten |
      any(. == "yenhubs.org/bot-runner-recovery-epoch" or
          . == "yenhubs.org/bot-runner-recovery-phase" or
          . == "yenhubs.org/runner-activation-phase" or
          . == "yenhubs.org/bot-runner-access-key-checksum" or
          . == "yenhubs.org/bot-orchestrator-access-key-checksum" or
          . == "yenhubs.org/dashboard-access-key-checksum");
    if (valid_deployment($parent; "bot-orchestrator") | not) or
       (valid_deployment($reticulum; "reticulum") | not) or
       ($parent.spec.template.spec.containers | type) != "array" or
       ([$parent.spec.template.spec.containers[] |
         select(.name == "bot-orchestrator")] | length) != 1
    then error("invalid_runner_parent")
    else
      ($parent.spec.template.spec.containers[] |
        select(.name == "bot-orchestrator")) as $container |
      ([($container.env // [])[].name] |
        any(. == "BOT_RUNNER_ACCESS_KEY" or
            . == "BOT_ORCHESTRATOR_ACCESS_KEY" or
            . == "DASHBOARD_ACCESS_KEY" or
            . == "BOT_RUNNER_IMAGE" or . == "BOT_RUNNER_RECOVERY_EPOCH" or
            . == "POD_NAMESPACE" or . == "ORCHESTRATOR_POD_NAME" or
            . == "ORCHESTRATOR_POD_UID" or . == "RUNNER_NAMESPACE" or
            . == "RUNNER_POD_NAMESPACE" or . == "RUNNER_CONTROL_URL")) as $binding |
      ([($reticulum.spec.template.spec.containers // [])[] |
        select(.name == "reticulum") | (.env // [])[].name] |
        any(. == "turkeyCfg_BOT_RUNNER_ACCESS_KEY" or
            . == "turkeyCfg_BOT_ORCHESTRATOR_ACCESS_KEY" or
            . == "turkeyCfg_DASHBOARD_ACCESS_KEY" or
            . == "turkeyCfg_BOT_RUNNER_RECOVERY_EPOCH")) as $ret_binding |
      if $residual_state == "present" or
         (($parent.spec.template.spec.serviceAccountName // "default") != "default") or
         $parent.spec.template.spec.automountServiceAccountToken != false or
         (($parent.spec.template.spec.imagePullSecrets // []) | length > 0) or
         $binding or $ret_binding or runner_annotations($parent) or
         runner_annotations($reticulum)
      then "kubernetes-pod" else "process-local" end
    end
  '
}

recovery_require_checkpoint_runner_mode_exact() {
  local values_path="$1" expected_mode="${2:-}" candidate_mode
  [[ -z "$expected_mode" || "$expected_mode" == process-local ||
     "$expected_mode" == kubernetes-pod ]] || return 2
  candidate_mode="$(recovery_checkpoint_runner_mode_candidate)" || {
    printf 'Could not classify the live checkpoint runner boundary.\n' >&2
    return 1
  }
  if [[ -n "$expected_mode" && "$candidate_mode" != "$expected_mode" ]]; then
    printf 'Checkpoint runner mode changed while writers were fenced.\n' >&2
    return 1
  fi
  case "$candidate_mode" in
    process-local)
      recovery_require_live_process_local_runner_exact "$values_path" || return 1
      ;;
    kubernetes-pod)
      # Any isolated-runner signal selects this branch.  A partial bootstrap,
      # admission, restore-fence or drifted setup must fail here and must never
      # fall back to the legacy authorization path.
      recovery_require_live_runner_active_control_plane_exact "$values_path" || return 1
      ;;
    *)
      return 1
      ;;
  esac
  printf '%s\n' "$candidate_mode"
}

recovery_resource_identity_tsv() {
  local scope="$1" resource="$2" name="$3" namespace="${4:-}"
  if [[ "$scope" == namespaced ]]; then
    recovery_kubectl get "$resource" "$name" -n "$namespace" \
      -o 'jsonpath={.apiVersion}{"\t"}{.kind}{"\t"}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.metadata.uid}'
  elif [[ "$scope" == cluster ]]; then
    recovery_kubectl get "$resource" "$name" \
      -o 'jsonpath={.apiVersion}{"\t"}{.kind}{"\t"}{.metadata.name}{"\t"}{.metadata.uid}'
  else
    return 2
  fi
}

recovery_require_live_runner_control_plane_matches_checkpoint() {
  local inventory_path="$1" mode target_mode="${RESTORE_TARGET_MODE:-in-place}" expected_uid identity
  local api_version kind namespace name uid extra
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  mode="$(jq -er '.bot_runner_runtime.mode' "$inventory_path")" || return 1
  [[ "$mode" == kubernetes-pod ]] || return 0
  [[ "$target_mode" == in-place || "$target_mode" == cold-rebind ]] || return 2

  expected_uid="$(jq -er '
    [.bot_runner_runtime.control_plane.namespaces[] |
      select(.name == "hcce-bot-runners") | .uid] |
    select(length == 1) | .[0]
  ' "$inventory_path")" || return 1
  identity="$(recovery_resource_identity_tsv cluster namespace hcce-bot-runners)" || return 1
  IFS=$'\t' read -r api_version kind name uid extra <<<"$identity"
  [[ -z "${extra:-}" && "$api_version" == v1 && "$kind" == Namespace &&
     "$name" == hcce-bot-runners &&
     ( "$target_mode" == cold-rebind || "$uid" == "$expected_uid" ) ]] || return 1

  while IFS='|' read -r resource expected_api expected_kind expected_name; do
    expected_uid="$(jq -er --arg api "$expected_api" --arg kind "$expected_kind" \
      --arg name "$expected_name" '
      [.bot_runner_runtime.control_plane.namespaced_resources[] |
        select(.api_version == $api and .kind == $kind and .name == $name) | .uid] |
      select(length == 1) | .[0]
    ' "$inventory_path")" || return 1
    identity="$(recovery_resource_identity_tsv namespaced "$resource" \
      "$expected_name" hcce-bot-runners)" || return 1
    IFS=$'\t' read -r api_version kind namespace name uid extra <<<"$identity"
    [[ -z "${extra:-}" && "$api_version" == "$expected_api" &&
       "$kind" == "$expected_kind" && "$namespace" == hcce-bot-runners &&
       "$name" == "$expected_name" &&
       ( "$target_mode" == cold-rebind || "$uid" == "$expected_uid" ) ]] || return 1
  done <<'RUNNER_RESOURCES'
secret|v1|Secret|bot-images-pull
serviceaccount|v1|ServiceAccount|bot-runner
resourcequota|v1|ResourceQuota|bot-runner-capacity
role|rbac.authorization.k8s.io/v1|Role|bot-orchestrator-runner-pods
rolebinding|rbac.authorization.k8s.io/v1|RoleBinding|bot-orchestrator-runner-pods
networkpolicy|networking.k8s.io/v1|NetworkPolicy|bot-runner-default-deny
networkpolicy|networking.k8s.io/v1|NetworkPolicy|bot-runner-egress
RUNNER_RESOURCES
  while IFS='|' read -r resource expected_api expected_kind expected_name; do
    expected_uid="$(jq -er --arg api "$expected_api" --arg kind "$expected_kind" \
      --arg name "$expected_name" '
      [.bot_runner_runtime.control_plane.cluster_resources[] |
        select(.api_version == $api and .kind == $kind and .name == $name) | .uid] |
      select(length == 1) | .[0]
    ' "$inventory_path")" || return 1
    identity="$(recovery_resource_identity_tsv cluster "$resource" "$expected_name")" || return 1
    IFS=$'\t' read -r api_version kind name uid extra <<<"$identity"
    [[ -z "${extra:-}" && "$api_version" == "$expected_api" &&
       "$kind" == "$expected_kind" && "$name" == "$expected_name" &&
       ( "$target_mode" == cold-rebind || "$uid" == "$expected_uid" ) ]] || return 1
  done <<'RUNNER_CLUSTER_RESOURCES'
validatingadmissionpolicy|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicy|bot-runner-pods.yenhubs.org
validatingadmissionpolicybinding|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicyBinding|bot-runner-pods.yenhubs.org
RUNNER_CLUSTER_RESOURCES
}

recovery_require_live_images_match_checkpoint() {
  local inventory_path="$1" deployments_json
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  deployments_json="$(recovery_kubectl get deployment -n "$NAMESPACE" -o json)" || return 1
  jq -e --argjson live "$deployments_json" '
    def projection($items):
      [$items[] | {
        name:.metadata.name,
        init_containers:[(.spec.template.spec.initContainers // [])[] |
          {name:.name,image:.image}] | sort_by(.name),
        containers:[.spec.template.spec.containers[] |
          {name:.name,image:.image}] | sort_by(.name)
      }] | sort_by(.name);
    ($live | type == "object" and (.items | type) == "array") and
    (projection($live.items) ==
      ([.deployments[] | {
        name:.name,init_containers:.init_containers,containers:.containers
      }] | sort_by(.name)))
  ' "$inventory_path" >/dev/null
}

recovery_checkpoint_image_for_pair() {
  local inventory_path="$1"
  local pair="$2"
  local trusted_repository="$3"
  local deployment_name container_name image
  [[ "$pair" == */* && "$trusted_repository" =~ ^[A-Za-z0-9._/-]+$ ]] || return 2
  deployment_name="${pair%%/*}"
  container_name="${pair#*/}"
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  image="$(jq -er \
    --arg deployment "$deployment_name" --arg container "$container_name" '
      [.deployments[] | select(.name == $deployment) | .containers[] |
        select(.name == $container) | .image] |
      select(length == 1) | .[0]
    ' "$inventory_path")" || return 1
  [[ "$image" =~ @sha256:[a-fA-F0-9]{64}$ &&
     "${image%@sha256:*}" == "$trusted_repository" ]] || return 1
  printf '%s\n' "$image"
}

recovery_materialize_checkpoint() {
  local input_artifact="$1"
  local validator="$2"
  local directory stamp dump_name storage_name contract_name inventory_name
  local dump_digest storage_digest contract_digest inventory_digest materialized_dir materialized_parent materialized_base
  local copied_dump_digest copied_storage_digest copied_contract_digest copied_inventory_digest
  recovery_cleanup_materialized_checkpoint
  if ! recovery_require_regular_direct_file "$input_artifact"; then
    printf 'Restore artifacts must be regular files, not links.\n' >&2
    return 1
  fi
  if ! stamp="$(recovery_checkpoint_stamp_from_artifact "$input_artifact")"; then
    printf 'Restore artifact name does not contain a valid checkpoint stamp.\n' >&2
    return 1
  fi
  directory="$(cd "$(dirname "$input_artifact")" && pwd -P)"
  dump_name="retdb-$stamp.sql.gz"
  storage_name="ret-storage-$stamp.tar.gz"
  contract_name="database-contract.json"
  inventory_name="deployment-images.json"
  recovery_verify_checkpoint_directory "$directory" "$stamp" || return 1
  if ! dump_digest="$(recovery_checkpoint_digest_for "$directory" "$dump_name")" ||
     ! storage_digest="$(recovery_checkpoint_digest_for "$directory" "$storage_name")" ||
     ! contract_digest="$(recovery_checkpoint_digest_for "$directory" "$contract_name")" ||
     ! inventory_digest="$(recovery_checkpoint_digest_for "$directory" "$inventory_name")"; then
    printf 'Could not resolve exact checkpoint artifact digests.\n' >&2
    return 1
  fi
  materialized_dir="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-restore-$stamp.XXXXXX")" || return 1
  if ! materialized_parent="$(cd "$(dirname "$materialized_dir")" && pwd -P)"; then
    rmdir "$materialized_dir" 2>/dev/null
    return 1
  fi
  materialized_base="$(basename "$materialized_dir")"
  [[ "$materialized_base" =~ ^yenhubs-restore-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$ ]] || {
    rmdir "$materialized_dir" 2>/dev/null
    return 1
  }
  materialized_dir="$materialized_parent/$materialized_base"
  if ! chmod 700 "$materialized_dir"; then
    rmdir "$materialized_dir" 2>/dev/null
    return 1
  fi
  RECOVERY_MATERIALIZED_DIR="$materialized_dir"
  RECOVERY_MATERIALIZED_PARENT="$materialized_parent"
  RECOVERY_MATERIALIZED_MARKER="$materialized_dir/.yenhubs-recovery-owner"
  if ! printf 'yenhubs-recovery-materialized-v1\n' >"$RECOVERY_MATERIALIZED_MARKER" ||
     ! chmod 600 "$RECOVERY_MATERIALIZED_MARKER"; then
    rm -f -- "$RECOVERY_MATERIALIZED_MARKER"
    rmdir "$materialized_dir" 2>/dev/null
    RECOVERY_MATERIALIZED_DIR=""
    RECOVERY_MATERIALIZED_PARENT=""
    RECOVERY_MATERIALIZED_MARKER=""
    return 1
  fi
  RECOVERY_MATERIALIZED_OWNED=1
  if ! COPYFILE_DISABLE=1 command cp "$directory/$dump_name" "$materialized_dir/$dump_name" ||
     ! COPYFILE_DISABLE=1 command cp "$directory/$storage_name" "$materialized_dir/$storage_name" ||
     ! COPYFILE_DISABLE=1 command cp "$directory/$contract_name" "$materialized_dir/$contract_name" ||
     ! COPYFILE_DISABLE=1 command cp "$directory/$inventory_name" "$materialized_dir/$inventory_name"; then
    recovery_cleanup_materialized_checkpoint
    printf 'Could not materialize the checkpoint artifacts.\n' >&2
    return 1
  fi
  chmod 600 "$materialized_dir/$dump_name" "$materialized_dir/$storage_name" \
    "$materialized_dir/$contract_name" "$materialized_dir/$inventory_name"
  if ! copied_dump_digest="$(recovery_sha256_digest "$materialized_dir/$dump_name")" ||
     ! copied_storage_digest="$(recovery_sha256_digest "$materialized_dir/$storage_name")" ||
     ! copied_contract_digest="$(recovery_sha256_digest "$materialized_dir/$contract_name")" ||
     ! copied_inventory_digest="$(recovery_sha256_digest "$materialized_dir/$inventory_name")" ||
     [[ "$copied_dump_digest" != "$dump_digest" ||
        "$copied_storage_digest" != "$storage_digest" ||
        "$copied_contract_digest" != "$contract_digest" ||
        "$copied_inventory_digest" != "$inventory_digest" ]]; then
    recovery_cleanup_materialized_checkpoint
    printf 'Materialized checkpoint artifacts do not match SHA256SUMS.\n' >&2
    return 1
  fi
  if ! "$validator" "$materialized_dir/$dump_name" "$materialized_dir/$storage_name" >/dev/null; then
    recovery_cleanup_materialized_checkpoint
    printf 'Materialized checkpoint pair failed joint validation.\n' >&2
    return 1
  fi
  RECOVERY_CHECKPOINT_STAMP="$stamp"
  RECOVERY_DUMP_SHA256="$dump_digest"
  RECOVERY_STORAGE_SHA256="$storage_digest"
  RECOVERY_DUMP_COPY="$materialized_dir/$dump_name"
  RECOVERY_STORAGE_COPY="$materialized_dir/$storage_name"
  RECOVERY_DATABASE_CONTRACT_COPY="$materialized_dir/$contract_name"
  RECOVERY_DEPLOYMENT_INVENTORY_COPY="$materialized_dir/$inventory_name"
  RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$inventory_digest"
  RECOVERY_CHECKPOINT_NAMESPACE_UID="$(jq -er \
    '.namespace_uid | select(type == "string" and length > 0)' \
    "$directory/checkpoint-metadata.json")" || {
    recovery_cleanup_materialized_checkpoint
    return 1
  }
  RECOVERY_CHECKPOINT_PVC_UID="$(jq -er \
    '.ret_pvc_uid | select(type == "string" and length > 0)' \
    "$directory/checkpoint-metadata.json")" || {
    recovery_cleanup_materialized_checkpoint
    return 1
  }
}

recovery_cleanup_materialized_checkpoint() {
  local canonical_parent base marker_value
  if [[ "${RECOVERY_MATERIALIZED_OWNED:-0}" == "1" &&
        -n "${RECOVERY_MATERIALIZED_DIR:-}" &&
        -n "${RECOVERY_MATERIALIZED_PARENT:-}" &&
        -n "${RECOVERY_MATERIALIZED_MARKER:-}" &&
        -d "$RECOVERY_MATERIALIZED_DIR" && ! -L "$RECOVERY_MATERIALIZED_DIR" ]]; then
    canonical_parent="$(cd "$(dirname "$RECOVERY_MATERIALIZED_DIR")" 2>/dev/null && pwd -P)" || canonical_parent=""
    base="$(basename "$RECOVERY_MATERIALIZED_DIR")"
    marker_value=""
    if [[ "$canonical_parent" == "$RECOVERY_MATERIALIZED_PARENT" &&
          "$RECOVERY_MATERIALIZED_DIR" == "$canonical_parent/$base" &&
          "$base" =~ ^yenhubs-restore-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$ &&
          "$RECOVERY_MATERIALIZED_MARKER" == "$RECOVERY_MATERIALIZED_DIR/.yenhubs-recovery-owner" &&
          -f "$RECOVERY_MATERIALIZED_MARKER" && ! -L "$RECOVERY_MATERIALIZED_MARKER" ]]; then
      marker_value="$(<"$RECOVERY_MATERIALIZED_MARKER")"
      if [[ "$marker_value" == "yenhubs-recovery-materialized-v1" ]]; then
        rm -rf -- "$RECOVERY_MATERIALIZED_DIR"
      fi
    fi
  fi
  RECOVERY_MATERIALIZED_DIR=""
  RECOVERY_MATERIALIZED_PARENT=""
  RECOVERY_MATERIALIZED_MARKER=""
  RECOVERY_MATERIALIZED_OWNED=0
  # shellcheck disable=SC2034
  RECOVERY_DUMP_COPY=""
  # shellcheck disable=SC2034
  RECOVERY_STORAGE_COPY=""
  # shellcheck disable=SC2034
  RECOVERY_DATABASE_CONTRACT_COPY=""
  # shellcheck disable=SC2034
  RECOVERY_DEPLOYMENT_INVENTORY_COPY=""
  RECOVERY_CHECKPOINT_STAMP=""
  RECOVERY_DUMP_SHA256=""
  RECOVERY_STORAGE_SHA256=""
  # shellcheck disable=SC2034
  RECOVERY_DEPLOYMENT_INVENTORY_SHA256=""
  RECOVERY_CHECKPOINT_NAMESPACE_UID=""
  RECOVERY_CHECKPOINT_PVC_UID=""
}

recovery_dump_copy_row_count() {
  local sql_path="$1"
  local table_name="$2"
  awk -v table_name="$table_name" '
    BEGIN { in_copy=0; copy_headers=0; copy_blocks=0; rows=0; failed=0 }
    $0 ~ ("^COPY ret0\\." table_name "([ (])") {
      copy_headers++
      if ($0 !~ ("^COPY ret0\\." table_name " \\([^)]*\\) FROM stdin;$")) {
        failed=1
        next
      }
      if (in_copy || copy_blocks > 0) {
        failed=1
        next
      }
      in_copy=1
      copy_blocks++
      next
    }
    in_copy && $0 == "\\." { in_copy=0; next }
    in_copy { rows++ }
    END {
      if (failed || copy_headers != 1 || copy_blocks != 1 || in_copy) exit 2
      print rows
    }
  ' "$sql_path"
}

recovery_extract_active_owned_file_uuids() {
  local sql_path="$1"
  awk '
    BEGIN {
      in_owned_files=0
      copy_headers=0
      copy_blocks=0
      uuid_column=0
      state_column=0
      active_count=0
      failed=0
    }
    /^COPY ret0\.owned_files([ (])/ {
      copy_headers++
      if ($0 !~ /^COPY ret0\.owned_files \([^)]*\) FROM stdin;$/) {
        failed=1
        next
      }
      if (in_owned_files || copy_blocks > 0) {
        failed=1
        next
      }
      columns=$0
      sub(/^COPY ret0\.owned_files \(/, "", columns)
      sub(/\) FROM stdin;$/, "", columns)
      column_count=split(columns, names, /,[[:space:]]*/)
      for (column_index=1; column_index<=column_count; column_index++) {
        if (names[column_index] == "owned_file_uuid") uuid_column=column_index
        if (names[column_index] == "state") state_column=column_index
      }
      if (uuid_column == 0 || state_column == 0) {
        failed=1
        next
      }
      copy_blocks++
      in_owned_files=1
      next
    }
    in_owned_files && $0 == "\\." { in_owned_files=0; next }
    in_owned_files {
      value_count=split($0, values, "\t")
      if (value_count < uuid_column || value_count < state_column) {
        failed=1
        next
      }
      if (values[state_column] == "active") active_values[++active_count]=values[uuid_column]
    }
    END {
      if (failed || copy_headers != 1 || copy_blocks != 1 || in_owned_files) exit 2
      for (item_index=1; item_index<=active_count; item_index++) print active_values[item_index]
    }
  ' "$sql_path"
}

recovery_extract_copy_column_values() {
  local sql_path="$1"
  local table_name="$2"
  local column_name="$3"
  [[ "$table_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$column_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 2
  awk -v table_name="$table_name" -v column_name="$column_name" '
    BEGIN { in_copy=0; headers=0; blocks=0; target_column=0; count=0; failed=0 }
    $0 ~ ("^COPY ret0\\." table_name "([ (])") {
      headers++
      if ($0 !~ ("^COPY ret0\\." table_name " \\([^)]*\\) FROM stdin;$") || in_copy || blocks > 0) {
        failed=1
        next
      }
      columns=$0
      sub("^COPY ret0\\." table_name " \\(", "", columns)
      sub(/\) FROM stdin;$/, "", columns)
      column_count=split(columns, names, /,[[:space:]]*/)
      for (column_index=1; column_index<=column_count; column_index++) {
        if (names[column_index] == column_name) target_column=column_index
      }
      if (target_column == 0) { failed=1; next }
      blocks++
      in_copy=1
      next
    }
    in_copy && $0 == "\\." { in_copy=0; next }
    in_copy {
      value_count=split($0, values, "\t")
      if (value_count < target_column || values[target_column] == "" || values[target_column] == "\\N") {
        failed=1
        next
      }
      output[++count]=values[target_column]
    }
    END {
      if (failed || headers != 1 || blocks != 1 || in_copy || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print output[item_index]
    }
  ' "$sql_path"
}

recovery_extract_owned_file_inventory() {
  local sql_path="$1"
  awk '
    BEGIN { in_copy=0; headers=0; blocks=0; uuid_column=0; state_column=0; count=0; failed=0 }
    /^COPY ret0\.owned_files([ (])/ {
      headers++
      if ($0 !~ /^COPY ret0\.owned_files \([^)]*\) FROM stdin;$/ || in_copy || blocks > 0) {
        failed=1
        next
      }
      columns=$0
      sub(/^COPY ret0\.owned_files \(/, "", columns)
      sub(/\) FROM stdin;$/, "", columns)
      column_count=split(columns, names, /,[[:space:]]*/)
      for (column_index=1; column_index<=column_count; column_index++) {
        if (names[column_index] == "owned_file_uuid") uuid_column=column_index
        if (names[column_index] == "state") state_column=column_index
      }
      if (uuid_column == 0 || state_column == 0) { failed=1; next }
      blocks++
      in_copy=1
      next
    }
    in_copy && $0 == "\\." { in_copy=0; next }
    in_copy {
      value_count=split($0, values, "\t")
      if (value_count < uuid_column || value_count < state_column ||
          values[uuid_column] == "" || values[uuid_column] == "\\N" ||
          values[state_column] == "" || values[state_column] == "\\N") {
        failed=1
        next
      }
      output[++count]=values[uuid_column] "\t" values[state_column]
    }
    END {
      if (failed || headers != 1 || blocks != 1 || in_copy || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print output[item_index]
    }
  ' "$sql_path"
}

recovery_extract_migration_versions() {
  local sql_path="$1"
  awk '
    BEGIN { in_copy=0; headers=0; blocks=0; version_column=0; count=0; failed=0 }
    /^COPY ret0\.schema_migrations([ (])/ {
      headers++
      if ($0 !~ /^COPY ret0\.schema_migrations \([^)]*\) FROM stdin;$/ || in_copy || blocks > 0) {
        failed=1
        next
      }
      columns=$0
      sub(/^COPY ret0\.schema_migrations \(/, "", columns)
      sub(/\) FROM stdin;$/, "", columns)
      column_count=split(columns, names, /,[[:space:]]*/)
      for (column_index=1; column_index<=column_count; column_index++) {
        if (names[column_index] == "version") version_column=column_index
      }
      if (version_column == 0) { failed=1; next }
      blocks++
      in_copy=1
      next
    }
    in_copy && $0 == "\\." { in_copy=0; next }
    in_copy {
      value_count=split($0, values, "\t")
      if (value_count < version_column || values[version_column] !~ /^[0-9]+$/) {
        failed=1
        next
      }
      versions[++count]=values[version_column]
    }
    END {
      if (failed || headers != 1 || blocks != 1 || in_copy || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print versions[item_index]
    }
  ' "$sql_path"
}

recovery_extract_dump_relations() {
  local sql_path="$1"
  awk '
    function add_relation(definition, relation_type, cleaned, pieces, piece_count, key) {
      cleaned=definition
      sub(/^CREATE (FOREIGN )?(TABLE|VIEW) /, "", cleaned)
      if (relation_type == "VIEW") sub(/ AS$/, "", cleaned)
      else sub(/ \($/, "", cleaned)
      piece_count=split(cleaned, pieces, ".")
      if (piece_count != 2 ||
          pieces[1] !~ /^(coturn|ret0|ret0_admin)$/ ||
          pieces[2] !~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
        failed=1
        return
      }
      key=pieces[1] "/" pieces[2]
      if (seen[key]++) { failed=1; return }
      rows[++count]=pieces[1] "\t" pieces[2] "\t" relation_type
    }
    BEGIN { count=0; failed=0 }
    /^CREATE TABLE (coturn|ret0|ret0_admin)\.[A-Za-z_][A-Za-z0-9_]* \($/ {
      add_relation($0, "BASE TABLE")
      next
    }
    /^CREATE FOREIGN TABLE (coturn|ret0|ret0_admin)\.[A-Za-z_][A-Za-z0-9_]* \($/ {
      add_relation($0, "FOREIGN")
      next
    }
    /^CREATE VIEW (coturn|ret0|ret0_admin)\.[A-Za-z_][A-Za-z0-9_]* AS$/ {
      add_relation($0, "VIEW")
      next
    }
    /^CREATE (FOREIGN )?(TABLE|VIEW) (coturn|ret0|ret0_admin)\./ { failed=1 }
    END {
      if (failed || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print rows[item_index]
    }
  ' "$sql_path"
}

recovery_sql_dump_has_complete_marker() {
  awk '
    BEGIN { marker_count=0; last_nonempty="" }
    NF { last_nonempty=$0 }
    $0 == "-- PostgreSQL database dump complete" { marker_count++ }
    END {
      if (marker_count != 1 || last_nonempty != "-- PostgreSQL database dump complete") exit 2
    }
  ' "$1"
}

recovery_validate_sql_dump_contract() {
  local sql_path="$1"
  local migrations_count hubs_count owned_files_count
  if ! migrations_count="$(recovery_dump_copy_row_count "$sql_path" schema_migrations)" ||
     ! hubs_count="$(recovery_dump_copy_row_count "$sql_path" hubs)" ||
     ! owned_files_count="$(recovery_dump_copy_row_count "$sql_path" owned_files)" ||
     ! recovery_sql_dump_has_complete_marker "$sql_path"; then
    return 1
  fi
  [[ "$migrations_count" =~ ^[0-9]+$ && "$migrations_count" -gt 0 &&
     "$hubs_count" =~ ^[0-9]+$ && "$hubs_count" -gt 0 &&
     "$owned_files_count" =~ ^[0-9]+$ && "$owned_files_count" -gt 0 ]]
}

recovery_validate_database_contract_against_dump() {
  local contract_path="$1"
  local sql_path="$2"
  local expected_sql_digest actual_sql_digest
  local migrations_count hubs_count owned_files_count active_count
  local expected_migrations expected_hubs expected_owned expected_active
  local dump_versions contract_versions dump_relations contract_relations
  local dump_hub_sids contract_hub_sids dump_owned_inventory contract_owned_inventory
  local dump_active_uuids contract_active_uuids
  recovery_database_contract_is_acceptable "$contract_path" || return 1
  recovery_validate_sql_dump_contract "$sql_path" || return 1
  expected_sql_digest="$(jq -er \
    '.sql_dump_sha256 | select(type == "string" and test("^[a-fA-F0-9]{64}$"))' \
    "$contract_path")" || return 1
  actual_sql_digest="$(recovery_sha256_digest "$sql_path")" || return 1
  [[ "$actual_sql_digest" == "$expected_sql_digest" ]] || return 1
  [[ "$(grep -Ec '^CREATE SCHEMA ret0;$' "$sql_path")" == "1" &&
     "$(grep -Ec '^CREATE SCHEMA ret0_admin;$' "$sql_path")" == "1" &&
     "$(grep -Ec '^CREATE SCHEMA coturn;$' "$sql_path")" == "1" ]] || return 1
  migrations_count="$(recovery_dump_copy_row_count "$sql_path" schema_migrations)" || return 1
  hubs_count="$(recovery_dump_copy_row_count "$sql_path" hubs)" || return 1
  owned_files_count="$(recovery_dump_copy_row_count "$sql_path" owned_files)" || return 1
  active_count="$(recovery_extract_active_owned_file_uuids "$sql_path" | sed '/^$/d' | wc -l | tr -d ' ')" || return 1
  expected_migrations="$(jq -r '.critical_counts.migrations' "$contract_path")" || return 1
  expected_hubs="$(jq -r '.critical_counts.hubs' "$contract_path")" || return 1
  expected_owned="$(jq -r '.critical_counts.owned_files' "$contract_path")" || return 1
  expected_active="$(jq -r '.critical_counts.active_owned_files' "$contract_path")" || return 1
  dump_versions="$(recovery_extract_migration_versions "$sql_path" | LC_ALL=C sort)" || return 1
  contract_versions="$(jq -r '.migration_versions[]' "$contract_path" | LC_ALL=C sort)" || return 1
  dump_relations="$(recovery_extract_dump_relations "$sql_path" | LC_ALL=C sort)" || return 1
  contract_relations="$(jq -r '.relations[] | [.schema, .name, .type] | @tsv' "$contract_path" | LC_ALL=C sort)" || return 1
  dump_hub_sids="$(recovery_extract_copy_column_values "$sql_path" hubs hub_sid | LC_ALL=C sort)" || return 1
  contract_hub_sids="$(jq -r '.critical_inventory.hub_sids[]' "$contract_path" | LC_ALL=C sort)" || return 1
  dump_owned_inventory="$(recovery_extract_owned_file_inventory "$sql_path" | LC_ALL=C sort)" || return 1
  contract_owned_inventory="$(jq -r '.critical_inventory.owned_files[] | [.uuid, .state] | @tsv' "$contract_path" | LC_ALL=C sort)" || return 1
  dump_active_uuids="$(recovery_extract_active_owned_file_uuids "$sql_path" | LC_ALL=C sort)" || return 1
  contract_active_uuids="$(jq -r '.critical_inventory.active_owned_file_uuids[]' "$contract_path" | LC_ALL=C sort)" || return 1
  [[ "$migrations_count" == "$expected_migrations" &&
     "$hubs_count" == "$expected_hubs" &&
     "$owned_files_count" == "$expected_owned" &&
     "$active_count" == "$expected_active" &&
     "$dump_versions" == "$contract_versions" &&
     "$dump_relations" == "$contract_relations" &&
     "$dump_hub_sids" == "$contract_hub_sids" &&
     "$dump_owned_inventory" == "$contract_owned_inventory" &&
     "$dump_active_uuids" == "$contract_active_uuids" ]]
}

# Reticulum stores each owned-file pair below two UUID-derived shard
# directories: owned/<uuid[0:2]>/<uuid[2:4]>/<uuid>.(blob|meta.json).
# Accept directory entries only at those exact depths and reject every other
# path before tar extraction or after a live PVC enumeration.
recovery_storage_path_stream_is_exact() {
  awk '
    BEGIN { failed=0; files=0 }
    /^owned\/?$/ { next }
    {
      path=$0
      if (path ~ /^owned\/[A-Za-z0-9._-]{2}\/$/) next
      if (path ~ /^owned\/[A-Za-z0-9._-]{2}\/[A-Za-z0-9._-]{2}\/$/) next
      if (path !~ /^owned\/[A-Za-z0-9._-]{2}\/[A-Za-z0-9._-]{2}\/[A-Za-z0-9._-]{4,}\.(blob|meta\.json)$/) {
        failed=1
        next
      }
      count=split(path, pieces, "/")
      if (count != 4) { failed=1; next }
      filename=pieces[4]
      uuid=filename
      sub(/\.meta\.json$/, "", uuid)
      sub(/\.blob$/, "", uuid)
      if (substr(uuid, 1, 2) != pieces[2] || substr(uuid, 3, 2) != pieces[3]) {
        failed=1
        next
      }
      files++
    }
    END { exit (failed || files == 0) ? 1 : 0 }
  '
}

recovery_storage_paths_file_is_exact() {
  local paths_file="$1"
  [[ -f "$paths_file" && ! -L "$paths_file" && -s "$paths_file" ]] || return 1
  recovery_storage_path_stream_is_exact <"$paths_file"
}

recovery_extract_storage_uuids() {
  local paths_file="$1"
  local suffix="$2"
  [[ "$suffix" == blob || "$suffix" == meta.json ]] || return 2
  recovery_storage_paths_file_is_exact "$paths_file" || return 1
  if [[ "$suffix" == blob ]]; then
    sed -n 's#^owned/[A-Za-z0-9._-][A-Za-z0-9._-]/[A-Za-z0-9._-][A-Za-z0-9._-]/\([A-Za-z0-9._-]*\)\.blob$#\1#p' \
      "$paths_file"
  else
    sed -n 's#^owned/[A-Za-z0-9._-][A-Za-z0-9._-]/[A-Za-z0-9._-][A-Za-z0-9._-]/\([A-Za-z0-9._-]*\)\.meta\.json$#\1#p' \
      "$paths_file"
  fi
}

recovery_require_cluster_identity() {
  local current_context live_namespace_uid

  if [[ -z "${EXPECTED_KUBE_CONTEXT:-}" ]]; then
    printf 'EXPECTED_KUBE_CONTEXT is required; refusing an implicit kubectl context.\n' >&2
    return 1
  fi
  if [[ -z "${EXPECTED_NAMESPACE_UID:-}" ]]; then
    printf 'EXPECTED_NAMESPACE_UID is required; pin the target namespace identity.\n' >&2
    return 1
  fi

  current_context="$(command kubectl --request-timeout=45s config current-context 2>/dev/null)" || {
    printf 'Could not read the current kubectl context.\n' >&2
    return 1
  }
  if [[ "$current_context" != "$EXPECTED_KUBE_CONTEXT" ]]; then
    printf 'kubectl context mismatch: expected=%s current=%s.\n' \
      "$EXPECTED_KUBE_CONTEXT" "$current_context" >&2
    return 1
  fi

  live_namespace_uid="$(
    recovery_kubectl get namespace "$NAMESPACE" -o jsonpath='{.metadata.uid}'
  )" || {
    printf 'Could not read namespace %s in context %s.\n' \
      "$NAMESPACE" "$EXPECTED_KUBE_CONTEXT" >&2
    return 1
  }
  if [[ -z "$live_namespace_uid" || "$live_namespace_uid" != "$EXPECTED_NAMESPACE_UID" ]]; then
    printf 'Namespace UID mismatch: namespace=%s expected=%s current=%s.\n' \
      "$NAMESPACE" "$EXPECTED_NAMESPACE_UID" "${live_namespace_uid:-missing}" >&2
    return 1
  fi

  RECOVERY_NAMESPACE_UID="$live_namespace_uid"
  export RECOVERY_NAMESPACE_UID
}

recovery_require_pvc_identity() {
  local pvc_name="$1"
  local current_pvc_uid
  if [[ -z "${EXPECTED_RET_PVC_UID:-}" ]]; then
    printf 'EXPECTED_RET_PVC_UID is required; pin the ret-pvc identity.\n' >&2
    return 1
  fi
  if ! current_pvc_uid="$(
    recovery_kubectl get pvc "$pvc_name" -n "$NAMESPACE" -o jsonpath='{.metadata.uid}'
  )"; then
    printf 'Could not read PVC %s in the verified target.\n' "$pvc_name" >&2
    return 1
  fi
  if [[ -z "$current_pvc_uid" || "$current_pvc_uid" != "$EXPECTED_RET_PVC_UID" ]]; then
    printf 'PVC UID mismatch: pvc=%s expected=%s current=%s.\n' \
      "$pvc_name" "$EXPECTED_RET_PVC_UID" "${current_pvc_uid:-missing}" >&2
    return 1
  fi
  RECOVERY_PVC_UID="$current_pvc_uid"
  export RECOVERY_PVC_UID
}

recovery_require_local_fixture_attestation() {
  [[ "${YENHUBS_RECOVERY_TEST_MODE:-}" == local-fixture &&
     "${EXPECTED_KUBE_CONTEXT:-}" == fixture-context &&
     "${EXPECTED_NAMESPACE_UID:-}" == fixture-uid &&
     "${EXPECTED_RET_PVC_UID:-}" == fixture-pvc-uid &&
     "${NAMESPACE:-}" == hcce ]] || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  [[ "$RECOVERY_NAMESPACE_UID" == fixture-uid &&
     "$RECOVERY_PVC_UID" == fixture-pvc-uid ]]
}

recovery_stable_absence_seconds() {
  local test_mode="${YENHUBS_RECOVERY_TEST_MODE:-}"
  local requested="${RECOVERY_TEST_STABLE_ABSENCE_SECONDS:-}"
  if [[ -z "$test_mode" && -z "$requested" ]]; then
    printf '61\n'
    return 0
  fi
  recovery_require_local_fixture_attestation || {
    printf 'Recovery timing overrides require the exact isolated fixture identity.\n' >&2
    return 1
  }
  requested="${requested:-0}"
  [[ "$requested" =~ ^[0-2]$ ]] || return 2
  printf '%s\n' "$requested"
}

recovery_require_pod_identity() {
  local pod_name="$1"
  local expected_uid="$2"
  local current_uid
  [[ -n "$pod_name" && -n "$expected_uid" ]] || return 2
  if ! current_uid="$(
    recovery_kubectl get pod "$pod_name" -n "$NAMESPACE" -o jsonpath='{.metadata.uid}'
  )"; then
    printf 'Could not read pod identity for %s.\n' "$pod_name" >&2
    return 1
  fi
  if [[ "$current_uid" != "$expected_uid" ]]; then
    printf 'Pod UID mismatch for %s.\n' "$pod_name" >&2
    return 1
  fi
}

recovery_exact_ready_pod_info() {
  local pods_json="$1"
  local app_label="$2"
  [[ -n "$pods_json" && "$app_label" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  jq -er --arg app "$app_label" '
    select((.items | type) == "array" and (.items | length) == 1) |
    .items[0] |
    select(.metadata.name | type == "string" and length > 0) |
    select(.metadata.uid | type == "string" and length > 0) |
    select((.metadata.deletionTimestamp // null) == null) |
    select(.metadata.labels.app == $app) |
    select(.status.phase == "Running") |
    select([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length == 1) |
    select([.metadata.ownerReferences[]? |
      select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and
             .controller == true and (.uid | type == "string" and length > 0))] | length == 1) |
    [.metadata.name, .metadata.uid] | @tsv
  ' <<<"$pods_json"
}

recovery_require_pod_deployment_ownership() {
  local pod_json="$1"
  local deployment_name="$2"
  local expected_deployment_uid="${3:-}"
  local replica_set_name replica_set_uid deployment_uid replica_set_json deployment_json
  [[ "$deployment_name" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  replica_set_name="$(jq -er '
    [.metadata.ownerReferences[]? |
      select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and .controller == true)] |
    select(length == 1) | .[0].name
  ' <<<"$pod_json")" || return 1
  replica_set_uid="$(jq -er '
    [.metadata.ownerReferences[]? |
      select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and .controller == true)] |
    select(length == 1) | .[0].uid
  ' <<<"$pod_json")" || return 1
  replica_set_json="$(recovery_kubectl get replicaset "$replica_set_name" \
    -n "$NAMESPACE" -o json)" || return 1
  deployment_json="$(recovery_kubectl get deployment "$deployment_name" \
    -n "$NAMESPACE" -o json)" || return 1
  deployment_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$deployment_json")" || return 1
  [[ -z "$expected_deployment_uid" || "$deployment_uid" == "$expected_deployment_uid" ]] || return 1
  jq -e --arg rs_name "$replica_set_name" --arg rs_uid "$replica_set_uid" \
    --arg deployment "$deployment_name" --arg deployment_uid "$deployment_uid" '
    .apiVersion == "apps/v1" and .kind == "ReplicaSet" and
    .metadata.name == $rs_name and .metadata.uid == $rs_uid and
    ([.metadata.ownerReferences[]? |
      select(.apiVersion == "apps/v1" and .kind == "Deployment" and
             .controller == true and .name == $deployment and .uid == $deployment_uid)] |
      length) == 1
  ' >/dev/null <<<"$replica_set_json"
}

recovery_exact_ready_deployment_pod_info() {
  local pods_json="$1"
  local app_label="$2"
  local deployment_name="$3"
  local pod_info pod_name pod_uid pod_json deployment_json deployment_uid
  [[ "$deployment_name" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  pod_info="$(recovery_exact_ready_pod_info "$pods_json" "$app_label")" || return 1
  IFS=$'\t' read -r pod_name pod_uid <<<"$pod_info"
  pod_json="$(jq -cer --arg uid "$pod_uid" '
    [.items[] | select(.metadata.uid == $uid)] | select(length == 1) | .[0]
  ' <<<"$pods_json")" || return 1
  deployment_json="$(recovery_kubectl get deployment "$deployment_name" \
    -n "$NAMESPACE" -o json)" || return 1
  deployment_uid="$(jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    .metadata.uid | select(type == "string" and length > 0)
  ' <<<"$deployment_json")" || return 1
  recovery_require_pod_deployment_ownership \
    "$pod_json" "$deployment_name" "$deployment_uid" || return 1
  printf '%s\t%s\n' "$pod_info" "$deployment_uid"
}

recovery_capture_deployment_contract() {
  local deployment_name="$1"
  local deployment_json
  [[ "$deployment_name" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  deployment_json="$(
    recovery_kubectl get deployment "$deployment_name" -n "$NAMESPACE" -o json
  )" || return 1
  jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name) |
    select(.metadata.namespace == $namespace) |
    select(.metadata.uid | type == "string" and length > 0) |
    select(.metadata.resourceVersion | type == "string" and length > 0) |
    select(.spec.replicas | type == "number" and floor == . and . >= 0) |
    select((.spec.selector.matchLabels | keys) == ["app"]) |
    select((.spec.selector.matchExpressions // []) == []) |
    select(.spec.selector.matchLabels.app | type == "string" and length > 0) |
    select(.spec.template.metadata.labels.app == .spec.selector.matchLabels.app) |
    [
      .metadata.uid,
      .metadata.resourceVersion,
      (.spec.replicas | tostring),
      .spec.selector.matchLabels.app,
      ({selector:.spec.selector, strategy:(.spec.strategy // {}), template:.spec.template} | @base64)
    ] | @tsv
  ' <<<"$deployment_json"
}

recovery_require_deployment_contract() {
  local deployment_name="$1"
  local expected_uid="$2"
  local expected_replicas="$3"
  local expected_selector="$4"
  local expected_fingerprint="$5"
  local contract uid resource_version replicas selector fingerprint
  contract="$(recovery_capture_deployment_contract "$deployment_name")" || return 1
  IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
  [[ "$uid" == "$expected_uid" && "$replicas" == "$expected_replicas" &&
     "$selector" == "$expected_selector" && "$fingerprint" == "$expected_fingerprint" ]]
}

# Scale one previously captured Deployment with server-side compare-and-set
# guards. The global operation lock and the immutable part of the Deployment
# are revalidated immediately before and after the mutation. The new
# resourceVersion is printed so callers can chain further exact mutations.
recovery_scale_deployment_exact() {
  local deployment_name="$1"
  local expected_uid="$2"
  local expected_resource_version="$3"
  local expected_replicas="$4"
  local desired_replicas="$5"
  local expected_selector="$6"
  local expected_fingerprint="$7"
  local before_contract uid resource_version replicas selector fingerprint
  local after_contract after_uid after_resource_version after_replicas after_selector after_fingerprint
  [[ "$expected_replicas" =~ ^[0-9]+$ && "$desired_replicas" =~ ^[0-9]+$ &&
     -n "$expected_resource_version" ]] || return 2
  recovery_require_operation_lock || return 1
  before_contract="$(recovery_capture_deployment_contract "$deployment_name")" || return 1
  IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$before_contract"
  [[ "$uid" == "$expected_uid" && "$resource_version" == "$expected_resource_version" &&
     "$replicas" == "$expected_replicas" && "$selector" == "$expected_selector" &&
     "$fingerprint" == "$expected_fingerprint" ]] || {
    printf 'Deployment contract changed before scaling %s.\n' "$deployment_name" >&2
    return 1
  }
  recovery_kubectl_mutate scale deployment "$deployment_name" -n "$NAMESPACE" \
    --current-replicas="$expected_replicas" \
    --resource-version="$expected_resource_version" \
    --replicas="$desired_replicas" >/dev/null || return 1
  recovery_require_operation_lock || return 1
  after_contract="$(recovery_capture_deployment_contract "$deployment_name")" || return 1
  IFS=$'\t' read -r after_uid after_resource_version after_replicas after_selector after_fingerprint \
    <<<"$after_contract"
  [[ "$after_uid" == "$expected_uid" && "$after_replicas" == "$desired_replicas" &&
     "$after_selector" == "$expected_selector" &&
     "$after_fingerprint" == "$expected_fingerprint" ]] || {
    printf 'Deployment contract changed while scaling %s.\n' "$deployment_name" >&2
    return 1
  }
  printf '%s\n' "$after_resource_version"
}

recovery_consumer_contract_is_acceptable() {
  local contract_json="$1"
  jq -e '
    type == "object" and
    (keys | sort) == ["consumers", "operation_id", "schema_version"] and
    .schema_version == 1 and
    (.operation_id | type == "string" and test("^[a-f0-9]{32}$")) and
    (.consumers | type == "array" and length == 5) and
    ([.consumers[].name] | sort) ==
      ["bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"] and
    ([.consumers[].name] | unique | length) == 5 and
    all(.consumers[];
      (keys | sort) == ["fingerprint", "initial_resource_version", "name", "original_replicas", "selector", "uid"] and
      (.uid | type == "string" and length > 0) and
      (.initial_resource_version | type == "string" and length > 0) and
      (.original_replicas | type == "number" and floor == . and . > 0) and
      (.selector | type == "string" and test("^[A-Za-z0-9._-]+$")) and
      (.fingerprint | type == "string" and test("^[A-Za-z0-9+/]+={0,2}$")))
  ' >/dev/null 2>&1 <<<"$contract_json"
}

recovery_require_consumer_contract_entry() {
  local contract_json="$1"
  local deployment_name="$2"
  local expected_current_replicas="$3"
  local expected_operation_id="${4:-${RECOVERY_OPERATION_ID:-}}"
  local expected uid selector fingerprint current_contract current_uid _current_rv current_replicas current_selector current_fingerprint
  recovery_consumer_contract_is_acceptable "$contract_json" || return 1
  [[ "$(jq -r '.operation_id' <<<"$contract_json")" == "$expected_operation_id" ]] || return 1
  expected="$(jq -cer --arg name "$deployment_name" \
    '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0]' \
    <<<"$contract_json")" || return 1
  uid="$(jq -r '.uid' <<<"$expected")"
  selector="$(jq -r '.selector' <<<"$expected")"
  fingerprint="$(jq -r '.fingerprint' <<<"$expected")"
  current_contract="$(recovery_capture_deployment_contract "$deployment_name")" || return 1
  IFS=$'\t' read -r current_uid _current_rv current_replicas current_selector current_fingerprint \
    <<<"$current_contract"
  [[ "$current_uid" == "$uid" && "$current_replicas" == "$expected_current_replicas" &&
     "$current_selector" == "$selector" && "$current_fingerprint" == "$fingerprint" ]]
}

recovery_uuid_v4() {
  local raw
  raw="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" || return 1
  [[ "$raw" =~ ^[a-f0-9]{32}$ ]] || return 1
  printf '%s-%s-4%s-%x%s-%s\n' \
    "${raw:0:8}" "${raw:8:4}" "${raw:13:3}" \
    "$((16#${raw:16:1} % 4 + 8))" "${raw:17:3}" "${raw:20:12}"
}

recovery_rfc3339_now() {
  date -u '+%Y-%m-%dT%H:%M:%S.000000Z'
}

recovery_rfc3339_epoch() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$ ]] || return 1
  node -e '
    const value = process.argv[1];
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) process.exit(1);
    process.stdout.write(String(Math.floor(epoch / 1000)));
  ' "$value"
}

recovery_serialization_lease_json_is_valid() {
  local lease_json="$1"
  jq -e --arg namespace "$NAMESPACE" --arg name "$RECOVERY_SERIALIZATION_LEASE_NAME" '
    .apiVersion == "coordination.k8s.io/v1" and .kind == "Lease" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    (.metadata | has("deletionTimestamp") | not) and
    (((.metadata | has("ownerReferences") | not) or .metadata.ownerReferences == [])) and
    (((.metadata | has("finalizers") | not) or .metadata.finalizers == [])) and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (.metadata.labels // {}) == {
      "yenhubs.org/operation-serialization":"deployment-recovery"
    } and
    (((.metadata | has("annotations") | not) or .metadata.annotations == {})) and
    (.spec | type == "object") and
    (.spec.leaseDurationSeconds == 120) and
    (.spec.leaseTransitions | type == "number" and floor == . and . >= 0) and
    (if (.spec.holderIdentity // "") == "" then
      (.spec | keys | sort) == ["leaseDurationSeconds","leaseTransitions"]
    else
      (.spec | keys | sort) == ["acquireTime","holderIdentity",
        "leaseDurationSeconds","leaseTransitions","renewTime"] and
      (.spec.holderIdentity | type == "string" and
        test("^(root-recovery|cloud-apply):[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")) and
      (.spec.acquireTime | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$")) and
      (.spec.renewTime | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$"))
    end)
  ' >/dev/null <<<"$lease_json"
}

recovery_owned_serialization_lease_json_is_exact() {
  local lease_json="$1"
  local renew_epoch now_epoch
  recovery_serialization_lease_json_is_valid "$lease_json" || return 1
  jq -e --arg holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg uid "$RECOVERY_SERIALIZATION_LEASE_UID" '
    .metadata.uid == $uid and .spec.holderIdentity == $holder
  ' >/dev/null <<<"$lease_json" || return 1
  renew_epoch="$(recovery_rfc3339_epoch \
    "$(jq -er '.spec.renewTime' <<<"$lease_json")")" || return 1
  now_epoch="$(date -u '+%s')" || return 1
  ((renew_epoch <= now_epoch + 5 && now_epoch - renew_epoch <= 40))
}

recovery_replace_serialization_lease() {
  local lease_json="$1" holder="$2" now="$3" transitions="$4"
  jq -cn --argjson live "$lease_json" --arg holder "$holder" --arg now "$now" \
    --argjson transitions "$transitions" '
    {
      apiVersion:"coordination.k8s.io/v1",kind:"Lease",
      metadata:{name:$live.metadata.name,namespace:$live.metadata.namespace,
        uid:$live.metadata.uid,resourceVersion:$live.metadata.resourceVersion,
        labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
      spec:{holderIdentity:$holder,leaseDurationSeconds:120,
        acquireTime:$now,renewTime:$now,leaseTransitions:$transitions}
    }
  ' | recovery_kubectl replace -f - -o json
}

recovery_acquire_operation_serialization() {
  local prefix="${1:-root-recovery}" lease_json holder now transitions
  local renew_epoch now_epoch duration
  [[ "$prefix" == root-recovery ]] || return 2
  [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 0 ]] || return 2
  holder="$prefix:$(recovery_uuid_v4)" || return 1
  now="$(recovery_rfc3339_now)" || return 1
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" --ignore-not-found -o json)" || return 1
  if [[ -z "$lease_json" ]]; then
    lease_json="$(cat <<EOF | recovery_kubectl create -f - -o json
apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: $RECOVERY_SERIALIZATION_LEASE_NAME
  namespace: $NAMESPACE
  labels:
    yenhubs.org/operation-serialization: deployment-recovery
spec:
  holderIdentity: "$holder"
  leaseDurationSeconds: 120
  acquireTime: "$now"
  renewTime: "$now"
  leaseTransitions: 0
EOF
    )" || {
      printf 'Could not atomically create the deployment/recovery serialization Lease.\n' >&2
      return 1
    }
  else
    recovery_serialization_lease_json_is_valid "$lease_json" || {
      printf 'The deployment/recovery serialization Lease has an unsafe contract.\n' >&2
      return 1
    }
    if [[ -n "$(jq -r '.spec.holderIdentity // ""' <<<"$lease_json")" ]]; then
      renew_epoch="$(recovery_rfc3339_epoch \
        "$(jq -er '.spec.renewTime' <<<"$lease_json")")" || return 1
      now_epoch="$(date -u '+%s')" || return 1
      duration="$(jq -er '.spec.leaseDurationSeconds' <<<"$lease_json")" || return 1
      if (( now_epoch < renew_epoch + duration )); then
        printf 'Another deployment or recovery operation owns the serialization Lease.\n' >&2
        return 1
      fi
    fi
    transitions="$(jq -er '.spec.leaseTransitions + 1' <<<"$lease_json")" || return 1
    lease_json="$(recovery_replace_serialization_lease \
      "$lease_json" "$holder" "$now" "$transitions")" || {
      printf 'Serialization Lease takeover lost its resourceVersion CAS.\n' >&2
      return 1
    }
  fi
  recovery_serialization_lease_json_is_valid "$lease_json" || return 1
  RECOVERY_SERIALIZATION_LEASE_HOLDER="$holder"
  RECOVERY_SERIALIZATION_LEASE_UID="$(jq -er '.metadata.uid' <<<"$lease_json")" || return 1
  RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
  RECOVERY_SERIALIZATION_PARENT_PID="$$"
  if ! RECOVERY_SERIALIZATION_PARENT_START_IDENTITY="$(
    recovery_process_start_identity "$RECOVERY_SERIALIZATION_PARENT_PID"
  )"; then
    recovery_release_operation_serialization >/dev/null 2>&1 || :
    return 1
  fi
  export RECOVERY_SERIALIZATION_LEASE_HOLDER RECOVERY_SERIALIZATION_LEASE_UID \
    RECOVERY_SERIALIZATION_LEASE_REQUIRED RECOVERY_SERIALIZATION_PARENT_PID \
    RECOVERY_SERIALIZATION_PARENT_START_IDENTITY
  if ! recovery_start_operation_serialization_heartbeat; then
    # Ownership was acquired but no heartbeat capability exists. Clear the
    # holder immediately by CAS; never return with an invisible live owner.
    recovery_release_operation_serialization >/dev/null 2>&1 || :
    return 1
  fi
}

recovery_renew_operation_serialization() {
  local lease_json now transitions renewed
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$lease_json" || return 1
  now="$(recovery_rfc3339_now)" || return 1
  transitions="$(jq -er '.spec.leaseTransitions' <<<"$lease_json")" || return 1
  renewed="$(jq -cn --argjson live "$lease_json" \
    --arg holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" --arg now "$now" \
    --argjson transitions "$transitions" '
    {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
      metadata:{name:$live.metadata.name,namespace:$live.metadata.namespace,
        uid:$live.metadata.uid,resourceVersion:$live.metadata.resourceVersion,
        labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
      spec:{holderIdentity:$holder,leaseDurationSeconds:120,
        acquireTime:$live.spec.acquireTime,renewTime:$now,
        leaseTransitions:$transitions}}
  ' | recovery_kubectl replace -f - -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$renewed"
}

recovery_start_operation_serialization_heartbeat() {
  local interval="${RECOVERY_LEASE_HEARTBEAT_SECONDS:-20}" sleeper_pid=""
  [[ "$interval" =~ ^([1-9]|[12][0-9]|30)$ ]] || return 2
  RECOVERY_SERIALIZATION_HEARTBEAT_STOP="$(mktemp \
    "${TMPDIR:-/tmp}/yenhubs-lease-stop.XXXXXX")" || return 1
  RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE="$(mktemp \
    "${TMPDIR:-/tmp}/yenhubs-lease-failure.XXXXXX")" || {
    rm -f -- "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP"
    RECOVERY_SERIALIZATION_HEARTBEAT_STOP=""
    return 1
  }
  chmod 600 "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" \
    "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
  (
    # shellcheck disable=SC2317,SC2329 # Invoked indirectly by the TERM/INT trap.
    heartbeat_stop() {
      [[ "$sleeper_pid" =~ ^[1-9][0-9]*$ ]] || exit 0
      kill -TERM "$sleeper_pid" 2>/dev/null || :
      wait "$sleeper_pid" 2>/dev/null || :
      exit 0
    }
    trap heartbeat_stop TERM INT
    while :; do
      recovery_process_identity_is_live "$RECOVERY_SERIALIZATION_PARENT_PID" \
        "$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" || exit 0
      sleep "$interval" &
      sleeper_pid=$!
      wait "$sleeper_pid" || exit 1
      sleeper_pid=""
      [[ ! -s "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" ]] || exit 0
      recovery_process_identity_is_live "$RECOVERY_SERIALIZATION_PARENT_PID" \
        "$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" || exit 0
      if ! recovery_renew_operation_serialization; then
        printf 'lease_lost\n' >"$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
        kill -TERM "$RECOVERY_SERIALIZATION_PARENT_PID" 2>/dev/null || :
        exit 1
      fi
    done
  ) &
  RECOVERY_SERIALIZATION_HEARTBEAT_PID=$!
  export RECOVERY_SERIALIZATION_HEARTBEAT_STOP \
    RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE \
    RECOVERY_SERIALIZATION_HEARTBEAT_PID
}

recovery_adopt_parent_operation_serialization() {
  local holder="$1" uid="$2" parent_pid="$3" parent_start_identity="$4" lease_json
  [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 0 &&
     "$holder" =~ ^root-recovery:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
     -n "$uid" && "$parent_pid" =~ ^[1-9][0-9]*$ &&
     -n "$parent_start_identity" ]] || return 2
  recovery_process_identity_is_live "$parent_pid" "$parent_start_identity" || return 1
  RECOVERY_SERIALIZATION_LEASE_HOLDER="$holder"
  RECOVERY_SERIALIZATION_LEASE_UID="$uid"
  RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
  RECOVERY_SERIALIZATION_ADOPTED=1
  RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID="$parent_pid"
  RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY="$parent_start_identity"
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  if ! recovery_owned_serialization_lease_json_is_exact "$lease_json"; then
    RECOVERY_SERIALIZATION_LEASE_HOLDER=""
    RECOVERY_SERIALIZATION_LEASE_UID=""
    RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
    RECOVERY_SERIALIZATION_ADOPTED=0
    RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID=""
    RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY=""
    return 1
  fi
}

recovery_require_operation_serialization() {
  local lease_json
  [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 1 ]] || return 1
  if [[ "$RECOVERY_SERIALIZATION_ADOPTED" == 0 ]]; then
    [[ "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" =~ ^[1-9][0-9]*$ &&
       -f "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE" &&
       ! -s "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE" ]] || return 1
    kill -0 "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null || return 1
  else
    recovery_process_identity_is_live \
      "$RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID" \
      "$RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY" || return 1
  fi
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$lease_json"
}

recovery_release_operation_serialization() {
  local lease_json released transitions release_status=0
  [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 1 ]] || return 0
  [[ "$RECOVERY_SERIALIZATION_ADOPTED" == 0 ]] || return 2
  if [[ "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" =~ ^[1-9][0-9]*$ ]]; then
    printf 'stop\n' >"$RECOVERY_SERIALIZATION_HEARTBEAT_STOP"
    kill -TERM "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null || :
    if ! wait "$RECOVERY_SERIALIZATION_HEARTBEAT_PID"; then release_status=1; fi
  fi
  RECOVERY_SERIALIZATION_HEARTBEAT_PID=""
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$lease_json" || return 1
  transitions="$(jq -er '.spec.leaseTransitions' <<<"$lease_json")" || return 1
  released="$(jq -cn --argjson live "$lease_json" --argjson transitions "$transitions" '
    {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
      metadata:{name:$live.metadata.name,namespace:$live.metadata.namespace,
        uid:$live.metadata.uid,resourceVersion:$live.metadata.resourceVersion,
        labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
      spec:{leaseDurationSeconds:120,leaseTransitions:$transitions}}
  ' | recovery_kubectl replace -f - -o json)" || return 1
  recovery_serialization_lease_json_is_valid "$released" || return 1
  jq -e --arg uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --argjson transitions "$transitions" '
    .metadata.uid == $uid and
    .spec == {leaseDurationSeconds:120,leaseTransitions:$transitions}
  ' >/dev/null <<<"$released" || return 1
  rm -f -- "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" \
    "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
  RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
  RECOVERY_SERIALIZATION_LEASE_HOLDER=""
  RECOVERY_SERIALIZATION_LEASE_UID=""
  RECOVERY_SERIALIZATION_ADOPTED=0
  RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID=""
  RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY=""
  export RECOVERY_SERIALIZATION_LEASE_REQUIRED \
    RECOVERY_SERIALIZATION_LEASE_HOLDER RECOVERY_SERIALIZATION_LEASE_UID
  [[ "$release_status" == 0 ]]
}

recovery_operation_lock_json_is_exact() {
  local lock_json="$1"
  [[ "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     -n "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" &&
     "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_OWNER:-}" =~ ^[A-Za-z0-9._-]+$ &&
     -n "${RECOVERY_NAMESPACE_UID:-}" && -n "${RECOVERY_PVC_UID:-}" &&
     "${RECOVERY_CHECKPOINT_STAMP:-}" =~ ^[0-9]{8}-[0-9]{6}$ &&
     "${RECOVERY_DUMP_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ &&
     "${RECOVERY_STORAGE_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] || return 1
  if [[ "$RECOVERY_OPERATION_OWNER" == aud065-rotation ]]; then
    [[ "$RECOVERY_OPERATION_BINDING_SHA256" =~ ^[a-f0-9]{64}$ &&
       "$RECOVERY_OPERATION_STATE" =~ ^(preflight|quiesced|db-rotated|bundle-applied|verified|cleanup-authorized)$ ]] || return 1
  else
    [[ -z "$RECOVERY_OPERATION_BINDING_SHA256" ]] || return 1
  fi
  jq -e \
    --arg name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg namespace "$NAMESPACE" \
    --arg uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg resource_version "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg owner "$RECOVERY_OPERATION_OWNER" \
    --arg token "$RECOVERY_OPERATION_TOKEN" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg pvc_uid "$RECOVERY_PVC_UID" \
    --arg stamp "$RECOVERY_CHECKPOINT_STAMP" \
    --arg dump_sha "$RECOVERY_DUMP_SHA256" \
    --arg storage_sha "$RECOVERY_STORAGE_SHA256" \
    --arg inventory_sha "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" \
    --arg pre_epoch "${RECOVERY_FENCE_PRE_EPOCH:-}" \
    --arg target_epoch "${RECOVERY_FENCE_TARGET_EPOCH:-}" \
    --arg operation_state "${RECOVERY_OPERATION_STATE:-}" \
    --arg operation_binding_sha256 "${RECOVERY_OPERATION_BINDING_SHA256:-}" '
    .apiVersion == "v1" and
    .kind == "ConfigMap" and
    .metadata.name == $name and
    .metadata.namespace == $namespace and
    .metadata.uid == $uid and
    .metadata.resourceVersion == $resource_version and
    (.metadata.labels // {}) == {"yenhubs.org/recovery-owner":$owner} and
    (.metadata.annotations // {}) == ({
      "yenhubs.org/operation-id": $operation_id,
      "yenhubs.org/recovery-token": $token,
      "yenhubs.org/namespace-uid": $namespace_uid,
      "yenhubs.org/pvc-uid": $pvc_uid,
      "yenhubs.org/checkpoint-stamp": $stamp,
      "yenhubs.org/dump-sha256": $dump_sha,
      "yenhubs.org/storage-sha256": $storage_sha
    } + if $pre_epoch == "" and $target_epoch == "" then {} else {
      "yenhubs.org/pre-fence-epoch":$pre_epoch,
      "yenhubs.org/restore-fence-epoch":$target_epoch,
      "yenhubs.org/deployment-inventory-sha256":$inventory_sha
    } end + if $operation_state == "" then {} else {
      "yenhubs.org/recovery-state":$operation_state
    } end + if $operation_binding_sha256 == "" then {} else {
      "yenhubs.org/operation-binding-sha256":$operation_binding_sha256
    } end) and
    .immutable == true and
    (.data // {}) == {} and
    (.binaryData // {}) == {}
  ' >/dev/null 2>&1 <<<"$lock_json"
}

recovery_require_operation_lock() {
  local lock_json
  if [[ "${RECOVERY_SERIALIZATION_LEASE_REQUIRED:-0}" == 1 ]]; then
    recovery_require_operation_serialization || {
      printf 'The deployment/recovery serialization Lease was lost.\n' >&2
      return 1
    }
  fi
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || {
    printf 'The coordinated recovery lock is missing or unreadable.\n' >&2
    return 1
  }
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    printf 'The coordinated recovery lock identity or operation binding changed.\n' >&2
    return 1
  fi
}

recovery_acquire_operation_lock() {
  local owner="$1"
  local lock_name="${2:-$RECOVERY_OPERATION_LOCK_GLOBAL_NAME}"
  local lock_json fence_annotations="" state_annotation="" binding_annotation=""
  [[ "$owner" =~ ^(checkpoint-backup|checkpoint-restore|aud065-rotation)$ &&
     "$lock_name" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_NAMESPACE_UID:-}" && -n "${RECOVERY_PVC_UID:-}" &&
     "${RECOVERY_CHECKPOINT_STAMP:-}" =~ ^[0-9]{8}-[0-9]{6}$ &&
     "${RECOVERY_DUMP_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ &&
     "${RECOVERY_STORAGE_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] || return 2
  recovery_require_operation_serialization || {
    printf 'The deployment/recovery serialization Lease is required before creating an operation lock.\n' >&2
    return 1
  }
  RECOVERY_OPERATION_OWNER="$owner"
  RECOVERY_OPERATION_LOCK_NAME="$lock_name"
  RECOVERY_OPERATION_LOCK_UID=""
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=""
  if [[ -n "${RECOVERY_FENCE_PRE_EPOCH:-}" || -n "${RECOVERY_FENCE_TARGET_EPOCH:-}" ]]; then
    [[ "$owner" == checkpoint-restore &&
       ( "$RECOVERY_FENCE_PRE_EPOCH" == legacy-absent ||
         "$RECOVERY_FENCE_PRE_EPOCH" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ) &&
       "$RECOVERY_FENCE_TARGET_EPOCH" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
       "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
    fence_annotations="$(printf '    yenhubs.org/pre-fence-epoch: "%s"\n    yenhubs.org/restore-fence-epoch: "%s"\n    yenhubs.org/deployment-inventory-sha256: "%s"' \
      "$RECOVERY_FENCE_PRE_EPOCH" "$RECOVERY_FENCE_TARGET_EPOCH" \
      "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256")"
  fi
  if [[ -n "${RECOVERY_OPERATION_STATE:-}" ]]; then
    [[ ( "$owner" == checkpoint-restore || "$owner" == aud065-rotation ) &&
       "$RECOVERY_OPERATION_STATE" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || return 2
    if [[ "$owner" == aud065-rotation &&
          "$RECOVERY_OPERATION_STATE" != preflight ]]; then
      return 2
    fi
    state_annotation="$(printf '    yenhubs.org/recovery-state: "%s"' \
      "$RECOVERY_OPERATION_STATE")"
  fi
  if [[ -n "${RECOVERY_OPERATION_BINDING_SHA256:-}" ]]; then
    [[ "$owner" == aud065-rotation &&
       "$RECOVERY_OPERATION_BINDING_SHA256" =~ ^[a-f0-9]{64}$ &&
       "$RECOVERY_OPERATION_STATE" == preflight ]] || return 2
    binding_annotation="$(printf '    yenhubs.org/operation-binding-sha256: "%s"' \
      "$RECOVERY_OPERATION_BINDING_SHA256")"
  elif [[ "$owner" == aud065-rotation ]]; then
    printf 'AUD-065 rotation locks require an exact private-operation binding.\n' >&2
    return 2
  fi
  if [[ "$owner" == aud065-rotation ]]; then
    [[ "$RECOVERY_OPERATION_IDENTITY_PREBOUND" == 1 &&
       "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
       "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ ]] || {
      printf 'AUD-065 identifiers must be durably prebound before lock creation.\n' >&2
      return 2
    }
  else
    if ! RECOVERY_OPERATION_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" ||
       [[ ! "$RECOVERY_OPERATION_TOKEN" =~ ^[a-f0-9]{32}$ ]] ||
       ! RECOVERY_OPERATION_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" ||
       [[ ! "$RECOVERY_OPERATION_ID" =~ ^[a-f0-9]{32}$ ]]; then
      printf 'Could not create private recovery-operation identifiers.\n' >&2
      return 1
    fi
  fi
  if ! cat <<EOF | recovery_kubectl_mutate create -f - >/dev/null
apiVersion: v1
kind: ConfigMap
metadata:
  name: $RECOVERY_OPERATION_LOCK_NAME
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: $RECOVERY_OPERATION_OWNER
  annotations:
    yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
    yenhubs.org/recovery-token: "$RECOVERY_OPERATION_TOKEN"
    yenhubs.org/namespace-uid: "$RECOVERY_NAMESPACE_UID"
    yenhubs.org/pvc-uid: "$RECOVERY_PVC_UID"
    yenhubs.org/checkpoint-stamp: "$RECOVERY_CHECKPOINT_STAMP"
    yenhubs.org/dump-sha256: "$RECOVERY_DUMP_SHA256"
    yenhubs.org/storage-sha256: "$RECOVERY_STORAGE_SHA256"
$fence_annotations
$state_annotation
$binding_annotation
immutable: true
EOF
  then
    printf 'Another recovery operation owns the target or the global lock could not be created.\n' >&2
    return 1
  fi
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || return 1
  recovery_require_operation_serialization || return 1
  RECOVERY_OPERATION_LOCK_UID="$(jq -er \
    '.metadata.uid | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  export RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID RECOVERY_OPERATION_STATE \
    RECOVERY_OPERATION_BINDING_SHA256
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    printf 'Created recovery lock does not match its exact operation contract.\n' >&2
    return 1
  fi
}

# Recover the exact AUD-065 lock after a crash in the remote-create to local
# UID/resourceVersion persistence window. The token and operation ID already
# live in the private operation state; no name-only lock may ever be adopted.
recovery_discover_aud065_operation_lock() {
  local lock_json live_uid live_resource_version live_state
  local previous_uid previous_resource_version previous_state
  [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation &&
     "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_BINDING_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  recovery_require_operation_serialization || {
    printf 'The deployment/recovery serialization Lease is required before discovering an AUD-065 lock.\n' >&2
    return 1
  }
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || {
    printf 'The persisted AUD-065 lock is missing or unreadable.\n' >&2
    return 1
  }
  live_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  live_resource_version="$(jq -er '
    .metadata.resourceVersion | select(type == "string" and length > 0)
  ' <<<"$lock_json")" || return 1
  live_state="$(jq -er '
    .metadata.annotations["yenhubs.org/recovery-state"] |
    select(type == "string" and
      test("^(preflight|quiesced|db-rotated|bundle-applied|verified|cleanup-authorized)$"))
  ' <<<"$lock_json")" || return 1
  previous_uid="${RECOVERY_OPERATION_LOCK_UID:-}"
  previous_resource_version="${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}"
  previous_state="${RECOVERY_OPERATION_STATE:-}"
  RECOVERY_OPERATION_LOCK_UID="$live_uid"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$live_resource_version"
  RECOVERY_OPERATION_STATE="$live_state"
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    RECOVERY_OPERATION_LOCK_UID="$previous_uid"
    RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$previous_resource_version"
    RECOVERY_OPERATION_STATE="$previous_state"
    printf 'The persisted AUD-065 lock does not match the durable private identity.\n' >&2
    return 1
  fi
  export RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_STATE
}

recovery_adopt_aud065_operation_lock() {
  local lock_json live_state live_resource_version previous_state
  local previous_resource_version
  [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation &&
     "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_BINDING_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  recovery_require_operation_serialization || {
    printf 'The deployment/recovery serialization Lease is required before adopting an AUD-065 lock.\n' >&2
    return 1
  }
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || {
    printf 'The persisted AUD-065 lock is missing or unreadable.\n' >&2
    return 1
  }
  live_state="$(jq -er '
    .metadata.annotations["yenhubs.org/recovery-state"] |
    select(type == "string" and
      test("^(preflight|quiesced|db-rotated|bundle-applied|verified|cleanup-authorized)$"))
  ' <<<"$lock_json")" || return 1
  live_resource_version="$(jq -er '
    .metadata.resourceVersion | select(type == "string" and length > 0)
  ' <<<"$lock_json")" || return 1
  previous_state="${RECOVERY_OPERATION_STATE:-}"
  previous_resource_version="${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}"
  RECOVERY_OPERATION_STATE="$live_state"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$live_resource_version"
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    RECOVERY_OPERATION_STATE="$previous_state"
    RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$previous_resource_version"
    printf 'The persisted AUD-065 lock does not match the private operation identity.\n' >&2
    return 1
  fi
  export RECOVERY_OPERATION_STATE RECOVERY_OPERATION_LOCK_RESOURCE_VERSION
}

recovery_transition_aud065_operation_lock() {
  local next_state="${1:-}" lock_json replacement replaced_json
  local previous_state previous_resource_version next_resource_version live_uid
  [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation &&
     "${RECOVERY_OPERATION_BINDING_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  previous_state="${RECOVERY_OPERATION_STATE:-}"
  case "$previous_state:$next_state" in
    preflight:quiesced|quiesced:db-rotated|db-rotated:bundle-applied|bundle-applied:verified|verified:cleanup-authorized) ;;
    *)
      printf 'AUD-065 lock transitions must advance exactly one state.\n' >&2
      return 2
      ;;
  esac
  recovery_require_operation_serialization || {
    printf 'The deployment/recovery serialization Lease is required before changing an AUD-065 lock.\n' >&2
    return 1
  }
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || return 1
  recovery_operation_lock_json_is_exact "$lock_json" || {
    printf 'The AUD-065 lock changed before its state transition.\n' >&2
    return 1
  }
  previous_resource_version="$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION"
  replacement="$(jq -c --arg next_state "$next_state" '
    .metadata.annotations["yenhubs.org/recovery-state"] = $next_state |
    del(.metadata.managedFields)
  ' <<<"$lock_json")" || return 1
  replaced_json="$(printf '%s\n' "$replacement" |
    recovery_kubectl_mutate replace -f - -o json)" || {
    printf 'The AUD-065 lock state transition failed its resourceVersion precondition.\n' >&2
    return 1
  }
  live_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$replaced_json")" || return 1
  next_resource_version="$(jq -er '
    .metadata.resourceVersion | select(type == "string" and length > 0)
  ' <<<"$replaced_json")" || return 1
  [[ "$live_uid" == "$RECOVERY_OPERATION_LOCK_UID" &&
     "$next_resource_version" != "$previous_resource_version" ]] || return 1
  RECOVERY_OPERATION_STATE="$next_state"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$next_resource_version"
  export RECOVERY_OPERATION_STATE RECOVERY_OPERATION_LOCK_RESOURCE_VERSION
  recovery_operation_lock_json_is_exact "$replaced_json" || {
    printf 'The transitioned AUD-065 lock does not match its exact contract.\n' >&2
    return 1
  }
}

recovery_release_operation_lock() {
  if [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation ]]; then
    [[ "${RECOVERY_OPERATION_STATE:-}" == cleanup-authorized ]] || {
      printf 'AUD-065 operation locks remain durable until cleanup is durably authorized.\n' >&2
      return 2
    }
    recovery_require_operation_serialization || return 1
    if ! declare -F aud065_require_pgsql_barrier_released >/dev/null 2>&1; then
      printf 'AUD-065 lock release requires the PostgreSQL barrier cleanup contract.\n' >&2
      return 1
    fi
    aud065_require_pgsql_barrier_released || {
      printf 'AUD-065 lock release requires a clean PostgreSQL ingress barrier and no probe.\n' >&2
      return 1
    }
  fi
  recovery_require_operation_lock || return 1
  recovery_delete_namespaced_with_uid configmap "$RECOVERY_OPERATION_LOCK_NAME" \
    "$RECOVERY_OPERATION_LOCK_UID" 60
}

recovery_delete_namespaced_with_uid() {
  recovery_delete_namespaced_with_uid_in_namespace \
    "$NAMESPACE" "$1" "$2" "$3" "${4:-60}"
}

recovery_delete_namespaced_with_uid_in_namespace() {
  local target_namespace="$1"
  local kind="$2"
  local name="$3"
  local uid="$4"
  local timeout_seconds="${5:-60}"
  local api_path current_json current_uid started
  [[ "$target_namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ &&
     "$name" =~ ^[A-Za-z0-9._-]+$ && -n "$uid" &&
     "$timeout_seconds" =~ ^[0-9]+$ && "$timeout_seconds" -gt 0 ]] || return 2
  case "$kind" in
    configmap)
      api_path="/api/v1/namespaces/$target_namespace/configmaps/$name"
      ;;
    pod)
      api_path="/api/v1/namespaces/$target_namespace/pods/$name"
      ;;
    networkpolicy)
      api_path="/apis/networking.k8s.io/v1/namespaces/$target_namespace/networkpolicies/$name"
      ;;
    *)
      return 2
      ;;
  esac
  if ! jq -cn --arg uid "$uid" '{
      apiVersion:"v1", kind:"DeleteOptions",
      propagationPolicy:"Foreground", preconditions:{uid:$uid}
    }' | recovery_kubectl_mutate delete --raw="$api_path" -f - >/dev/null; then
    printf 'UID-preconditioned deletion failed for %s/%s.\n' "$kind" "$name" >&2
    return 1
  fi
  started="$SECONDS"
  while ((SECONDS - started < timeout_seconds)); do
    # A 404 after the UID-preconditioned DELETE is the successful terminal
    # state. Callers use errtrace for fail-safe recovery, so suppress their ERR
    # trap only inside this expected-failure command substitution; otherwise a
    # copied trap in the subshell can resume writers and release the live lock.
    if ! current_json="$(trap - ERR; recovery_kubectl get "$kind" "$name" \
      -n "$target_namespace" -o json 2>/dev/null)"; then
      return 0
    fi
    current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
      <<<"$current_json")" || return 1
    # A same-name replacement is not ours and must never be deleted or waited
    # on. The UID-preconditioned target is already gone in this case.
    [[ "$current_uid" == "$uid" ]] || return 0
    sleep "${RECOVERY_DELETE_POLL_SECONDS:-1}"
  done
  printf 'Timed out waiting for UID-preconditioned deletion of %s/%s.\n' \
    "$kind" "$name" >&2
  return 1
}

recovery_pod_pvc_mount_is_exact() {
  local pods_json="$1"
  local pod_name="$2"
  local container_name="$3"
  local claim_name="$4"
  local mount_path="$5"
  [[ -n "$pods_json" && -n "$pod_name" && -n "$container_name" &&
     -n "$claim_name" && "$mount_path" == /* ]] || return 2
  jq -e \
    --arg pod "$pod_name" \
    --arg container "$container_name" \
    --arg claim "$claim_name" \
    --arg mount_path "$mount_path" '
    [.items[] | select(.metadata.name == $pod)] as $pods |
    ($pods | length) == 1 and
    $pods[0].spec as $spec |
    [$spec.volumes[]? | select(.persistentVolumeClaim.claimName == $claim)] as $claim_volumes |
    ($claim_volumes | length) == 1 and
    $claim_volumes[0] as $claim_volume |
    (($claim_volume | keys | sort) == ["name", "persistentVolumeClaim"]) and
    (($claim_volume.persistentVolumeClaim | keys - ["claimName", "readOnly"]) | length) == 0 and
    ($claim_volume.name | type == "string" and length > 0) and
    ([($spec.containers // [])[] | select(.name == $container)] | length) == 1 and
    [
      (($spec.initContainers // []) + ($spec.containers // []) +
       ($spec.ephemeralContainers // []))[] as $candidate |
      ($candidate.volumeMounts // [])[] |
      select(.name == $claim_volume.name) |
      {container: $candidate.name, mount: .}
    ] as $claim_mounts |
    ($claim_mounts | length) == 1 and
    $claim_mounts[0].container == $container and
    $claim_mounts[0].mount.mountPath == $mount_path and
    (($claim_mounts[0].mount.subPath // "") == "") and
    (($claim_mounts[0].mount.subPathExpr // "") == "") and
    ([($spec.containers // [])[] | select(.name == $container) |
      (.volumeMounts // [])[] | select(.mountPath == $mount_path)] | length) == 1 and
    ([($spec.containers // [])[] | select(.name == $container) |
      (.volumeMounts // [])[] | select(.mountPath == $mount_path) | .name] ==
      [$claim_volume.name])
  ' >/dev/null 2>&1 <<<"$pods_json"
}

recovery_storage_helper_pod_is_exact() {
  local pod_json="$1"
  local pod_name="$2"
  local pod_uid="$3"
  local role="$4"
  local image="$5"
  local read_only="$6"
  local wrapped_json
  [[ "$read_only" == true || "$read_only" == false ]] || return 2
  wrapped_json="$(jq -ce '{items:[.]}' <<<"$pod_json")" || return 1
  recovery_pod_pvc_mount_is_exact \
    "$wrapped_json" "$pod_name" helper ret-pvc /storage || return 1
  jq -e \
    --arg pod "$pod_name" --arg uid "$pod_uid" --arg namespace "$NAMESPACE" \
    --arg role "$role" --arg image "$image" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg operation_token "$RECOVERY_OPERATION_TOKEN" \
    --argjson read_only "$read_only" '
    .metadata.name == $pod and .metadata.uid == $uid and
    .metadata.namespace == $namespace and
    (.metadata.labels // {}) == {
      "yenhubs.org/recovery-owner":$role,
      "yenhubs.org/operation-id":$operation_id
    } and
    (.metadata.annotations // {}) == {
      "yenhubs.org/operation-lock-uid":$lock_uid,
      "yenhubs.org/operation-token":$operation_token
    } and
    .spec.automountServiceAccountToken == false and
    .spec.enableServiceLinks == false and .spec.restartPolicy == "Never" and
    .spec.activeDeadlineSeconds == 3600 and
    (.spec.hostNetwork // false) == false and (.spec.hostPID // false) == false and
    (.spec.hostIPC // false) == false and (.spec.shareProcessNamespace // false) == false and
    ((.spec.initContainers // []) | length) == 0 and
    ((.spec.ephemeralContainers // []) | length) == 0 and
    ([.spec.volumes[].name] == ["storage"]) and
    ((.spec.volumes[0].persistentVolumeClaim | keys | sort) == ["claimName", "readOnly"]) and
    .spec.volumes[0].persistentVolumeClaim.claimName == "ret-pvc" and
    .spec.volumes[0].persistentVolumeClaim.readOnly == $read_only and
    ([.spec.containers[].name] == ["helper"]) and
    .spec.containers[0].image == $image and
    .spec.containers[0].command == ["sh", "-c", "sleep 3600"] and
    ((.spec.containers[0].args // []) | length) == 0 and
    ((.spec.containers[0].env // []) | length) == 0 and
    ((.spec.containers[0].envFrom // []) | length) == 0 and
    ((.spec.containers[0].ports // []) | length) == 0 and
    ((.spec.containers[0].volumeDevices // []) | length) == 0 and
    ((.spec.containers[0].volumeMounts // []) | length) == 1 and
    .spec.containers[0].volumeMounts[0].name == "storage" and
    .spec.containers[0].volumeMounts[0].mountPath == "/storage" and
    .spec.containers[0].volumeMounts[0].readOnly == $read_only and
    ((.spec.containers[0].lifecycle // {}) | length) == 0 and
    (.spec.containers[0].stdin // false) == false and
    (.spec.containers[0].stdinOnce // false) == false and
    (.spec.containers[0].tty // false) == false and
    .spec.securityContext.runAsNonRoot == true and
    .spec.securityContext.runAsUser == 1000 and .spec.securityContext.runAsGroup == 1000 and
    .spec.securityContext.fsGroup == 1000 and
    .spec.securityContext.fsGroupChangePolicy == "OnRootMismatch" and
    .spec.securityContext.seccompProfile.type == "RuntimeDefault" and
    (.spec.containers[0].securityContext.privileged // false) == false and
    .spec.containers[0].securityContext.allowPrivilegeEscalation == false and
    .spec.containers[0].securityContext.readOnlyRootFilesystem == true and
    ((.spec.containers[0].securityContext.capabilities.drop // []) | sort) == ["ALL"] and
    ((.spec.containers[0].securityContext.capabilities.add // []) | length) == 0 and
    ((.spec.containers[0].securityContext.procMount // "Default") == "Default")
  ' >/dev/null 2>&1 <<<"$pod_json"
}

recovery_storage_helper_network_policy_is_exact() {
  local policy_json="$1"
  local policy_name="$2"
  local policy_uid="$3"
  local role="$4"
  jq -e \
    --arg name "$policy_name" --arg uid "$policy_uid" --arg namespace "$NAMESPACE" \
    --arg role "$role" --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg operation_token "$RECOVERY_OPERATION_TOKEN" '
    .apiVersion == "networking.k8s.io/v1" and .kind == "NetworkPolicy" and
    .metadata.name == $name and .metadata.uid == $uid and
    .metadata.namespace == $namespace and
    (.metadata.labels // {}) == {
      "yenhubs.org/recovery-owner":$role,
      "yenhubs.org/operation-id":$operation_id
    } and
    (.metadata.annotations // {}) == {
      "yenhubs.org/operation-lock-uid":$lock_uid,
      "yenhubs.org/operation-token":$operation_token
    } and
    (.spec | keys | sort) == ["egress", "ingress", "podSelector", "policyTypes"] and
    .spec.podSelector == {matchLabels:{"yenhubs.org/operation-id":$operation_id}} and
    (.spec.policyTypes | sort) == ["Egress", "Ingress"] and
    .spec.ingress == [] and .spec.egress == []
  ' >/dev/null 2>&1 <<<"$policy_json"
}

recovery_confirmation_value() {
  local resource="$1"
  local resource_uid="${2:-}"
  if [[ -z "${RECOVERY_CHECKPOINT_STAMP:-}" ||
        -z "${RECOVERY_DUMP_SHA256:-}" || -z "${RECOVERY_STORAGE_SHA256:-}" ]]; then
    return 2
  fi
  printf '%s:%s:%s:%s:%s:%s:%s' \
    "$resource" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" \
    "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" "$RECOVERY_STORAGE_SHA256"
  if [[ -n "$resource_uid" ]]; then
    printf ':%s' "$resource_uid"
  fi
}

recovery_require_confirmation() {
  local variable_name="$1"
  local resource="$2"
  local resource_uid="${3:-}"
  local expected_value actual_value

  expected_value="$(recovery_confirmation_value "$resource" "$resource_uid")" || {
    printf 'Checkpoint identity was not materialized before confirmation.\n' >&2
    return 1
  }
  actual_value="${!variable_name:-}"
  if [[ "$actual_value" != "$expected_value" ]]; then
    printf 'Refusing destructive restore. Set %s=%q for this exact target.\n' \
      "$variable_name" "$expected_value" >&2
    return 1
  fi
}

recovery_restore_rebind_confirmation_value() {
  [[ -n "${RECOVERY_NAMESPACE_UID:-}" && -n "${RECOVERY_PVC_UID:-}" &&
     "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  printf 'cold-rebind:%s:%s:%s:%s:%s:%s:%s:%s' \
    "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" \
    "$RECOVERY_PVC_UID" "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256"
}

recovery_require_restore_target_binding() {
  local mode="${RESTORE_TARGET_MODE:-in-place}" expected actual inventory_namespace_uid
  [[ "$mode" == in-place || "$mode" == cold-rebind ]] || {
    printf 'RESTORE_TARGET_MODE must be in-place or cold-rebind.\n' >&2
    return 2
  }
  inventory_namespace_uid="$(jq -er \
    '.namespace_uid | select(type == "string" and length > 0)' \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY")" || return 1
  [[ "$inventory_namespace_uid" == "$RECOVERY_CHECKPOINT_NAMESPACE_UID" ]] || {
    printf 'Checkpoint metadata and deployment inventory disagree on the origin namespace UID.\n' >&2
    return 1
  }
  if [[ "$mode" == in-place ]]; then
    [[ "$RECOVERY_NAMESPACE_UID" == "$RECOVERY_CHECKPOINT_NAMESPACE_UID" &&
       "$RECOVERY_PVC_UID" == "$RECOVERY_CHECKPOINT_PVC_UID" ]] || {
      printf 'In-place restore requires the exact checkpoint namespace and PVC UIDs.\n' >&2
      return 1
    }
    return 0
  fi
  [[ "$RECOVERY_NAMESPACE_UID" != "$RECOVERY_CHECKPOINT_NAMESPACE_UID" &&
     "$RECOVERY_PVC_UID" != "$RECOVERY_CHECKPOINT_PVC_UID" ]] || {
    printf 'Cold rebind requires newly created namespace and PVC UIDs.\n' >&2
    return 1
  }
  expected="$(recovery_restore_rebind_confirmation_value)" || return 1
  actual="${CONFIRM_RESTORE_REBIND:-}"
  [[ "$actual" == "$expected" ]] || {
    printf 'Refusing cold restore rebind. Set CONFIRM_RESTORE_REBIND=%q for this exact destination.\n' \
      "$expected" >&2
    return 1
  }
}

recovery_pvc_consumer_names() {
  local claim_name="$1"
  local pods_json
  if ! pods_json="$(recovery_kubectl get pod -n "$NAMESPACE" -o json)"; then
    return 1
  fi
  printf '%s' "$pods_json" | jq -r --arg claim "$claim_name" '
    [.items[]
      | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim))
      | .metadata.name]
    | sort
    | .[]
  '
}

recovery_require_exact_pvc_consumers() {
  local claim_name="$1"
  local allowed_name="${2:-}"
  local consumers
  if ! consumers="$(recovery_pvc_consumer_names "$claim_name")"; then
    printf 'Could not inspect pods consuming PVC %s.\n' "$claim_name" >&2
    return 1
  fi
  if [[ -z "$allowed_name" && -z "$consumers" ]]; then
    return 0
  fi
  if [[ -n "$allowed_name" && "$consumers" == "$allowed_name" ]]; then
    return 0
  fi
  printf 'Unexpected pods consume PVC %s; refusing storage mutation.\n' "$claim_name" >&2
  return 1
}

# Per-room bot runners are created directly by bot-orchestrator and therefore
# are not members of the fixed Deployment consumer inventory. Recovery windows
# conservatively fence the union of both workload markers. Requiring their
# intersection would let a drifted or malicious Pod evade the destructive gate
# simply by dropping one label.
recovery_bot_orchestrator_runner_mode() {
  local deployment_json
  if ! deployment_json="$(
    recovery_kubectl get deployment bot-orchestrator -n "$NAMESPACE" -o json
  )"; then
    return 1
  fi
  printf '%s' "$deployment_json" | jq -er --arg namespace "$NAMESPACE" '
    if .apiVersion != "apps/v1" or .kind != "Deployment" or
       .metadata.name != "bot-orchestrator" or .metadata.namespace != $namespace or
       (.spec.template.spec | type) != "object" or
       (.spec.template.spec.containers | type) != "array" or
       ([.spec.template.spec.containers[] | select(.name == "bot-orchestrator")] | length) != 1
    then error("invalid_bot_orchestrator_deployment")
    else
      (.spec.template.spec.containers[] | select(.name == "bot-orchestrator")) as $container |
      ([($container.env // [])[].name] |
        any(. == "BOT_RUNNER_IMAGE" or . == "POD_NAMESPACE" or
            . == "ORCHESTRATOR_POD_NAME" or . == "ORCHESTRATOR_POD_UID" or
            . == "RUNNER_NAMESPACE" or . == "RUNNER_POD_NAMESPACE" or
            . == "RUNNER_CONTROL_URL")) as $environment_binding |
      if .spec.template.spec.serviceAccountName == "bot-orchestrator" or
         .spec.template.spec.automountServiceAccountToken == true or
         $environment_binding
      then "kubernetes-pod" else "process-local" end
    end
  '
}

recovery_runner_namespaces() {
  local runner_namespace="hcce-bot-runners" namespace_json runner_mode
  [[ "${RUNNER_POD_NAMESPACE:-$runner_namespace}" == "$runner_namespace" ]] || return 1
  if ! namespace_json="$(
    recovery_kubectl get namespace "$runner_namespace" --ignore-not-found -o json
  )"; then
    return 1
  fi
  printf '%s\n' "$NAMESPACE"
  [[ "$NAMESPACE" == "$runner_namespace" ]] && return 0
  if [[ -n "$namespace_json" ]]; then
    printf '%s' "$namespace_json" | jq -e --arg namespace "$runner_namespace" '
      .apiVersion == "v1" and .kind == "Namespace" and
      .metadata.name == $namespace and
      (.metadata.uid | type == "string" and length > 0)
    ' >/dev/null || return 1
    printf '%s\n' "$runner_namespace"
    return 0
  fi
  if ! runner_mode="$(recovery_bot_orchestrator_runner_mode)"; then
    return 1
  fi
  [[ "$runner_mode" == "process-local" ]]
}

recovery_managed_bot_runner_pod_names() {
  recovery_managed_bot_runner_pod_identities | cut -f1,2
}

recovery_managed_bot_runner_pod_identities() {
  local pods_json runner_namespace runner_namespaces
  if ! runner_namespaces="$(recovery_runner_namespaces)"; then
    return 1
  fi
  while IFS= read -r runner_namespace; do
    [[ -n "$runner_namespace" ]] || return 1
    if ! pods_json="$(recovery_kubectl get pod -n "$runner_namespace" -o json)"; then
      return 1
    fi
    printf '%s' "$pods_json" | jq -r --arg namespace "$runner_namespace" \
      --arg parent_namespace "$NAMESPACE" '
      if .apiVersion != "v1" or .kind != "PodList" or
         (.metadata.resourceVersion | type) != "string" or .metadata.resourceVersion == "" or
         (.items | type) != "array" or
         any(.items[];
           (.metadata | type) != "object" or
           .metadata.namespace != $namespace or
           (.metadata.name | type) != "string" or .metadata.name == "" or
           (.metadata.uid | type) != "string" or .metadata.uid == "" or
           ((.metadata.labels // {}) | type) != "object" or
           (.spec | type) != "object" or
           ((.spec.serviceAccountName // "") | type) != "string")
      then error("invalid_pod_inventory")
      else
        [.items[]
          | select(
              $namespace != $parent_namespace or
              (.metadata.labels.app // "") == "bot-runner" or
              (.metadata.labels.component // "") == "bot-runner" or
              (.metadata.labels["yenhubs.org/managed-by"] // "") == "bot-orchestrator" or
              ($namespace == $parent_namespace and
                (.spec.serviceAccountName // "") == "bot-orchestrator")
            )
          | [$namespace, "pod/" + .metadata.name, .metadata.uid]
          | @tsv]
        | unique
        | .[]
      end
    ' || return 1
  done <<<"$runner_namespaces"
}

recovery_delete_all_managed_bot_runner_pods_exact() {
  local identities pod_namespace pod_resource pod_name pod_uid delete_status=0
  recovery_require_operation_serialization || return 1
  identities="$(recovery_managed_bot_runner_pod_identities)" || return 1
  [[ -n "$identities" ]] || return 0
  while IFS=$'\t' read -r pod_namespace pod_resource pod_uid; do
    pod_name="${pod_resource#pod/}"
    if [[ "$pod_resource" != "pod/$pod_name" || -z "$pod_name" || -z "$pod_uid" ]]; then
      delete_status=1
      continue
    fi
    if ! recovery_delete_namespaced_with_uid_in_namespace \
      "$pod_namespace" pod "$pod_name" "$pod_uid" 60; then
      delete_status=1
    fi
  done <<<"$identities"
  [[ "$delete_status" == 0 ]]
}

recovery_require_no_managed_bot_runner_pods() {
  local remaining
  if ! remaining="$(recovery_managed_bot_runner_pod_names)"; then
    printf 'Could not inspect managed bot-runner Pods; refusing further mutation.\n' >&2
    return 1
  fi
  if [[ -n "$remaining" ]]; then
    printf 'Managed bot-runner Pods remain during a recovery quiescence window; refusing further mutation.\n' >&2
    return 1
  fi
}

# Every API request is capped at 45 seconds, below the 120-second operation
# Lease. Long readiness/deletion waits are composed from <=40-second requests
# and revalidate Lease ownership between attempts.
recovery_kubectl_wait_bounded() {
  local total_seconds="$1"
  shift
  local remaining="$total_seconds" slice
  local retry_delay="${RECOVERY_WAIT_RETRY_DELAY_SECONDS:-1}"
  [[ "$total_seconds" =~ ^[1-9][0-9]*$ && "$retry_delay" =~ ^[01]$ &&
     "$#" -gt 0 ]] || return 2
  while ((remaining > 0)); do
    slice=40
    ((remaining >= slice)) || slice="$remaining"
    if recovery_kubectl "$@" --timeout="${slice}s" >/dev/null; then
      return 0
    fi
    if [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 1 ]]; then
      recovery_require_operation_serialization || return 1
    fi
    remaining=$((remaining - slice))
    ((retry_delay == 0)) || sleep "$retry_delay"
  done
  return 1
}

recovery_wait_for_deployment_rollout() {
  local deployment_name="$1" timeout_seconds="${2:-300}"
  [[ "$deployment_name" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 2
  recovery_kubectl_wait_bounded "$timeout_seconds" \
    rollout status "deployment/$deployment_name" -n "$NAMESPACE"
}

recovery_wait_for_pod_ready() {
  local pod_name="$1" timeout_seconds="${2:-180}"
  [[ "$pod_name" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 2
  recovery_kubectl_wait_bounded "$timeout_seconds" \
    wait --for=condition=Ready "pod/$pod_name" -n "$NAMESPACE"
}

recovery_wait_for_no_managed_bot_runner_pods() {
  local timeout="${1:-180s}"
  local remaining pod_namespace pod_name
  if [[ ! "$timeout" =~ ^[1-9][0-9]*s$ ]]; then
    printf 'Invalid managed bot-runner wait timeout.\n' >&2
    return 2
  fi
  if ! remaining="$(recovery_managed_bot_runner_pod_names)"; then
    printf 'Could not inspect managed bot-runner Pods before waiting; refusing further mutation.\n' >&2
    return 1
  fi
  [[ -n "$remaining" ]] || return 0
  while IFS=$'\t' read -r pod_namespace pod_name; do
    if [[ ! "$pod_namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
      printf 'Managed bot-runner Pod inventory contains an invalid namespace.\n' >&2
      return 1
    fi
    if [[ ! "$pod_name" =~ ^pod/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]]; then
      printf 'Managed bot-runner Pod inventory contains an invalid name.\n' >&2
      return 1
    fi
    if ! recovery_kubectl_wait_bounded "${timeout%s}" \
      wait --for=delete "$pod_name" -n "$pod_namespace"; then
      printf 'Timed out waiting for managed bot-runner pods to terminate.\n' >&2
      return 1
    fi
  done <<<"$remaining"
  if ! recovery_require_no_managed_bot_runner_pods; then
    printf 'Pods still remain for managed bot-runner after the delete wait.\n' >&2
    return 1
  fi
}

# A destructive window must not rely on polling: a runner can be ADDED and
# DELETED between two LIST calls. The Node watcher performs one complete LIST,
# starts a watch from that List resourceVersion, and records any matching event
# from the union of the two runner labels without writing Kubernetes payloads.
recovery_runner_watch_marker_is_exact() {
  local marker_path="$1" mode
  [[ "$marker_path" == /* && -f "$marker_path" && ! -L "$marker_path" ]] || return 1
  # macOS intentionally exposes /var through the stable /private/var alias,
  # which is also where mktemp creates these process-local capabilities. The
  # watcher itself opens the leaf with O_NOFOLLOW and revalidates its type,
  # mode and bounded size on every access; rejecting the system alias would
  # make every recovery watcher fail before its ready handshake.
  if mode="$(stat -f '%Lp' "$marker_path" 2>/dev/null)"; then
    :
  elif mode="$(stat -c '%a' "$marker_path" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  [[ "$mode" == 600 || "$mode" == 0600 ]]
}

recovery_signal_no_managed_bot_runner_watch_stop() {
  local stop_path="$1"
  local value="${2:-discard}"
  recovery_runner_watch_marker_is_exact "$stop_path" || return 1
  if [[ "$value" == discard ]]; then
    printf 'discard\n' >"$stop_path"
  elif [[ "$value" == \{* && ${#value} -le 2047 ]]; then
    printf '%s\n' "$value" >"$stop_path"
  else
    return 2
  fi
}

recovery_runner_watch_boundary_json() {
  local runner_namespaces runner_namespace pods_json resource_version
  local boundaries='[]'
  runner_namespaces="$(recovery_runner_namespaces)" || return 1
  while IFS= read -r runner_namespace; do
    [[ -n "$runner_namespace" ]] || return 1
    pods_json="$(recovery_kubectl get pod -n "$runner_namespace" -o json)" || return 1
    resource_version="$(printf '%s' "$pods_json" | jq -er \
      --arg namespace "$runner_namespace" --arg parent_namespace "$NAMESPACE" '
      if .apiVersion != "v1" or .kind != "PodList" or
         (.metadata.resourceVersion | type) != "string" or
         .metadata.resourceVersion == "" or (.items | type) != "array" or
         any(.items[];
           (.metadata | type) != "object" or
           .metadata.namespace != $namespace or
           (.metadata.name | type) != "string" or .metadata.name == "" or
           (.metadata.uid | type) != "string" or .metadata.uid == "" or
           ((.metadata.labels // {}) | type) != "object" or
           (.spec | type) != "object" or
           ((.spec.serviceAccountName // "") | type) != "string" or
           $namespace != $parent_namespace or
           (.metadata.labels.app // "") == "bot-runner" or
           (.metadata.labels.component // "") == "bot-runner" or
           (.metadata.labels["yenhubs.org/managed-by"] // "") == "bot-orchestrator" or
           (.spec.serviceAccountName // "") == "bot-orchestrator")
      then error("unsafe_boundary_pod_inventory")
      else .metadata.resourceVersion end
    ')" || return 1
    boundaries="$(jq -cn --argjson current "$boundaries" \
      --arg namespace "$runner_namespace" --arg resource_version "$resource_version" \
      '$current + [{namespace:$namespace,resourceVersion:$resource_version}]')" || return 1
  done <<<"$runner_namespaces"
  jq -cn --argjson boundaries "$boundaries" \
    '{stop:true,boundaries:$boundaries}'
}

recovery_start_no_managed_bot_runner_watch() {
  local stop_path="$1" failure_path="$2" ready_path="$3" pid_variable="$4"
  local watcher_path="$RECOVERY_SAFETY_DIR/../watch-bot-runner-pods.mjs"
  local started_pid="" ready_value="" marker_path runner_namespace="" runner_namespaces="" attempt=0
  local watcher_stable_seconds="" watcher_test_mode=""
  [[ "$pid_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 2
  [[ "$stop_path" != "$failure_path" && "$stop_path" != "$ready_path" &&
     "$failure_path" != "$ready_path" ]] || return 2
  for marker_path in "$stop_path" "$failure_path" "$ready_path"; do
    recovery_runner_watch_marker_is_exact "$marker_path" || return 1
    [[ ! -s "$marker_path" ]] || return 1
  done
  [[ -f "$watcher_path" && ! -L "$watcher_path" ]] || return 1
  [[ -n "${EXPECTED_KUBE_CONTEXT:-}" && -n "${NAMESPACE:-}" ]] || return 1
  if ! runner_namespaces="$(recovery_runner_namespaces)"; then
    return 1
  fi
  runner_namespace="$(printf '%s\n' "$runner_namespaces" | tail -n 1)"
  [[ -n "$runner_namespace" ]] || return 1
  watcher_stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  if [[ "$watcher_stable_seconds" != 61 ]]; then
    watcher_test_mode=local-fixture
  fi
  (
    # Never let ambient fixture variables reach the Node watcher. Re-export
    # them only after the shell has attested the exact local context,
    # namespace UID and PVC UID above.
    unset YENHUBS_RECOVERY_TEST_MODE RECOVERY_TEST_STABLE_ABSENCE_SECONDS
    if [[ "$watcher_test_mode" == local-fixture ]]; then
      export YENHUBS_RECOVERY_TEST_MODE=local-fixture
      export RECOVERY_TEST_STABLE_ABSENCE_SECONDS="$watcher_stable_seconds"
    fi
    exec node "$watcher_path" \
      --context "$EXPECTED_KUBE_CONTEXT" \
      --namespace "$NAMESPACE" \
      --runner-namespace "$runner_namespace" \
      --stop "$stop_path" \
      --failure "$failure_path" \
      --ready "$ready_path"
  ) &
  started_pid=$!
  printf -v "$pid_variable" '%s' "$started_pid"
  while [[ "$attempt" -lt 200 ]]; do
    if [[ -s "$failure_path" ]]; then
      wait "$started_pid" 2>/dev/null || :
      printf -v "$pid_variable" '%s' ""
      printf 'Managed bot-runner event watcher failed before its ready handshake.\n' >&2
      return 1
    fi
    if [[ -s "$ready_path" ]]; then
      ready_value="$(<"$ready_path")"
      if [[ "$ready_value" == ready ]] && kill -0 "$started_pid" 2>/dev/null; then
        return 0
      fi
      break
    fi
    if ! kill -0 "$started_pid" 2>/dev/null; then
      wait "$started_pid" 2>/dev/null || :
      printf -v "$pid_variable" '%s' ""
      printf 'Managed bot-runner event watcher exited before its ready handshake.\n' >&2
      return 1
    fi
    sleep 0.05
    attempt=$((attempt + 1))
  done
  recovery_signal_no_managed_bot_runner_watch_stop "$stop_path" 2>/dev/null || :
  wait "$started_pid" 2>/dev/null || :
  printf -v "$pid_variable" '%s' ""
  printf 'Managed bot-runner event watcher did not complete an exact ready handshake.\n' >&2
  return 1
}

recovery_require_no_managed_bot_runner_watch_healthy() {
  local failure_path="$1" ready_path="$2" watcher_pid="$3"
  local ready_value=""
  recovery_runner_watch_marker_is_exact "$failure_path" || return 1
  recovery_runner_watch_marker_is_exact "$ready_path" || return 1
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && ! -s "$failure_path" ]] || return 1
  ready_value="$(<"$ready_path")"
  [[ "$ready_value" == ready ]] || return 1
  kill -0 "$watcher_pid" 2>/dev/null
}

recovery_stop_no_managed_bot_runner_watch() {
  local stop_path="$1" failure_path="$2" ready_path="$3" watcher_pid="$4"
  local watcher_status=0 ready_value="" boundary_json=""
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  if boundary_json="$(recovery_runner_watch_boundary_json)"; then
    recovery_signal_no_managed_bot_runner_watch_stop \
      "$stop_path" "$boundary_json" || watcher_status=1
  else
    watcher_status=1
    recovery_signal_no_managed_bot_runner_watch_stop "$stop_path" discard || :
  fi
  if ! wait "$watcher_pid"; then watcher_status=1; fi
  recovery_runner_watch_marker_is_exact "$failure_path" || watcher_status=1
  recovery_runner_watch_marker_is_exact "$ready_path" || watcher_status=1
  [[ ! -s "$failure_path" ]] || watcher_status=1
  if [[ -f "$ready_path" ]]; then ready_value="$(<"$ready_path")"; fi
  [[ "$ready_value" == ready ]] || watcher_status=1
  recovery_require_no_managed_bot_runner_pods || watcher_status=1
  [[ "$watcher_status" == 0 ]]
}

recovery_discard_no_managed_bot_runner_watch() {
  local stop_path="$1" watcher_pid="$2"
  if [[ "$watcher_pid" =~ ^[1-9][0-9]*$ ]]; then
    recovery_signal_no_managed_bot_runner_watch_stop "$stop_path" 2>/dev/null || :
    wait "$watcher_pid" 2>/dev/null || :
  fi
}

recovery_wait_for_no_pods() {
  local selector="$1"
  local description="$2"
  local timeout="${3:-180s}"
  local remaining

  remaining="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l "$selector" -o name
  )" || {
    printf 'Could not inspect %s pods before waiting; refusing further mutation.\n' \
      "$description" >&2
    return 1
  }
  if [[ -z "$remaining" ]]; then
    return 0
  fi

  if ! recovery_kubectl_wait_bounded "${timeout%s}" \
    wait --for=delete pod -n "$NAMESPACE" -l "$selector"; then
    printf 'Timed out waiting for %s pods to stop; refusing further mutation.\n' \
      "$description" >&2
    return 1
  fi

  remaining="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l "$selector" -o name
  )" || {
    printf 'Could not verify that %s pods stopped; refusing further mutation.\n' \
      "$description" >&2
    return 1
  }
  if [[ -n "$remaining" ]]; then
    printf 'Pods still remain for %s; refusing further mutation:\n%s\n' \
      "$description" "$remaining" >&2
    return 1
  fi
}

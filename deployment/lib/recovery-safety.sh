#!/usr/bin/env bash

# Shared fail-closed guards for backup and restore commands. Callers must set
# NAMESPACE before invoking recovery_require_cluster_identity.

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
RECOVERY_NAMESPACE_UID=""
RECOVERY_PVC_UID=""
# Coordinated child processes receive the exact lock resourceVersion from the
# parent. Unlike materialized-file capabilities above, this value is not used
# for local cleanup and must survive sourcing in the child so the full lock
# identity can be revalidated against the API object.
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}"

recovery_kubectl() {
  command kubectl --context "$EXPECTED_KUBE_CONTEXT" "$@"
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
  jq -e \
    --arg namespace "$expected_namespace" \
    --arg namespace_uid "$expected_namespace_uid" \
    --argjson expected_images "${expected_images_json:-null}" '
    def expected_deployments:
      ["bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
       "pgbouncer", "pgbouncer-t", "photomnemonic", "pgsql", "reticulum", "spoke"];
    def expected_pairs:
      ["bot-orchestrator/bot-orchestrator", "coturn/coturn", "dialog/dialog",
       "haproxy/haproxy", "hubs/hubs", "nearspark/nearspark", "pgbouncer/pgbouncer",
       "pgbouncer-t/pgbouncer-t", "photomnemonic/photomnemonic", "pgsql/pgsql",
       "reticulum/postgrest", "reticulum/reticulum", "spoke/spoke"];
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
      elif $pair == "pgsql/pgsql" then
        ($repository == "ghcr.io/yengalvez/postgres" or
         $repository == "docker.io/library/postgres" or $repository == "postgres")
      elif $pair == "reticulum/postgrest" then
        ($repository == "ghcr.io/yengalvez/postgrest" or
         $repository == "docker.io/postgrest/postgrest" or
         $repository == "postgrest/postgrest")
      elif $pair == "reticulum/reticulum" then $repository == "ghcr.io/yengalvez/reticulum"
      elif $pair == "spoke/spoke" then $repository == "ghcr.io/yengalvez/spoke"
      else false end;
    .schema_version == 2 and
    .namespace == $namespace and
    .namespace_uid == $namespace_uid and
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

recovery_checkpoint_image_for_pair() {
  local inventory_path="$1"
  local pair="$2"
  local trusted_repository="$3"
  local deployment_name container_name image
  [[ "$pair" == */* && "$trusted_repository" =~ ^[A-Za-z0-9._/-]+$ ]] || return 2
  deployment_name="${pair%%/*}"
  container_name="${pair#*/}"
  recovery_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" || return 1
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

  current_context="$(command kubectl config current-context 2>/dev/null)" || {
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
  recovery_kubectl scale deployment "$deployment_name" -n "$NAMESPACE" \
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

recovery_operation_lock_json_is_exact() {
  local lock_json="$1"
  [[ "${RECOVERY_OPERATION_LOCK_NAME:-}" =~ ^[A-Za-z0-9._-]+$ &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     -n "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" &&
     "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_OWNER:-}" =~ ^[A-Za-z0-9._-]+$ &&
     -n "${RECOVERY_NAMESPACE_UID:-}" && -n "${RECOVERY_PVC_UID:-}" &&
     "${RECOVERY_CHECKPOINT_STAMP:-}" =~ ^[0-9]{8}-[0-9]{6}$ &&
     "${RECOVERY_DUMP_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ &&
     "${RECOVERY_STORAGE_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] || return 1
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
    --arg storage_sha "$RECOVERY_STORAGE_SHA256" '
    .apiVersion == "v1" and
    .kind == "ConfigMap" and
    .metadata.name == $name and
    .metadata.namespace == $namespace and
    .metadata.uid == $uid and
    .metadata.resourceVersion == $resource_version and
    (.metadata.labels // {}) == {"yenhubs.org/recovery-owner":$owner} and
    (.metadata.annotations // {}) == {
      "yenhubs.org/operation-id": $operation_id,
      "yenhubs.org/recovery-token": $token,
      "yenhubs.org/namespace-uid": $namespace_uid,
      "yenhubs.org/pvc-uid": $pvc_uid,
      "yenhubs.org/checkpoint-stamp": $stamp,
      "yenhubs.org/dump-sha256": $dump_sha,
      "yenhubs.org/storage-sha256": $storage_sha
    } and
    .immutable == true and
    (.data // {}) == {} and
    (.binaryData // {}) == {}
  ' >/dev/null 2>&1 <<<"$lock_json"
}

recovery_require_operation_lock() {
  local lock_json
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
  local lock_name="${2:-yenhubs-recovery-operation-lock}"
  local lock_json
  [[ "$owner" =~ ^[A-Za-z0-9._-]+$ && "$lock_name" =~ ^[A-Za-z0-9._-]+$ &&
     -n "${RECOVERY_NAMESPACE_UID:-}" && -n "${RECOVERY_PVC_UID:-}" &&
     "${RECOVERY_CHECKPOINT_STAMP:-}" =~ ^[0-9]{8}-[0-9]{6}$ &&
     "${RECOVERY_DUMP_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ &&
     "${RECOVERY_STORAGE_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] || return 2
  RECOVERY_OPERATION_OWNER="$owner"
  RECOVERY_OPERATION_LOCK_NAME="$lock_name"
  RECOVERY_OPERATION_LOCK_UID=""
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=""
  if ! RECOVERY_OPERATION_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" ||
     [[ ! "$RECOVERY_OPERATION_TOKEN" =~ ^[a-f0-9]{32}$ ]] ||
     ! RECOVERY_OPERATION_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" ||
     [[ ! "$RECOVERY_OPERATION_ID" =~ ^[a-f0-9]{32}$ ]]; then
    printf 'Could not create private recovery-operation identifiers.\n' >&2
    return 1
  fi
  if ! cat <<EOF | recovery_kubectl create -f - >/dev/null
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
  RECOVERY_OPERATION_LOCK_UID="$(jq -er \
    '.metadata.uid | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  export RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    printf 'Created recovery lock does not match its exact operation contract.\n' >&2
    return 1
  fi
}

recovery_release_operation_lock() {
  recovery_require_operation_lock || return 1
  recovery_delete_namespaced_with_uid configmap "$RECOVERY_OPERATION_LOCK_NAME" \
    "$RECOVERY_OPERATION_LOCK_UID" 60
}

recovery_delete_namespaced_with_uid() {
  local kind="$1"
  local name="$2"
  local uid="$3"
  local timeout_seconds="${4:-60}"
  local api_path current_json current_uid started
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ && -n "$uid" &&
     "$timeout_seconds" =~ ^[0-9]+$ && "$timeout_seconds" -gt 0 ]] || return 2
  case "$kind" in
    configmap)
      api_path="/api/v1/namespaces/$NAMESPACE/configmaps/$name"
      ;;
    pod)
      api_path="/api/v1/namespaces/$NAMESPACE/pods/$name"
      ;;
    networkpolicy)
      api_path="/apis/networking.k8s.io/v1/namespaces/$NAMESPACE/networkpolicies/$name"
      ;;
    *)
      return 2
      ;;
  esac
  if ! jq -cn --arg uid "$uid" '{
      apiVersion:"v1", kind:"DeleteOptions",
      propagationPolicy:"Foreground", preconditions:{uid:$uid}
    }' | recovery_kubectl delete --raw="$api_path" -f - >/dev/null; then
    printf 'UID-preconditioned deletion failed for %s/%s.\n' "$kind" "$name" >&2
    return 1
  fi
  started="$SECONDS"
  while ((SECONDS - started < timeout_seconds)); do
    if ! current_json="$(recovery_kubectl get "$kind" "$name" -n "$NAMESPACE" -o json 2>/dev/null)"; then
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

  if ! recovery_kubectl wait --for=delete pod -n "$NAMESPACE" \
    -l "$selector" --timeout="$timeout" >/dev/null; then
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

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

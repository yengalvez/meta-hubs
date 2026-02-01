--
-- PostgreSQL database dump
--

-- Dumped from database version 12.22 (Debian 12.22-1.pgdg120+1)
-- Dumped by pg_dump version 12.22 (Debian 12.22-1.pgdg120+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: coturn; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA coturn;


ALTER SCHEMA coturn OWNER TO postgres;

--
-- Name: ret0; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA ret0;


ALTER SCHEMA ret0 OWNER TO postgres;

--
-- Name: ret0_admin; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA ret0_admin;


ALTER SCHEMA ret0_admin OWNER TO postgres;

--
-- Name: account_state; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.account_state AS ENUM (
    'enabled',
    'disabled'
);


ALTER TYPE ret0.account_state OWNER TO postgres;

--
-- Name: api_scope_type; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.api_scope_type AS ENUM (
    'read_rooms',
    'write_rooms'
);


ALTER TYPE ret0.api_scope_type OWNER TO postgres;

--
-- Name: api_token_subject_type; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.api_token_subject_type AS ENUM (
    'app',
    'account'
);


ALTER TYPE ret0.api_token_subject_type OWNER TO postgres;

--
-- Name: asset_type; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.asset_type AS ENUM (
    'image',
    'video',
    'model',
    'audio'
);


ALTER TYPE ret0.asset_type OWNER TO postgres;

--
-- Name: avatar_listing_state; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.avatar_listing_state AS ENUM (
    'active',
    'delisted',
    'removed'
);


ALTER TYPE ret0.avatar_listing_state OWNER TO postgres;

--
-- Name: hub_binding_type; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.hub_binding_type AS ENUM (
    'discord',
    'slack'
);


ALTER TYPE ret0.hub_binding_type OWNER TO postgres;

--
-- Name: hub_entry_mode; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.hub_entry_mode AS ENUM (
    'allow',
    'invite',
    'deny'
);


ALTER TYPE ret0.hub_entry_mode OWNER TO postgres;

--
-- Name: hub_invite_state; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.hub_invite_state AS ENUM (
    'active',
    'revoked'
);


ALTER TYPE ret0.hub_invite_state OWNER TO postgres;

--
-- Name: oauth_provider_source; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.oauth_provider_source AS ENUM (
    'discord',
    'slack',
    'twitter'
);


ALTER TYPE ret0.oauth_provider_source OWNER TO postgres;

--
-- Name: owned_file_state; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.owned_file_state AS ENUM (
    'active',
    'inactive',
    'removed'
);


ALTER TYPE ret0.owned_file_state OWNER TO postgres;

--
-- Name: scene_listing_state; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.scene_listing_state AS ENUM (
    'active',
    'delisted'
);


ALTER TYPE ret0.scene_listing_state OWNER TO postgres;

--
-- Name: scene_state; Type: TYPE; Schema: ret0; Owner: postgres
--

CREATE TYPE ret0.scene_state AS ENUM (
    'active',
    'removed'
);


ALTER TYPE ret0.scene_state OWNER TO postgres;

--
-- Name: next_id(); Type: FUNCTION; Schema: ret0; Owner: postgres
--

CREATE FUNCTION ret0.next_id(OUT result bigint) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
our_epoch bigint := 1505706041000;
seq_id bigint;
now_millis bigint;
shard_id int := 0;
BEGIN
SELECT nextval('ret0.table_id_seq') % 1024 INTO seq_id;

SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) INTO now_millis;
result := (now_millis - our_epoch) << 23;
result := result | (shard_id << 10);
result := result | (seq_id);
END;
$$;


ALTER FUNCTION ret0.next_id(OUT result bigint) OWNER TO postgres;

--
-- Name: create_or_replace_admin_view(text, text, text); Type: FUNCTION; Schema: ret0_admin; Owner: postgres
--

CREATE FUNCTION ret0_admin.create_or_replace_admin_view(name text, extra_columns text DEFAULT ''::text, extra_clauses text DEFAULT ''::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
pk character varying(255);
begin

-- Get the primary key
SELECT
  pg_attribute.attname into pk
FROM pg_index, pg_class, pg_attribute, pg_namespace
WHERE
  pg_class.oid = ('ret0.' || name)::regclass AND
  indrelid = pg_class.oid AND
  nspname = 'ret0' AND
  pg_class.relnamespace = pg_namespace.oid AND
  pg_attribute.attrelid = pg_class.oid AND
  pg_attribute.attnum = any(pg_index.indkey)
 AND indisprimary;

execute 'create or replace view ret0_admin.' || name
|| ' as (select ' || pk || ' as id, '
|| ' cast(' || pk || ' as varchar) as _text_id, '
|| array_to_string(ARRAY(SELECT 'o' || '.' || c.column_name
        FROM information_schema.columns As c
            WHERE table_name = name AND table_schema = 'ret0'
            AND  c.column_name NOT IN(pk) ORDER BY ordinal_position
    ), ',') || extra_columns ||
				' from ret0.' || name || ' as o ' || extra_clauses || ')';

end

$$;


ALTER FUNCTION ret0_admin.create_or_replace_admin_view(name text, extra_columns text, extra_clauses text) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: allowed_peer_ip; Type: TABLE; Schema: coturn; Owner: postgres
--

CREATE TABLE coturn.allowed_peer_ip (
    realm character varying(127),
    ip_range character varying(256),
    inserted_at timestamp without time zone,
    updated_at timestamp without time zone
);


ALTER TABLE coturn.allowed_peer_ip OWNER TO postgres;

--
-- Name: denied_peer_ip; Type: TABLE; Schema: coturn; Owner: postgres
--

CREATE TABLE coturn.denied_peer_ip (
    realm character varying(127),
    ip_range character varying(256),
    inserted_at timestamp without time zone,
    updated_at timestamp without time zone
);


ALTER TABLE coturn.denied_peer_ip OWNER TO postgres;

--
-- Name: turn_secret; Type: TABLE; Schema: coturn; Owner: postgres
--

CREATE TABLE coturn.turn_secret (
    realm character varying(127),
    value character varying(256),
    inserted_at timestamp without time zone,
    updated_at timestamp without time zone
);


ALTER TABLE coturn.turn_secret OWNER TO postgres;

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.schema_migrations (
    version bigint NOT NULL,
    inserted_at timestamp(0) without time zone
);


ALTER TABLE public.schema_migrations OWNER TO postgres;

--
-- Name: account_favorites; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.account_favorites (
    account_favorite_id bigint DEFAULT ret0.next_id() NOT NULL,
    account_id bigint NOT NULL,
    hub_id bigint,
    last_activated_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.account_favorites OWNER TO postgres;

--
-- Name: accounts; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.accounts (
    account_id bigint DEFAULT ret0.next_id() NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    min_token_issued_at timestamp(0) without time zone DEFAULT '1970-01-01 00:00:00'::timestamp without time zone NOT NULL,
    is_admin boolean,
    state ret0.account_state DEFAULT 'enabled'::ret0.account_state NOT NULL
);


ALTER TABLE ret0.accounts OWNER TO postgres;

--
-- Name: api_credentials; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.api_credentials (
    api_credentials_id bigint DEFAULT ret0.next_id() NOT NULL,
    token_hash character varying(255) NOT NULL,
    api_credentials_sid character varying(255) NOT NULL,
    is_revoked boolean NOT NULL,
    scopes ret0.api_scope_type[] NOT NULL,
    subject_type ret0.api_token_subject_type NOT NULL,
    account_id bigint,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.api_credentials OWNER TO postgres;

--
-- Name: app_configs; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.app_configs (
    app_config_id bigint DEFAULT ret0.next_id() NOT NULL,
    key character varying(255) NOT NULL,
    value jsonb,
    owned_file_id bigint,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.app_configs OWNER TO postgres;

--
-- Name: assets; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.assets (
    asset_id bigint DEFAULT ret0.next_id() NOT NULL,
    asset_sid character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    type ret0.asset_type NOT NULL,
    account_id bigint NOT NULL,
    asset_owned_file_id bigint NOT NULL,
    thumbnail_owned_file_id bigint,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.assets OWNER TO postgres;

--
-- Name: avatar_listings; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.avatar_listings (
    avatar_listing_id bigint DEFAULT ret0.next_id() NOT NULL,
    avatar_listing_sid character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    "order" integer,
    state ret0.avatar_listing_state DEFAULT 'active'::ret0.avatar_listing_state NOT NULL,
    tags jsonb,
    avatar_id bigint,
    name character varying(255) NOT NULL,
    description character varying(255),
    attributions jsonb,
    parent_avatar_listing_id bigint,
    gltf_owned_file_id bigint,
    bin_owned_file_id bigint,
    thumbnail_owned_file_id bigint,
    base_map_owned_file_id bigint,
    emissive_map_owned_file_id bigint,
    normal_map_owned_file_id bigint,
    orm_map_owned_file_id bigint,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    account_id bigint,
    CONSTRAINT avatar_required_for_listed CHECK (((avatar_id IS NOT NULL) OR ((avatar_id IS NULL) AND (state = 'delisted'::ret0.avatar_listing_state))))
);


ALTER TABLE ret0.avatar_listings OWNER TO postgres;

--
-- Name: avatars; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.avatars (
    avatar_id bigint DEFAULT ret0.next_id() NOT NULL,
    avatar_sid character varying(255),
    slug character varying(255) NOT NULL,
    parent_avatar_id bigint,
    name character varying(255),
    description character varying(255),
    attributions jsonb,
    allow_remixing boolean DEFAULT false NOT NULL,
    allow_promotion boolean DEFAULT false NOT NULL,
    account_id bigint NOT NULL,
    gltf_owned_file_id bigint,
    bin_owned_file_id bigint,
    base_map_owned_file_id bigint,
    emissive_map_owned_file_id bigint,
    normal_map_owned_file_id bigint,
    orm_map_owned_file_id bigint,
    state ret0.scene_state DEFAULT 'active'::ret0.scene_state NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    thumbnail_owned_file_id bigint,
    parent_avatar_listing_id bigint,
    reviewed_at timestamp(0) without time zone,
    imported_from_host character varying(255),
    imported_from_port integer,
    imported_from_sid character varying(255),
    CONSTRAINT gltf_or_parent_or_parent_listing CHECK (((parent_avatar_id IS NOT NULL) OR (parent_avatar_listing_id IS NOT NULL) OR ((gltf_owned_file_id IS NOT NULL) AND (bin_owned_file_id IS NOT NULL))))
);


ALTER TABLE ret0.avatars OWNER TO postgres;

--
-- Name: cached_files; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.cached_files (
    cached_file_id bigint DEFAULT ret0.next_id() NOT NULL,
    cache_key character varying(255) NOT NULL,
    file_uuid character varying(255) NOT NULL,
    file_key character varying(255) NOT NULL,
    file_content_type character varying(255) NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    accessed_at timestamp(0) without time zone DEFAULT now() NOT NULL
);


ALTER TABLE ret0.cached_files OWNER TO postgres;

--
-- Name: entities; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.entities (
    entity_id bigint DEFAULT ret0.next_id() NOT NULL,
    nid character varying(255) NOT NULL,
    create_message bytea NOT NULL,
    hub_id bigint NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.entities OWNER TO postgres;

--
-- Name: hub_bindings; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.hub_bindings (
    hub_binding_id bigint DEFAULT ret0.next_id() NOT NULL,
    hub_id bigint NOT NULL,
    type ret0.hub_binding_type NOT NULL,
    community_id character varying(255) NOT NULL,
    channel_id character varying(255) NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.hub_bindings OWNER TO postgres;

--
-- Name: hub_invites; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.hub_invites (
    hub_invite_id bigint DEFAULT ret0.next_id() NOT NULL,
    hub_invite_sid character varying(255) NOT NULL,
    hub_id bigint NOT NULL,
    state ret0.hub_invite_state DEFAULT 'active'::ret0.hub_invite_state NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.hub_invites OWNER TO postgres;

--
-- Name: hub_role_memberships; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.hub_role_memberships (
    hub_role_membership_id bigint DEFAULT ret0.next_id() NOT NULL,
    hub_id bigint,
    account_id bigint NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.hub_role_memberships OWNER TO postgres;

--
-- Name: hubs; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.hubs (
    hub_id bigint DEFAULT ret0.next_id() NOT NULL,
    hub_sid character varying(255),
    slug character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    default_environment_gltf_bundle_url character varying(255),
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    max_occupant_count integer DEFAULT 0 NOT NULL,
    entry_mode ret0.hub_entry_mode DEFAULT 'allow'::ret0.hub_entry_mode NOT NULL,
    spawned_object_types bigint DEFAULT 0 NOT NULL,
    scene_id bigint,
    host character varying(255),
    created_by_account_id bigint,
    scene_listing_id bigint,
    creator_assignment_token character varying(255),
    last_active_at timestamp(0) without time zone,
    embed_token character varying(255),
    embedded boolean DEFAULT false,
    member_permissions integer DEFAULT 255,
    allow_promotion boolean DEFAULT false NOT NULL,
    description character varying(64000),
    room_size integer,
    user_data jsonb
);


ALTER TABLE ret0.hubs OWNER TO postgres;

--
-- Name: identities; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.identities (
    identity_id bigint DEFAULT ret0.next_id() NOT NULL,
    name character varying(255) NOT NULL,
    account_id bigint,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.identities OWNER TO postgres;

--
-- Name: login_tokens; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.login_tokens (
    login_token_id bigint DEFAULT ret0.next_id() NOT NULL,
    token character varying(255),
    identifier_hash character varying(255),
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    payload_key character varying(255)
);


ALTER TABLE ret0.login_tokens OWNER TO postgres;

--
-- Name: logins; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.logins (
    login_id bigint DEFAULT ret0.next_id() NOT NULL,
    identifier_hash character varying(255) NOT NULL,
    account_id bigint,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.logins OWNER TO postgres;

--
-- Name: node_stats; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
)
PARTITION BY RANGE (measured_at);


ALTER TABLE ret0.node_stats OWNER TO postgres;

--
-- Name: node_stats_y2018_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m1 FOR VALUES FROM ('2018-01-01 00:00:00') TO ('2018-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m1 OWNER TO postgres;

--
-- Name: node_stats_y2018_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m10 FOR VALUES FROM ('2018-10-01 00:00:00') TO ('2018-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m10 OWNER TO postgres;

--
-- Name: node_stats_y2018_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m11 FOR VALUES FROM ('2018-11-01 00:00:00') TO ('2018-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m11 OWNER TO postgres;

--
-- Name: node_stats_y2018_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m12 FOR VALUES FROM ('2018-12-01 00:00:00') TO ('2019-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m12 OWNER TO postgres;

--
-- Name: node_stats_y2018_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m2 FOR VALUES FROM ('2018-02-01 00:00:00') TO ('2018-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m2 OWNER TO postgres;

--
-- Name: node_stats_y2018_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m3 FOR VALUES FROM ('2018-03-01 00:00:00') TO ('2018-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m3 OWNER TO postgres;

--
-- Name: node_stats_y2018_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m4 FOR VALUES FROM ('2018-04-01 00:00:00') TO ('2018-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m4 OWNER TO postgres;

--
-- Name: node_stats_y2018_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m5 FOR VALUES FROM ('2018-05-01 00:00:00') TO ('2018-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m5 OWNER TO postgres;

--
-- Name: node_stats_y2018_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m6 FOR VALUES FROM ('2018-06-01 00:00:00') TO ('2018-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m6 OWNER TO postgres;

--
-- Name: node_stats_y2018_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m7 FOR VALUES FROM ('2018-07-01 00:00:00') TO ('2018-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m7 OWNER TO postgres;

--
-- Name: node_stats_y2018_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m8 FOR VALUES FROM ('2018-08-01 00:00:00') TO ('2018-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m8 OWNER TO postgres;

--
-- Name: node_stats_y2018_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2018_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2018_m9 FOR VALUES FROM ('2018-09-01 00:00:00') TO ('2018-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2018_m9 OWNER TO postgres;

--
-- Name: node_stats_y2019_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m1 FOR VALUES FROM ('2019-01-01 00:00:00') TO ('2019-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m1 OWNER TO postgres;

--
-- Name: node_stats_y2019_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m10 FOR VALUES FROM ('2019-10-01 00:00:00') TO ('2019-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m10 OWNER TO postgres;

--
-- Name: node_stats_y2019_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m11 FOR VALUES FROM ('2019-11-01 00:00:00') TO ('2019-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m11 OWNER TO postgres;

--
-- Name: node_stats_y2019_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m12 FOR VALUES FROM ('2019-12-01 00:00:00') TO ('2020-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m12 OWNER TO postgres;

--
-- Name: node_stats_y2019_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m2 FOR VALUES FROM ('2019-02-01 00:00:00') TO ('2019-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m2 OWNER TO postgres;

--
-- Name: node_stats_y2019_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m3 FOR VALUES FROM ('2019-03-01 00:00:00') TO ('2019-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m3 OWNER TO postgres;

--
-- Name: node_stats_y2019_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m4 FOR VALUES FROM ('2019-04-01 00:00:00') TO ('2019-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m4 OWNER TO postgres;

--
-- Name: node_stats_y2019_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m5 FOR VALUES FROM ('2019-05-01 00:00:00') TO ('2019-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m5 OWNER TO postgres;

--
-- Name: node_stats_y2019_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m6 FOR VALUES FROM ('2019-06-01 00:00:00') TO ('2019-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m6 OWNER TO postgres;

--
-- Name: node_stats_y2019_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m7 FOR VALUES FROM ('2019-07-01 00:00:00') TO ('2019-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m7 OWNER TO postgres;

--
-- Name: node_stats_y2019_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m8 FOR VALUES FROM ('2019-08-01 00:00:00') TO ('2019-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m8 OWNER TO postgres;

--
-- Name: node_stats_y2019_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2019_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2019_m9 FOR VALUES FROM ('2019-09-01 00:00:00') TO ('2019-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2019_m9 OWNER TO postgres;

--
-- Name: node_stats_y2020_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m1 FOR VALUES FROM ('2020-01-01 00:00:00') TO ('2020-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m1 OWNER TO postgres;

--
-- Name: node_stats_y2020_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m10 FOR VALUES FROM ('2020-10-01 00:00:00') TO ('2020-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m10 OWNER TO postgres;

--
-- Name: node_stats_y2020_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m11 FOR VALUES FROM ('2020-11-01 00:00:00') TO ('2020-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m11 OWNER TO postgres;

--
-- Name: node_stats_y2020_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m12 FOR VALUES FROM ('2020-12-01 00:00:00') TO ('2021-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m12 OWNER TO postgres;

--
-- Name: node_stats_y2020_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m2 FOR VALUES FROM ('2020-02-01 00:00:00') TO ('2020-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m2 OWNER TO postgres;

--
-- Name: node_stats_y2020_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m3 FOR VALUES FROM ('2020-03-01 00:00:00') TO ('2020-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m3 OWNER TO postgres;

--
-- Name: node_stats_y2020_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m4 FOR VALUES FROM ('2020-04-01 00:00:00') TO ('2020-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m4 OWNER TO postgres;

--
-- Name: node_stats_y2020_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m5 FOR VALUES FROM ('2020-05-01 00:00:00') TO ('2020-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m5 OWNER TO postgres;

--
-- Name: node_stats_y2020_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m6 FOR VALUES FROM ('2020-06-01 00:00:00') TO ('2020-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m6 OWNER TO postgres;

--
-- Name: node_stats_y2020_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m7 FOR VALUES FROM ('2020-07-01 00:00:00') TO ('2020-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m7 OWNER TO postgres;

--
-- Name: node_stats_y2020_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m8 FOR VALUES FROM ('2020-08-01 00:00:00') TO ('2020-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m8 OWNER TO postgres;

--
-- Name: node_stats_y2020_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2020_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2020_m9 FOR VALUES FROM ('2020-09-01 00:00:00') TO ('2020-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2020_m9 OWNER TO postgres;

--
-- Name: node_stats_y2021_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m1 FOR VALUES FROM ('2021-01-01 00:00:00') TO ('2021-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m1 OWNER TO postgres;

--
-- Name: node_stats_y2021_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m10 FOR VALUES FROM ('2021-10-01 00:00:00') TO ('2021-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m10 OWNER TO postgres;

--
-- Name: node_stats_y2021_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m11 FOR VALUES FROM ('2021-11-01 00:00:00') TO ('2021-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m11 OWNER TO postgres;

--
-- Name: node_stats_y2021_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m12 FOR VALUES FROM ('2021-12-01 00:00:00') TO ('2022-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m12 OWNER TO postgres;

--
-- Name: node_stats_y2021_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m2 FOR VALUES FROM ('2021-02-01 00:00:00') TO ('2021-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m2 OWNER TO postgres;

--
-- Name: node_stats_y2021_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m3 FOR VALUES FROM ('2021-03-01 00:00:00') TO ('2021-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m3 OWNER TO postgres;

--
-- Name: node_stats_y2021_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m4 FOR VALUES FROM ('2021-04-01 00:00:00') TO ('2021-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m4 OWNER TO postgres;

--
-- Name: node_stats_y2021_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m5 FOR VALUES FROM ('2021-05-01 00:00:00') TO ('2021-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m5 OWNER TO postgres;

--
-- Name: node_stats_y2021_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m6 FOR VALUES FROM ('2021-06-01 00:00:00') TO ('2021-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m6 OWNER TO postgres;

--
-- Name: node_stats_y2021_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m7 FOR VALUES FROM ('2021-07-01 00:00:00') TO ('2021-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m7 OWNER TO postgres;

--
-- Name: node_stats_y2021_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m8 FOR VALUES FROM ('2021-08-01 00:00:00') TO ('2021-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m8 OWNER TO postgres;

--
-- Name: node_stats_y2021_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2021_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2021_m9 FOR VALUES FROM ('2021-09-01 00:00:00') TO ('2021-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2021_m9 OWNER TO postgres;

--
-- Name: node_stats_y2022_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m1 FOR VALUES FROM ('2022-01-01 00:00:00') TO ('2022-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m1 OWNER TO postgres;

--
-- Name: node_stats_y2022_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m10 FOR VALUES FROM ('2022-10-01 00:00:00') TO ('2022-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m10 OWNER TO postgres;

--
-- Name: node_stats_y2022_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m11 FOR VALUES FROM ('2022-11-01 00:00:00') TO ('2022-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m11 OWNER TO postgres;

--
-- Name: node_stats_y2022_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m12 FOR VALUES FROM ('2022-12-01 00:00:00') TO ('2023-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m12 OWNER TO postgres;

--
-- Name: node_stats_y2022_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m2 FOR VALUES FROM ('2022-02-01 00:00:00') TO ('2022-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m2 OWNER TO postgres;

--
-- Name: node_stats_y2022_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m3 FOR VALUES FROM ('2022-03-01 00:00:00') TO ('2022-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m3 OWNER TO postgres;

--
-- Name: node_stats_y2022_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m4 FOR VALUES FROM ('2022-04-01 00:00:00') TO ('2022-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m4 OWNER TO postgres;

--
-- Name: node_stats_y2022_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m5 FOR VALUES FROM ('2022-05-01 00:00:00') TO ('2022-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m5 OWNER TO postgres;

--
-- Name: node_stats_y2022_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m6 FOR VALUES FROM ('2022-06-01 00:00:00') TO ('2022-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m6 OWNER TO postgres;

--
-- Name: node_stats_y2022_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m7 FOR VALUES FROM ('2022-07-01 00:00:00') TO ('2022-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m7 OWNER TO postgres;

--
-- Name: node_stats_y2022_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m8 FOR VALUES FROM ('2022-08-01 00:00:00') TO ('2022-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m8 OWNER TO postgres;

--
-- Name: node_stats_y2022_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2022_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2022_m9 FOR VALUES FROM ('2022-09-01 00:00:00') TO ('2022-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2022_m9 OWNER TO postgres;

--
-- Name: node_stats_y2023_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m1 FOR VALUES FROM ('2023-01-01 00:00:00') TO ('2023-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m1 OWNER TO postgres;

--
-- Name: node_stats_y2023_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m10 FOR VALUES FROM ('2023-10-01 00:00:00') TO ('2023-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m10 OWNER TO postgres;

--
-- Name: node_stats_y2023_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m11 FOR VALUES FROM ('2023-11-01 00:00:00') TO ('2023-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m11 OWNER TO postgres;

--
-- Name: node_stats_y2023_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m12 FOR VALUES FROM ('2023-12-01 00:00:00') TO ('2024-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m12 OWNER TO postgres;

--
-- Name: node_stats_y2023_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m2 FOR VALUES FROM ('2023-02-01 00:00:00') TO ('2023-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m2 OWNER TO postgres;

--
-- Name: node_stats_y2023_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m3 FOR VALUES FROM ('2023-03-01 00:00:00') TO ('2023-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m3 OWNER TO postgres;

--
-- Name: node_stats_y2023_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m4 FOR VALUES FROM ('2023-04-01 00:00:00') TO ('2023-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m4 OWNER TO postgres;

--
-- Name: node_stats_y2023_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m5 FOR VALUES FROM ('2023-05-01 00:00:00') TO ('2023-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m5 OWNER TO postgres;

--
-- Name: node_stats_y2023_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m6 FOR VALUES FROM ('2023-06-01 00:00:00') TO ('2023-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m6 OWNER TO postgres;

--
-- Name: node_stats_y2023_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m7 FOR VALUES FROM ('2023-07-01 00:00:00') TO ('2023-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m7 OWNER TO postgres;

--
-- Name: node_stats_y2023_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m8 FOR VALUES FROM ('2023-08-01 00:00:00') TO ('2023-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m8 OWNER TO postgres;

--
-- Name: node_stats_y2023_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2023_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2023_m9 FOR VALUES FROM ('2023-09-01 00:00:00') TO ('2023-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2023_m9 OWNER TO postgres;

--
-- Name: node_stats_y2024_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m1 FOR VALUES FROM ('2024-01-01 00:00:00') TO ('2024-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m1 OWNER TO postgres;

--
-- Name: node_stats_y2024_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m10 FOR VALUES FROM ('2024-10-01 00:00:00') TO ('2024-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m10 OWNER TO postgres;

--
-- Name: node_stats_y2024_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m11 FOR VALUES FROM ('2024-11-01 00:00:00') TO ('2024-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m11 OWNER TO postgres;

--
-- Name: node_stats_y2024_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m12 FOR VALUES FROM ('2024-12-01 00:00:00') TO ('2025-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m12 OWNER TO postgres;

--
-- Name: node_stats_y2024_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m2 FOR VALUES FROM ('2024-02-01 00:00:00') TO ('2024-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m2 OWNER TO postgres;

--
-- Name: node_stats_y2024_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m3 FOR VALUES FROM ('2024-03-01 00:00:00') TO ('2024-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m3 OWNER TO postgres;

--
-- Name: node_stats_y2024_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m4 FOR VALUES FROM ('2024-04-01 00:00:00') TO ('2024-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m4 OWNER TO postgres;

--
-- Name: node_stats_y2024_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m5 FOR VALUES FROM ('2024-05-01 00:00:00') TO ('2024-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m5 OWNER TO postgres;

--
-- Name: node_stats_y2024_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m6 FOR VALUES FROM ('2024-06-01 00:00:00') TO ('2024-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m6 OWNER TO postgres;

--
-- Name: node_stats_y2024_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m7 FOR VALUES FROM ('2024-07-01 00:00:00') TO ('2024-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m7 OWNER TO postgres;

--
-- Name: node_stats_y2024_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m8 FOR VALUES FROM ('2024-08-01 00:00:00') TO ('2024-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m8 OWNER TO postgres;

--
-- Name: node_stats_y2024_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2024_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2024_m9 FOR VALUES FROM ('2024-09-01 00:00:00') TO ('2024-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2024_m9 OWNER TO postgres;

--
-- Name: node_stats_y2025_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m1 FOR VALUES FROM ('2025-01-01 00:00:00') TO ('2025-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m1 OWNER TO postgres;

--
-- Name: node_stats_y2025_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m10 FOR VALUES FROM ('2025-10-01 00:00:00') TO ('2025-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m10 OWNER TO postgres;

--
-- Name: node_stats_y2025_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m11 FOR VALUES FROM ('2025-11-01 00:00:00') TO ('2025-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m11 OWNER TO postgres;

--
-- Name: node_stats_y2025_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m12 FOR VALUES FROM ('2025-12-01 00:00:00') TO ('2026-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m12 OWNER TO postgres;

--
-- Name: node_stats_y2025_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m2 FOR VALUES FROM ('2025-02-01 00:00:00') TO ('2025-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m2 OWNER TO postgres;

--
-- Name: node_stats_y2025_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m3 FOR VALUES FROM ('2025-03-01 00:00:00') TO ('2025-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m3 OWNER TO postgres;

--
-- Name: node_stats_y2025_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m4 FOR VALUES FROM ('2025-04-01 00:00:00') TO ('2025-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m4 OWNER TO postgres;

--
-- Name: node_stats_y2025_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m5 FOR VALUES FROM ('2025-05-01 00:00:00') TO ('2025-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m5 OWNER TO postgres;

--
-- Name: node_stats_y2025_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m6 FOR VALUES FROM ('2025-06-01 00:00:00') TO ('2025-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m6 OWNER TO postgres;

--
-- Name: node_stats_y2025_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m7 FOR VALUES FROM ('2025-07-01 00:00:00') TO ('2025-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m7 OWNER TO postgres;

--
-- Name: node_stats_y2025_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m8 FOR VALUES FROM ('2025-08-01 00:00:00') TO ('2025-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m8 OWNER TO postgres;

--
-- Name: node_stats_y2025_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2025_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2025_m9 FOR VALUES FROM ('2025-09-01 00:00:00') TO ('2025-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2025_m9 OWNER TO postgres;

--
-- Name: node_stats_y2026_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m1 FOR VALUES FROM ('2026-01-01 00:00:00') TO ('2026-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m1 OWNER TO postgres;

--
-- Name: node_stats_y2026_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m10 FOR VALUES FROM ('2026-10-01 00:00:00') TO ('2026-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m10 OWNER TO postgres;

--
-- Name: node_stats_y2026_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m11 FOR VALUES FROM ('2026-11-01 00:00:00') TO ('2026-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m11 OWNER TO postgres;

--
-- Name: node_stats_y2026_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m12 FOR VALUES FROM ('2026-12-01 00:00:00') TO ('2027-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m12 OWNER TO postgres;

--
-- Name: node_stats_y2026_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m2 FOR VALUES FROM ('2026-02-01 00:00:00') TO ('2026-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m2 OWNER TO postgres;

--
-- Name: node_stats_y2026_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m3 FOR VALUES FROM ('2026-03-01 00:00:00') TO ('2026-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m3 OWNER TO postgres;

--
-- Name: node_stats_y2026_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m4 FOR VALUES FROM ('2026-04-01 00:00:00') TO ('2026-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m4 OWNER TO postgres;

--
-- Name: node_stats_y2026_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m5 FOR VALUES FROM ('2026-05-01 00:00:00') TO ('2026-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m5 OWNER TO postgres;

--
-- Name: node_stats_y2026_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m6 FOR VALUES FROM ('2026-06-01 00:00:00') TO ('2026-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m6 OWNER TO postgres;

--
-- Name: node_stats_y2026_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m7 FOR VALUES FROM ('2026-07-01 00:00:00') TO ('2026-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m7 OWNER TO postgres;

--
-- Name: node_stats_y2026_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m8 FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m8 OWNER TO postgres;

--
-- Name: node_stats_y2026_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2026_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2026_m9 FOR VALUES FROM ('2026-09-01 00:00:00') TO ('2026-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2026_m9 OWNER TO postgres;

--
-- Name: node_stats_y2027_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m1 FOR VALUES FROM ('2027-01-01 00:00:00') TO ('2027-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m1 OWNER TO postgres;

--
-- Name: node_stats_y2027_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m10 FOR VALUES FROM ('2027-10-01 00:00:00') TO ('2027-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m10 OWNER TO postgres;

--
-- Name: node_stats_y2027_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m11 FOR VALUES FROM ('2027-11-01 00:00:00') TO ('2027-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m11 OWNER TO postgres;

--
-- Name: node_stats_y2027_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m12 FOR VALUES FROM ('2027-12-01 00:00:00') TO ('2028-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m12 OWNER TO postgres;

--
-- Name: node_stats_y2027_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m2 FOR VALUES FROM ('2027-02-01 00:00:00') TO ('2027-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m2 OWNER TO postgres;

--
-- Name: node_stats_y2027_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m3 FOR VALUES FROM ('2027-03-01 00:00:00') TO ('2027-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m3 OWNER TO postgres;

--
-- Name: node_stats_y2027_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m4 FOR VALUES FROM ('2027-04-01 00:00:00') TO ('2027-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m4 OWNER TO postgres;

--
-- Name: node_stats_y2027_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m5 FOR VALUES FROM ('2027-05-01 00:00:00') TO ('2027-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m5 OWNER TO postgres;

--
-- Name: node_stats_y2027_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m6 FOR VALUES FROM ('2027-06-01 00:00:00') TO ('2027-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m6 OWNER TO postgres;

--
-- Name: node_stats_y2027_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m7 FOR VALUES FROM ('2027-07-01 00:00:00') TO ('2027-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m7 OWNER TO postgres;

--
-- Name: node_stats_y2027_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m8 FOR VALUES FROM ('2027-08-01 00:00:00') TO ('2027-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m8 OWNER TO postgres;

--
-- Name: node_stats_y2027_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2027_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2027_m9 FOR VALUES FROM ('2027-09-01 00:00:00') TO ('2027-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2027_m9 OWNER TO postgres;

--
-- Name: node_stats_y2028_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m1 FOR VALUES FROM ('2028-01-01 00:00:00') TO ('2028-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m1 OWNER TO postgres;

--
-- Name: node_stats_y2028_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m10 FOR VALUES FROM ('2028-10-01 00:00:00') TO ('2028-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m10 OWNER TO postgres;

--
-- Name: node_stats_y2028_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m11 FOR VALUES FROM ('2028-11-01 00:00:00') TO ('2028-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m11 OWNER TO postgres;

--
-- Name: node_stats_y2028_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m12 FOR VALUES FROM ('2028-12-01 00:00:00') TO ('2029-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m12 OWNER TO postgres;

--
-- Name: node_stats_y2028_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m2 FOR VALUES FROM ('2028-02-01 00:00:00') TO ('2028-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m2 OWNER TO postgres;

--
-- Name: node_stats_y2028_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m3 FOR VALUES FROM ('2028-03-01 00:00:00') TO ('2028-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m3 OWNER TO postgres;

--
-- Name: node_stats_y2028_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m4 FOR VALUES FROM ('2028-04-01 00:00:00') TO ('2028-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m4 OWNER TO postgres;

--
-- Name: node_stats_y2028_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m5 FOR VALUES FROM ('2028-05-01 00:00:00') TO ('2028-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m5 OWNER TO postgres;

--
-- Name: node_stats_y2028_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m6 FOR VALUES FROM ('2028-06-01 00:00:00') TO ('2028-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m6 OWNER TO postgres;

--
-- Name: node_stats_y2028_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m7 FOR VALUES FROM ('2028-07-01 00:00:00') TO ('2028-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m7 OWNER TO postgres;

--
-- Name: node_stats_y2028_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m8 FOR VALUES FROM ('2028-08-01 00:00:00') TO ('2028-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m8 OWNER TO postgres;

--
-- Name: node_stats_y2028_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2028_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2028_m9 FOR VALUES FROM ('2028-09-01 00:00:00') TO ('2028-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2028_m9 OWNER TO postgres;

--
-- Name: node_stats_y2029_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m1 FOR VALUES FROM ('2029-01-01 00:00:00') TO ('2029-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m1 OWNER TO postgres;

--
-- Name: node_stats_y2029_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m10 FOR VALUES FROM ('2029-10-01 00:00:00') TO ('2029-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m10 OWNER TO postgres;

--
-- Name: node_stats_y2029_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m11 FOR VALUES FROM ('2029-11-01 00:00:00') TO ('2029-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m11 OWNER TO postgres;

--
-- Name: node_stats_y2029_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m12 FOR VALUES FROM ('2029-12-01 00:00:00') TO ('2030-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m12 OWNER TO postgres;

--
-- Name: node_stats_y2029_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m2 FOR VALUES FROM ('2029-02-01 00:00:00') TO ('2029-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m2 OWNER TO postgres;

--
-- Name: node_stats_y2029_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m3 FOR VALUES FROM ('2029-03-01 00:00:00') TO ('2029-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m3 OWNER TO postgres;

--
-- Name: node_stats_y2029_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m4 FOR VALUES FROM ('2029-04-01 00:00:00') TO ('2029-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m4 OWNER TO postgres;

--
-- Name: node_stats_y2029_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m5 FOR VALUES FROM ('2029-05-01 00:00:00') TO ('2029-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m5 OWNER TO postgres;

--
-- Name: node_stats_y2029_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m6 FOR VALUES FROM ('2029-06-01 00:00:00') TO ('2029-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m6 OWNER TO postgres;

--
-- Name: node_stats_y2029_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m7 FOR VALUES FROM ('2029-07-01 00:00:00') TO ('2029-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m7 OWNER TO postgres;

--
-- Name: node_stats_y2029_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m8 FOR VALUES FROM ('2029-08-01 00:00:00') TO ('2029-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m8 OWNER TO postgres;

--
-- Name: node_stats_y2029_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2029_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2029_m9 FOR VALUES FROM ('2029-09-01 00:00:00') TO ('2029-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2029_m9 OWNER TO postgres;

--
-- Name: node_stats_y2030_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m1 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m1 FOR VALUES FROM ('2030-01-01 00:00:00') TO ('2030-02-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m1 OWNER TO postgres;

--
-- Name: node_stats_y2030_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m10 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m10 FOR VALUES FROM ('2030-10-01 00:00:00') TO ('2030-11-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m10 OWNER TO postgres;

--
-- Name: node_stats_y2030_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m11 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m11 FOR VALUES FROM ('2030-11-01 00:00:00') TO ('2030-12-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m11 OWNER TO postgres;

--
-- Name: node_stats_y2030_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m12 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m12 FOR VALUES FROM ('2030-12-01 00:00:00') TO ('2031-01-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m12 OWNER TO postgres;

--
-- Name: node_stats_y2030_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m2 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m2 FOR VALUES FROM ('2030-02-01 00:00:00') TO ('2030-03-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m2 OWNER TO postgres;

--
-- Name: node_stats_y2030_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m3 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m3 FOR VALUES FROM ('2030-03-01 00:00:00') TO ('2030-04-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m3 OWNER TO postgres;

--
-- Name: node_stats_y2030_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m4 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m4 FOR VALUES FROM ('2030-04-01 00:00:00') TO ('2030-05-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m4 OWNER TO postgres;

--
-- Name: node_stats_y2030_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m5 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m5 FOR VALUES FROM ('2030-05-01 00:00:00') TO ('2030-06-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m5 OWNER TO postgres;

--
-- Name: node_stats_y2030_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m6 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m6 FOR VALUES FROM ('2030-06-01 00:00:00') TO ('2030-07-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m6 OWNER TO postgres;

--
-- Name: node_stats_y2030_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m7 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m7 FOR VALUES FROM ('2030-07-01 00:00:00') TO ('2030-08-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m7 OWNER TO postgres;

--
-- Name: node_stats_y2030_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m8 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m8 FOR VALUES FROM ('2030-08-01 00:00:00') TO ('2030-09-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m8 OWNER TO postgres;

--
-- Name: node_stats_y2030_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.node_stats_y2030_m9 (
    node_id character varying(255) NOT NULL,
    measured_at timestamp(0) without time zone NOT NULL,
    present_sessions integer,
    present_rooms integer
);
ALTER TABLE ONLY ret0.node_stats ATTACH PARTITION ret0.node_stats_y2030_m9 FOR VALUES FROM ('2030-09-01 00:00:00') TO ('2030-10-01 00:00:00');


ALTER TABLE ret0.node_stats_y2030_m9 OWNER TO postgres;

--
-- Name: oauth_providers; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.oauth_providers (
    oauth_provider_id bigint DEFAULT ret0.next_id() NOT NULL,
    account_id bigint NOT NULL,
    source ret0.oauth_provider_source NOT NULL,
    provider_account_id character varying(255) NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    provider_access_token bytea,
    provider_access_token_secret bytea
);


ALTER TABLE ret0.oauth_providers OWNER TO postgres;

--
-- Name: owned_files; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.owned_files (
    owned_file_id bigint DEFAULT ret0.next_id() NOT NULL,
    owned_file_uuid character varying(255) NOT NULL,
    key character varying(255) NOT NULL,
    account_id bigint NOT NULL,
    content_type character varying(255) NOT NULL,
    content_length bigint NOT NULL,
    state ret0.owned_file_state DEFAULT 'active'::ret0.owned_file_state NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.owned_files OWNER TO postgres;

--
-- Name: project_assets; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.project_assets (
    project_asset_id bigint DEFAULT ret0.next_id() NOT NULL,
    project_id bigint NOT NULL,
    asset_id bigint NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.project_assets OWNER TO postgres;

--
-- Name: projects; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.projects (
    project_id bigint DEFAULT ret0.next_id() NOT NULL,
    project_sid character varying(255),
    name character varying(255) NOT NULL,
    created_by_account_id bigint NOT NULL,
    project_owned_file_id bigint,
    thumbnail_owned_file_id bigint,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    scene_id bigint,
    parent_scene_id bigint,
    parent_scene_listing_id bigint
);


ALTER TABLE ret0.projects OWNER TO postgres;

--
-- Name: room_objects; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.room_objects (
    room_object_id bigint DEFAULT ret0.next_id() NOT NULL,
    object_id character varying(255) NOT NULL,
    hub_id bigint NOT NULL,
    gltf_node bytea NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    account_id bigint,
    CONSTRAINT room_object_is_legacy_or_has_account CHECK (((inserted_at < '2026-01-31 22:57:42.523108'::timestamp without time zone) OR (account_id IS NOT NULL)))
);


ALTER TABLE ret0.room_objects OWNER TO postgres;

--
-- Name: scene_listings; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.scene_listings (
    scene_listing_id bigint DEFAULT ret0.next_id() NOT NULL,
    scene_listing_sid character varying(255),
    scene_id bigint NOT NULL,
    slug character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255),
    attributions jsonb,
    tags jsonb,
    model_owned_file_id bigint NOT NULL,
    scene_owned_file_id bigint,
    screenshot_owned_file_id bigint NOT NULL,
    "order" integer,
    state ret0.scene_listing_state DEFAULT 'active'::ret0.scene_listing_state NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.scene_listings OWNER TO postgres;

--
-- Name: scenes; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.scenes (
    scene_id bigint DEFAULT ret0.next_id() NOT NULL,
    scene_sid character varying(255),
    slug character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255),
    account_id bigint NOT NULL,
    model_owned_file_id bigint NOT NULL,
    screenshot_owned_file_id bigint NOT NULL,
    state ret0.scene_state DEFAULT 'active'::ret0.scene_state NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    attribution character varying(2048),
    allow_remixing boolean DEFAULT false NOT NULL,
    allow_promotion boolean DEFAULT false NOT NULL,
    scene_owned_file_id bigint,
    attributions jsonb,
    reviewed_at timestamp(0) without time zone,
    imported_from_host character varying(255),
    imported_from_port integer,
    imported_from_sid character varying(255),
    parent_scene_id bigint,
    parent_scene_listing_id bigint
);


ALTER TABLE ret0.scenes OWNER TO postgres;

--
-- Name: schema_migrations; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.schema_migrations (
    version bigint NOT NULL,
    inserted_at timestamp(0) without time zone
);


ALTER TABLE ret0.schema_migrations OWNER TO postgres;

--
-- Name: session_stats; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
)
PARTITION BY RANGE (started_at);


ALTER TABLE ret0.session_stats OWNER TO postgres;

--
-- Name: session_stats_y2018_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m1 FOR VALUES FROM ('2018-01-01 00:00:00') TO ('2018-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m1 OWNER TO postgres;

--
-- Name: session_stats_y2018_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m10 FOR VALUES FROM ('2018-10-01 00:00:00') TO ('2018-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m10 OWNER TO postgres;

--
-- Name: session_stats_y2018_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m11 FOR VALUES FROM ('2018-11-01 00:00:00') TO ('2018-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m11 OWNER TO postgres;

--
-- Name: session_stats_y2018_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m12 FOR VALUES FROM ('2018-12-01 00:00:00') TO ('2019-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m12 OWNER TO postgres;

--
-- Name: session_stats_y2018_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m2 FOR VALUES FROM ('2018-02-01 00:00:00') TO ('2018-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m2 OWNER TO postgres;

--
-- Name: session_stats_y2018_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m3 FOR VALUES FROM ('2018-03-01 00:00:00') TO ('2018-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m3 OWNER TO postgres;

--
-- Name: session_stats_y2018_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m4 FOR VALUES FROM ('2018-04-01 00:00:00') TO ('2018-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m4 OWNER TO postgres;

--
-- Name: session_stats_y2018_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m5 FOR VALUES FROM ('2018-05-01 00:00:00') TO ('2018-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m5 OWNER TO postgres;

--
-- Name: session_stats_y2018_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m6 FOR VALUES FROM ('2018-06-01 00:00:00') TO ('2018-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m6 OWNER TO postgres;

--
-- Name: session_stats_y2018_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m7 FOR VALUES FROM ('2018-07-01 00:00:00') TO ('2018-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m7 OWNER TO postgres;

--
-- Name: session_stats_y2018_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m8 FOR VALUES FROM ('2018-08-01 00:00:00') TO ('2018-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m8 OWNER TO postgres;

--
-- Name: session_stats_y2018_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2018_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2018_m9 FOR VALUES FROM ('2018-09-01 00:00:00') TO ('2018-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2018_m9 OWNER TO postgres;

--
-- Name: session_stats_y2019_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m1 FOR VALUES FROM ('2019-01-01 00:00:00') TO ('2019-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m1 OWNER TO postgres;

--
-- Name: session_stats_y2019_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m10 FOR VALUES FROM ('2019-10-01 00:00:00') TO ('2019-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m10 OWNER TO postgres;

--
-- Name: session_stats_y2019_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m11 FOR VALUES FROM ('2019-11-01 00:00:00') TO ('2019-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m11 OWNER TO postgres;

--
-- Name: session_stats_y2019_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m12 FOR VALUES FROM ('2019-12-01 00:00:00') TO ('2020-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m12 OWNER TO postgres;

--
-- Name: session_stats_y2019_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m2 FOR VALUES FROM ('2019-02-01 00:00:00') TO ('2019-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m2 OWNER TO postgres;

--
-- Name: session_stats_y2019_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m3 FOR VALUES FROM ('2019-03-01 00:00:00') TO ('2019-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m3 OWNER TO postgres;

--
-- Name: session_stats_y2019_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m4 FOR VALUES FROM ('2019-04-01 00:00:00') TO ('2019-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m4 OWNER TO postgres;

--
-- Name: session_stats_y2019_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m5 FOR VALUES FROM ('2019-05-01 00:00:00') TO ('2019-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m5 OWNER TO postgres;

--
-- Name: session_stats_y2019_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m6 FOR VALUES FROM ('2019-06-01 00:00:00') TO ('2019-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m6 OWNER TO postgres;

--
-- Name: session_stats_y2019_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m7 FOR VALUES FROM ('2019-07-01 00:00:00') TO ('2019-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m7 OWNER TO postgres;

--
-- Name: session_stats_y2019_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m8 FOR VALUES FROM ('2019-08-01 00:00:00') TO ('2019-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m8 OWNER TO postgres;

--
-- Name: session_stats_y2019_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2019_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2019_m9 FOR VALUES FROM ('2019-09-01 00:00:00') TO ('2019-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2019_m9 OWNER TO postgres;

--
-- Name: session_stats_y2020_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m1 FOR VALUES FROM ('2020-01-01 00:00:00') TO ('2020-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m1 OWNER TO postgres;

--
-- Name: session_stats_y2020_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m10 FOR VALUES FROM ('2020-10-01 00:00:00') TO ('2020-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m10 OWNER TO postgres;

--
-- Name: session_stats_y2020_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m11 FOR VALUES FROM ('2020-11-01 00:00:00') TO ('2020-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m11 OWNER TO postgres;

--
-- Name: session_stats_y2020_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m12 FOR VALUES FROM ('2020-12-01 00:00:00') TO ('2021-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m12 OWNER TO postgres;

--
-- Name: session_stats_y2020_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m2 FOR VALUES FROM ('2020-02-01 00:00:00') TO ('2020-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m2 OWNER TO postgres;

--
-- Name: session_stats_y2020_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m3 FOR VALUES FROM ('2020-03-01 00:00:00') TO ('2020-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m3 OWNER TO postgres;

--
-- Name: session_stats_y2020_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m4 FOR VALUES FROM ('2020-04-01 00:00:00') TO ('2020-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m4 OWNER TO postgres;

--
-- Name: session_stats_y2020_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m5 FOR VALUES FROM ('2020-05-01 00:00:00') TO ('2020-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m5 OWNER TO postgres;

--
-- Name: session_stats_y2020_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m6 FOR VALUES FROM ('2020-06-01 00:00:00') TO ('2020-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m6 OWNER TO postgres;

--
-- Name: session_stats_y2020_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m7 FOR VALUES FROM ('2020-07-01 00:00:00') TO ('2020-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m7 OWNER TO postgres;

--
-- Name: session_stats_y2020_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m8 FOR VALUES FROM ('2020-08-01 00:00:00') TO ('2020-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m8 OWNER TO postgres;

--
-- Name: session_stats_y2020_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2020_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2020_m9 FOR VALUES FROM ('2020-09-01 00:00:00') TO ('2020-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2020_m9 OWNER TO postgres;

--
-- Name: session_stats_y2021_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m1 FOR VALUES FROM ('2021-01-01 00:00:00') TO ('2021-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m1 OWNER TO postgres;

--
-- Name: session_stats_y2021_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m10 FOR VALUES FROM ('2021-10-01 00:00:00') TO ('2021-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m10 OWNER TO postgres;

--
-- Name: session_stats_y2021_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m11 FOR VALUES FROM ('2021-11-01 00:00:00') TO ('2021-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m11 OWNER TO postgres;

--
-- Name: session_stats_y2021_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m12 FOR VALUES FROM ('2021-12-01 00:00:00') TO ('2022-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m12 OWNER TO postgres;

--
-- Name: session_stats_y2021_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m2 FOR VALUES FROM ('2021-02-01 00:00:00') TO ('2021-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m2 OWNER TO postgres;

--
-- Name: session_stats_y2021_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m3 FOR VALUES FROM ('2021-03-01 00:00:00') TO ('2021-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m3 OWNER TO postgres;

--
-- Name: session_stats_y2021_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m4 FOR VALUES FROM ('2021-04-01 00:00:00') TO ('2021-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m4 OWNER TO postgres;

--
-- Name: session_stats_y2021_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m5 FOR VALUES FROM ('2021-05-01 00:00:00') TO ('2021-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m5 OWNER TO postgres;

--
-- Name: session_stats_y2021_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m6 FOR VALUES FROM ('2021-06-01 00:00:00') TO ('2021-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m6 OWNER TO postgres;

--
-- Name: session_stats_y2021_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m7 FOR VALUES FROM ('2021-07-01 00:00:00') TO ('2021-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m7 OWNER TO postgres;

--
-- Name: session_stats_y2021_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m8 FOR VALUES FROM ('2021-08-01 00:00:00') TO ('2021-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m8 OWNER TO postgres;

--
-- Name: session_stats_y2021_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2021_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2021_m9 FOR VALUES FROM ('2021-09-01 00:00:00') TO ('2021-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2021_m9 OWNER TO postgres;

--
-- Name: session_stats_y2022_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m1 FOR VALUES FROM ('2022-01-01 00:00:00') TO ('2022-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m1 OWNER TO postgres;

--
-- Name: session_stats_y2022_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m10 FOR VALUES FROM ('2022-10-01 00:00:00') TO ('2022-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m10 OWNER TO postgres;

--
-- Name: session_stats_y2022_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m11 FOR VALUES FROM ('2022-11-01 00:00:00') TO ('2022-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m11 OWNER TO postgres;

--
-- Name: session_stats_y2022_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m12 FOR VALUES FROM ('2022-12-01 00:00:00') TO ('2023-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m12 OWNER TO postgres;

--
-- Name: session_stats_y2022_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m2 FOR VALUES FROM ('2022-02-01 00:00:00') TO ('2022-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m2 OWNER TO postgres;

--
-- Name: session_stats_y2022_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m3 FOR VALUES FROM ('2022-03-01 00:00:00') TO ('2022-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m3 OWNER TO postgres;

--
-- Name: session_stats_y2022_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m4 FOR VALUES FROM ('2022-04-01 00:00:00') TO ('2022-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m4 OWNER TO postgres;

--
-- Name: session_stats_y2022_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m5 FOR VALUES FROM ('2022-05-01 00:00:00') TO ('2022-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m5 OWNER TO postgres;

--
-- Name: session_stats_y2022_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m6 FOR VALUES FROM ('2022-06-01 00:00:00') TO ('2022-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m6 OWNER TO postgres;

--
-- Name: session_stats_y2022_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m7 FOR VALUES FROM ('2022-07-01 00:00:00') TO ('2022-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m7 OWNER TO postgres;

--
-- Name: session_stats_y2022_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m8 FOR VALUES FROM ('2022-08-01 00:00:00') TO ('2022-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m8 OWNER TO postgres;

--
-- Name: session_stats_y2022_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2022_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2022_m9 FOR VALUES FROM ('2022-09-01 00:00:00') TO ('2022-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2022_m9 OWNER TO postgres;

--
-- Name: session_stats_y2023_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m1 FOR VALUES FROM ('2023-01-01 00:00:00') TO ('2023-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m1 OWNER TO postgres;

--
-- Name: session_stats_y2023_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m10 FOR VALUES FROM ('2023-10-01 00:00:00') TO ('2023-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m10 OWNER TO postgres;

--
-- Name: session_stats_y2023_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m11 FOR VALUES FROM ('2023-11-01 00:00:00') TO ('2023-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m11 OWNER TO postgres;

--
-- Name: session_stats_y2023_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m12 FOR VALUES FROM ('2023-12-01 00:00:00') TO ('2024-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m12 OWNER TO postgres;

--
-- Name: session_stats_y2023_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m2 FOR VALUES FROM ('2023-02-01 00:00:00') TO ('2023-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m2 OWNER TO postgres;

--
-- Name: session_stats_y2023_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m3 FOR VALUES FROM ('2023-03-01 00:00:00') TO ('2023-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m3 OWNER TO postgres;

--
-- Name: session_stats_y2023_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m4 FOR VALUES FROM ('2023-04-01 00:00:00') TO ('2023-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m4 OWNER TO postgres;

--
-- Name: session_stats_y2023_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m5 FOR VALUES FROM ('2023-05-01 00:00:00') TO ('2023-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m5 OWNER TO postgres;

--
-- Name: session_stats_y2023_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m6 FOR VALUES FROM ('2023-06-01 00:00:00') TO ('2023-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m6 OWNER TO postgres;

--
-- Name: session_stats_y2023_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m7 FOR VALUES FROM ('2023-07-01 00:00:00') TO ('2023-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m7 OWNER TO postgres;

--
-- Name: session_stats_y2023_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m8 FOR VALUES FROM ('2023-08-01 00:00:00') TO ('2023-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m8 OWNER TO postgres;

--
-- Name: session_stats_y2023_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2023_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2023_m9 FOR VALUES FROM ('2023-09-01 00:00:00') TO ('2023-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2023_m9 OWNER TO postgres;

--
-- Name: session_stats_y2024_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m1 FOR VALUES FROM ('2024-01-01 00:00:00') TO ('2024-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m1 OWNER TO postgres;

--
-- Name: session_stats_y2024_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m10 FOR VALUES FROM ('2024-10-01 00:00:00') TO ('2024-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m10 OWNER TO postgres;

--
-- Name: session_stats_y2024_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m11 FOR VALUES FROM ('2024-11-01 00:00:00') TO ('2024-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m11 OWNER TO postgres;

--
-- Name: session_stats_y2024_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m12 FOR VALUES FROM ('2024-12-01 00:00:00') TO ('2025-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m12 OWNER TO postgres;

--
-- Name: session_stats_y2024_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m2 FOR VALUES FROM ('2024-02-01 00:00:00') TO ('2024-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m2 OWNER TO postgres;

--
-- Name: session_stats_y2024_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m3 FOR VALUES FROM ('2024-03-01 00:00:00') TO ('2024-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m3 OWNER TO postgres;

--
-- Name: session_stats_y2024_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m4 FOR VALUES FROM ('2024-04-01 00:00:00') TO ('2024-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m4 OWNER TO postgres;

--
-- Name: session_stats_y2024_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m5 FOR VALUES FROM ('2024-05-01 00:00:00') TO ('2024-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m5 OWNER TO postgres;

--
-- Name: session_stats_y2024_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m6 FOR VALUES FROM ('2024-06-01 00:00:00') TO ('2024-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m6 OWNER TO postgres;

--
-- Name: session_stats_y2024_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m7 FOR VALUES FROM ('2024-07-01 00:00:00') TO ('2024-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m7 OWNER TO postgres;

--
-- Name: session_stats_y2024_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m8 FOR VALUES FROM ('2024-08-01 00:00:00') TO ('2024-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m8 OWNER TO postgres;

--
-- Name: session_stats_y2024_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2024_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2024_m9 FOR VALUES FROM ('2024-09-01 00:00:00') TO ('2024-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2024_m9 OWNER TO postgres;

--
-- Name: session_stats_y2025_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m1 FOR VALUES FROM ('2025-01-01 00:00:00') TO ('2025-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m1 OWNER TO postgres;

--
-- Name: session_stats_y2025_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m10 FOR VALUES FROM ('2025-10-01 00:00:00') TO ('2025-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m10 OWNER TO postgres;

--
-- Name: session_stats_y2025_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m11 FOR VALUES FROM ('2025-11-01 00:00:00') TO ('2025-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m11 OWNER TO postgres;

--
-- Name: session_stats_y2025_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m12 FOR VALUES FROM ('2025-12-01 00:00:00') TO ('2026-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m12 OWNER TO postgres;

--
-- Name: session_stats_y2025_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m2 FOR VALUES FROM ('2025-02-01 00:00:00') TO ('2025-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m2 OWNER TO postgres;

--
-- Name: session_stats_y2025_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m3 FOR VALUES FROM ('2025-03-01 00:00:00') TO ('2025-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m3 OWNER TO postgres;

--
-- Name: session_stats_y2025_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m4 FOR VALUES FROM ('2025-04-01 00:00:00') TO ('2025-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m4 OWNER TO postgres;

--
-- Name: session_stats_y2025_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m5 FOR VALUES FROM ('2025-05-01 00:00:00') TO ('2025-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m5 OWNER TO postgres;

--
-- Name: session_stats_y2025_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m6 FOR VALUES FROM ('2025-06-01 00:00:00') TO ('2025-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m6 OWNER TO postgres;

--
-- Name: session_stats_y2025_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m7 FOR VALUES FROM ('2025-07-01 00:00:00') TO ('2025-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m7 OWNER TO postgres;

--
-- Name: session_stats_y2025_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m8 FOR VALUES FROM ('2025-08-01 00:00:00') TO ('2025-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m8 OWNER TO postgres;

--
-- Name: session_stats_y2025_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2025_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2025_m9 FOR VALUES FROM ('2025-09-01 00:00:00') TO ('2025-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2025_m9 OWNER TO postgres;

--
-- Name: session_stats_y2026_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m1 FOR VALUES FROM ('2026-01-01 00:00:00') TO ('2026-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m1 OWNER TO postgres;

--
-- Name: session_stats_y2026_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m10 FOR VALUES FROM ('2026-10-01 00:00:00') TO ('2026-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m10 OWNER TO postgres;

--
-- Name: session_stats_y2026_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m11 FOR VALUES FROM ('2026-11-01 00:00:00') TO ('2026-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m11 OWNER TO postgres;

--
-- Name: session_stats_y2026_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m12 FOR VALUES FROM ('2026-12-01 00:00:00') TO ('2027-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m12 OWNER TO postgres;

--
-- Name: session_stats_y2026_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m2 FOR VALUES FROM ('2026-02-01 00:00:00') TO ('2026-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m2 OWNER TO postgres;

--
-- Name: session_stats_y2026_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m3 FOR VALUES FROM ('2026-03-01 00:00:00') TO ('2026-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m3 OWNER TO postgres;

--
-- Name: session_stats_y2026_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m4 FOR VALUES FROM ('2026-04-01 00:00:00') TO ('2026-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m4 OWNER TO postgres;

--
-- Name: session_stats_y2026_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m5 FOR VALUES FROM ('2026-05-01 00:00:00') TO ('2026-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m5 OWNER TO postgres;

--
-- Name: session_stats_y2026_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m6 FOR VALUES FROM ('2026-06-01 00:00:00') TO ('2026-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m6 OWNER TO postgres;

--
-- Name: session_stats_y2026_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m7 FOR VALUES FROM ('2026-07-01 00:00:00') TO ('2026-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m7 OWNER TO postgres;

--
-- Name: session_stats_y2026_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m8 FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m8 OWNER TO postgres;

--
-- Name: session_stats_y2026_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2026_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2026_m9 FOR VALUES FROM ('2026-09-01 00:00:00') TO ('2026-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2026_m9 OWNER TO postgres;

--
-- Name: session_stats_y2027_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m1 FOR VALUES FROM ('2027-01-01 00:00:00') TO ('2027-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m1 OWNER TO postgres;

--
-- Name: session_stats_y2027_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m10 FOR VALUES FROM ('2027-10-01 00:00:00') TO ('2027-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m10 OWNER TO postgres;

--
-- Name: session_stats_y2027_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m11 FOR VALUES FROM ('2027-11-01 00:00:00') TO ('2027-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m11 OWNER TO postgres;

--
-- Name: session_stats_y2027_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m12 FOR VALUES FROM ('2027-12-01 00:00:00') TO ('2028-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m12 OWNER TO postgres;

--
-- Name: session_stats_y2027_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m2 FOR VALUES FROM ('2027-02-01 00:00:00') TO ('2027-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m2 OWNER TO postgres;

--
-- Name: session_stats_y2027_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m3 FOR VALUES FROM ('2027-03-01 00:00:00') TO ('2027-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m3 OWNER TO postgres;

--
-- Name: session_stats_y2027_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m4 FOR VALUES FROM ('2027-04-01 00:00:00') TO ('2027-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m4 OWNER TO postgres;

--
-- Name: session_stats_y2027_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m5 FOR VALUES FROM ('2027-05-01 00:00:00') TO ('2027-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m5 OWNER TO postgres;

--
-- Name: session_stats_y2027_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m6 FOR VALUES FROM ('2027-06-01 00:00:00') TO ('2027-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m6 OWNER TO postgres;

--
-- Name: session_stats_y2027_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m7 FOR VALUES FROM ('2027-07-01 00:00:00') TO ('2027-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m7 OWNER TO postgres;

--
-- Name: session_stats_y2027_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m8 FOR VALUES FROM ('2027-08-01 00:00:00') TO ('2027-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m8 OWNER TO postgres;

--
-- Name: session_stats_y2027_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2027_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2027_m9 FOR VALUES FROM ('2027-09-01 00:00:00') TO ('2027-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2027_m9 OWNER TO postgres;

--
-- Name: session_stats_y2028_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m1 FOR VALUES FROM ('2028-01-01 00:00:00') TO ('2028-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m1 OWNER TO postgres;

--
-- Name: session_stats_y2028_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m10 FOR VALUES FROM ('2028-10-01 00:00:00') TO ('2028-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m10 OWNER TO postgres;

--
-- Name: session_stats_y2028_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m11 FOR VALUES FROM ('2028-11-01 00:00:00') TO ('2028-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m11 OWNER TO postgres;

--
-- Name: session_stats_y2028_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m12 FOR VALUES FROM ('2028-12-01 00:00:00') TO ('2029-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m12 OWNER TO postgres;

--
-- Name: session_stats_y2028_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m2 FOR VALUES FROM ('2028-02-01 00:00:00') TO ('2028-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m2 OWNER TO postgres;

--
-- Name: session_stats_y2028_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m3 FOR VALUES FROM ('2028-03-01 00:00:00') TO ('2028-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m3 OWNER TO postgres;

--
-- Name: session_stats_y2028_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m4 FOR VALUES FROM ('2028-04-01 00:00:00') TO ('2028-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m4 OWNER TO postgres;

--
-- Name: session_stats_y2028_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m5 FOR VALUES FROM ('2028-05-01 00:00:00') TO ('2028-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m5 OWNER TO postgres;

--
-- Name: session_stats_y2028_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m6 FOR VALUES FROM ('2028-06-01 00:00:00') TO ('2028-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m6 OWNER TO postgres;

--
-- Name: session_stats_y2028_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m7 FOR VALUES FROM ('2028-07-01 00:00:00') TO ('2028-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m7 OWNER TO postgres;

--
-- Name: session_stats_y2028_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m8 FOR VALUES FROM ('2028-08-01 00:00:00') TO ('2028-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m8 OWNER TO postgres;

--
-- Name: session_stats_y2028_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2028_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2028_m9 FOR VALUES FROM ('2028-09-01 00:00:00') TO ('2028-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2028_m9 OWNER TO postgres;

--
-- Name: session_stats_y2029_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m1 FOR VALUES FROM ('2029-01-01 00:00:00') TO ('2029-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m1 OWNER TO postgres;

--
-- Name: session_stats_y2029_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m10 FOR VALUES FROM ('2029-10-01 00:00:00') TO ('2029-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m10 OWNER TO postgres;

--
-- Name: session_stats_y2029_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m11 FOR VALUES FROM ('2029-11-01 00:00:00') TO ('2029-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m11 OWNER TO postgres;

--
-- Name: session_stats_y2029_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m12 FOR VALUES FROM ('2029-12-01 00:00:00') TO ('2030-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m12 OWNER TO postgres;

--
-- Name: session_stats_y2029_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m2 FOR VALUES FROM ('2029-02-01 00:00:00') TO ('2029-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m2 OWNER TO postgres;

--
-- Name: session_stats_y2029_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m3 FOR VALUES FROM ('2029-03-01 00:00:00') TO ('2029-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m3 OWNER TO postgres;

--
-- Name: session_stats_y2029_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m4 FOR VALUES FROM ('2029-04-01 00:00:00') TO ('2029-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m4 OWNER TO postgres;

--
-- Name: session_stats_y2029_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m5 FOR VALUES FROM ('2029-05-01 00:00:00') TO ('2029-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m5 OWNER TO postgres;

--
-- Name: session_stats_y2029_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m6 FOR VALUES FROM ('2029-06-01 00:00:00') TO ('2029-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m6 OWNER TO postgres;

--
-- Name: session_stats_y2029_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m7 FOR VALUES FROM ('2029-07-01 00:00:00') TO ('2029-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m7 OWNER TO postgres;

--
-- Name: session_stats_y2029_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m8 FOR VALUES FROM ('2029-08-01 00:00:00') TO ('2029-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m8 OWNER TO postgres;

--
-- Name: session_stats_y2029_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2029_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2029_m9 FOR VALUES FROM ('2029-09-01 00:00:00') TO ('2029-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2029_m9 OWNER TO postgres;

--
-- Name: session_stats_y2030_m1; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m1 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m1 FOR VALUES FROM ('2030-01-01 00:00:00') TO ('2030-02-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m1 OWNER TO postgres;

--
-- Name: session_stats_y2030_m10; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m10 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m10 FOR VALUES FROM ('2030-10-01 00:00:00') TO ('2030-11-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m10 OWNER TO postgres;

--
-- Name: session_stats_y2030_m11; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m11 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m11 FOR VALUES FROM ('2030-11-01 00:00:00') TO ('2030-12-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m11 OWNER TO postgres;

--
-- Name: session_stats_y2030_m12; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m12 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m12 FOR VALUES FROM ('2030-12-01 00:00:00') TO ('2031-01-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m12 OWNER TO postgres;

--
-- Name: session_stats_y2030_m2; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m2 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m2 FOR VALUES FROM ('2030-02-01 00:00:00') TO ('2030-03-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m2 OWNER TO postgres;

--
-- Name: session_stats_y2030_m3; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m3 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m3 FOR VALUES FROM ('2030-03-01 00:00:00') TO ('2030-04-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m3 OWNER TO postgres;

--
-- Name: session_stats_y2030_m4; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m4 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m4 FOR VALUES FROM ('2030-04-01 00:00:00') TO ('2030-05-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m4 OWNER TO postgres;

--
-- Name: session_stats_y2030_m5; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m5 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m5 FOR VALUES FROM ('2030-05-01 00:00:00') TO ('2030-06-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m5 OWNER TO postgres;

--
-- Name: session_stats_y2030_m6; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m6 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m6 FOR VALUES FROM ('2030-06-01 00:00:00') TO ('2030-07-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m6 OWNER TO postgres;

--
-- Name: session_stats_y2030_m7; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m7 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m7 FOR VALUES FROM ('2030-07-01 00:00:00') TO ('2030-08-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m7 OWNER TO postgres;

--
-- Name: session_stats_y2030_m8; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m8 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m8 FOR VALUES FROM ('2030-08-01 00:00:00') TO ('2030-09-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m8 OWNER TO postgres;

--
-- Name: session_stats_y2030_m9; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.session_stats_y2030_m9 (
    session_id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone,
    entered_event_payload jsonb,
    entered_event_received_at timestamp(0) without time zone
);
ALTER TABLE ONLY ret0.session_stats ATTACH PARTITION ret0.session_stats_y2030_m9 FOR VALUES FROM ('2030-09-01 00:00:00') TO ('2030-10-01 00:00:00');


ALTER TABLE ret0.session_stats_y2030_m9 OWNER TO postgres;

--
-- Name: sub_entities; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.sub_entities (
    sub_entity_id bigint DEFAULT ret0.next_id() NOT NULL,
    nid character varying(255) NOT NULL,
    update_message bytea NOT NULL,
    hub_id bigint NOT NULL,
    entity_id bigint NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.sub_entities OWNER TO postgres;

--
-- Name: support_subscriptions; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.support_subscriptions (
    support_subscription_id bigint DEFAULT ret0.next_id() NOT NULL,
    channel character varying(255) NOT NULL,
    identifier character varying(255) NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.support_subscriptions OWNER TO postgres;

--
-- Name: table_id_seq; Type: SEQUENCE; Schema: ret0; Owner: postgres
--

CREATE SEQUENCE ret0.table_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ret0.table_id_seq OWNER TO postgres;

--
-- Name: web_push_subscriptions; Type: TABLE; Schema: ret0; Owner: postgres
--

CREATE TABLE ret0.web_push_subscriptions (
    web_push_subscription_id bigint DEFAULT ret0.next_id() NOT NULL,
    p256dh character varying(255) NOT NULL,
    endpoint character varying(255) NOT NULL,
    auth bytea NOT NULL,
    hub_id bigint NOT NULL,
    last_notified_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE ret0.web_push_subscriptions OWNER TO postgres;

--
-- Name: accounts; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.accounts AS
 SELECT o.account_id AS id,
    (o.account_id)::character varying AS _text_id,
    o.inserted_at,
    o.updated_at,
    o.min_token_issued_at,
    o.is_admin,
    o.state
   FROM ret0.accounts o;


ALTER TABLE ret0_admin.accounts OWNER TO postgres;

--
-- Name: avatar_listings; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.avatar_listings AS
 SELECT o.avatar_listing_id AS id,
    (o.avatar_listing_id)::character varying AS _text_id,
    o.avatar_listing_sid,
    o.slug,
    o."order",
    o.state,
    o.tags,
    o.avatar_id,
    o.name,
    o.description,
    o.attributions,
    o.parent_avatar_listing_id,
    o.gltf_owned_file_id,
    o.bin_owned_file_id,
    o.thumbnail_owned_file_id,
    o.base_map_owned_file_id,
    o.emissive_map_owned_file_id,
    o.normal_map_owned_file_id,
    o.orm_map_owned_file_id,
    o.inserted_at,
    o.updated_at,
    o.account_id,
    (o.avatar_id)::character varying AS _avatar_id
   FROM ret0.avatar_listings o;


ALTER TABLE ret0_admin.avatar_listings OWNER TO postgres;

--
-- Name: avatars; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.avatars AS
 SELECT o.avatar_id AS id,
    (o.avatar_id)::character varying AS _text_id,
    o.avatar_sid,
    o.slug,
    o.parent_avatar_id,
    o.name,
    o.description,
    o.attributions,
    o.allow_remixing,
    o.allow_promotion,
    o.account_id,
    o.gltf_owned_file_id,
    o.bin_owned_file_id,
    o.base_map_owned_file_id,
    o.emissive_map_owned_file_id,
    o.normal_map_owned_file_id,
    o.orm_map_owned_file_id,
    o.state,
    o.inserted_at,
    o.updated_at,
    o.thumbnail_owned_file_id,
    o.parent_avatar_listing_id,
    o.reviewed_at
   FROM ret0.avatars o;


ALTER TABLE ret0_admin.avatars OWNER TO postgres;

--
-- Name: featured_avatar_listings; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.featured_avatar_listings AS
 SELECT avatar_listings.id,
    avatar_listings.avatar_listing_sid,
    avatar_listings.slug,
    avatar_listings.name,
    avatar_listings.description,
    avatar_listings.thumbnail_owned_file_id,
    avatar_listings.base_map_owned_file_id,
    avatar_listings.emissive_map_owned_file_id,
    avatar_listings.normal_map_owned_file_id,
    avatar_listings.orm_map_owned_file_id,
    avatar_listings.attributions,
    avatar_listings."order",
    avatar_listings.updated_at,
    avatar_listings.tags,
    avatar_listings.gltf_owned_file_id,
    avatar_listings.bin_owned_file_id,
    avatar_listings.parent_avatar_listing_id
   FROM ret0_admin.avatar_listings
  WHERE ((avatar_listings.state = 'active'::ret0.avatar_listing_state) AND ((avatar_listings.tags -> 'tags'::text) ? 'featured'::text) AND (EXISTS ( SELECT s.id
           FROM ret0_admin.avatars s
          WHERE ((s.id = avatar_listings.avatar_id) AND (s.state = 'active'::ret0.scene_state) AND s.allow_promotion))));


ALTER TABLE ret0_admin.featured_avatar_listings OWNER TO postgres;

--
-- Name: scene_listings; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.scene_listings AS
 SELECT o.scene_listing_id AS id,
    (o.scene_listing_id)::character varying AS _text_id,
    o.scene_listing_sid,
    o.scene_id,
    o.slug,
    o.name,
    o.description,
    o.attributions,
    o.tags,
    o.model_owned_file_id,
    o.scene_owned_file_id,
    o.screenshot_owned_file_id,
    o."order",
    o.state,
    o.inserted_at,
    o.updated_at,
    (o.scene_id)::character varying AS _scene_id
   FROM ret0.scene_listings o;


ALTER TABLE ret0_admin.scene_listings OWNER TO postgres;

--
-- Name: scenes; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.scenes AS
 SELECT o.scene_id AS id,
    (o.scene_id)::character varying AS _text_id,
    o.scene_sid,
    o.slug,
    o.name,
    o.description,
    o.account_id,
    o.model_owned_file_id,
    o.screenshot_owned_file_id,
    o.state,
    o.inserted_at,
    o.updated_at,
    o.attribution,
    o.allow_remixing,
    o.allow_promotion,
    o.scene_owned_file_id,
    o.attributions,
    o.reviewed_at
   FROM ret0.scenes o;


ALTER TABLE ret0_admin.scenes OWNER TO postgres;

--
-- Name: featured_scene_listings; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.featured_scene_listings AS
 SELECT scene_listings.id,
    scene_listings.scene_listing_sid,
    scene_listings.slug,
    scene_listings.name,
    scene_listings.description,
    scene_listings.screenshot_owned_file_id,
    scene_listings.model_owned_file_id,
    scene_listings.scene_owned_file_id,
    scene_listings.attributions,
    scene_listings."order",
    scene_listings.tags
   FROM ret0_admin.scene_listings
  WHERE ((scene_listings.state = 'active'::ret0.scene_listing_state) AND ((scene_listings.tags -> 'tags'::text) ? 'featured'::text) AND (EXISTS ( SELECT s.id
           FROM ret0_admin.scenes s
          WHERE ((s.id = scene_listings.scene_id) AND (s.state = 'active'::ret0.scene_state) AND s.allow_promotion))));


ALTER TABLE ret0_admin.featured_scene_listings OWNER TO postgres;

--
-- Name: identities; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.identities AS
 SELECT o.identity_id AS id,
    (o.identity_id)::character varying AS _text_id,
    o.name,
    o.account_id,
    o.inserted_at,
    o.updated_at,
    (o.account_id)::character varying AS _account_id
   FROM ret0.identities o;


ALTER TABLE ret0_admin.identities OWNER TO postgres;

--
-- Name: owned_files; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.owned_files AS
 SELECT o.owned_file_id AS id,
    (o.owned_file_id)::character varying AS _text_id,
    o.owned_file_uuid,
    o.key,
    o.account_id,
    o.content_type,
    o.content_length,
    o.state,
    o.inserted_at,
    o.updated_at
   FROM ret0.owned_files o;


ALTER TABLE ret0_admin.owned_files OWNER TO postgres;

--
-- Name: pending_avatars; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.pending_avatars AS
 SELECT avatars.id,
    avatars.avatar_sid,
    avatars.slug,
    avatars.name,
    avatars.description,
    avatars.thumbnail_owned_file_id,
    avatars.base_map_owned_file_id,
    avatars.emissive_map_owned_file_id,
    avatars.normal_map_owned_file_id,
    avatars.orm_map_owned_file_id,
    avatars.attributions,
    avatar_listings.id AS avatar_listing_id,
    avatars.updated_at,
    avatars.allow_remixing,
    avatars.allow_promotion,
    avatars.gltf_owned_file_id,
    avatars.bin_owned_file_id,
    avatars.parent_avatar_listing_id
   FROM (ret0_admin.avatars
     LEFT JOIN ret0_admin.avatar_listings ON ((avatar_listings.avatar_id = avatars.id)))
  WHERE (((avatars.reviewed_at IS NULL) OR (avatars.reviewed_at < avatars.updated_at)) AND avatars.allow_promotion AND (avatars.state = 'active'::ret0.scene_state));


ALTER TABLE ret0_admin.pending_avatars OWNER TO postgres;

--
-- Name: pending_scenes; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.pending_scenes AS
 SELECT scenes.id,
    scenes.scene_sid,
    scenes.slug,
    scenes.name,
    scenes.description,
    scenes.screenshot_owned_file_id,
    scenes.model_owned_file_id,
    scenes.scene_owned_file_id,
    scenes.attributions,
    scene_listings.id AS scene_listing_id,
    scenes.updated_at,
    scenes.allow_remixing AS _allow_remixing,
    scenes.allow_promotion AS _allow_promotion
   FROM (ret0_admin.scenes
     LEFT JOIN ret0_admin.scene_listings ON ((scene_listings.scene_id = scenes.id)))
  WHERE (((scenes.reviewed_at IS NULL) OR (scenes.reviewed_at < scenes.updated_at)) AND scenes.allow_promotion AND (scenes.state = 'active'::ret0.scene_state));


ALTER TABLE ret0_admin.pending_scenes OWNER TO postgres;

--
-- Name: projects; Type: VIEW; Schema: ret0_admin; Owner: postgres
--

CREATE VIEW ret0_admin.projects AS
 SELECT o.project_id AS id,
    (o.project_id)::character varying AS _text_id,
    o.project_sid,
    o.name,
    o.created_by_account_id,
    o.project_owned_file_id,
    o.thumbnail_owned_file_id,
    o.inserted_at,
    o.updated_at
   FROM ret0.projects o;


ALTER TABLE ret0_admin.projects OWNER TO postgres;

--
-- Data for Name: allowed_peer_ip; Type: TABLE DATA; Schema: coturn; Owner: postgres
--

COPY coturn.allowed_peer_ip (realm, ip_range, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: denied_peer_ip; Type: TABLE DATA; Schema: coturn; Owner: postgres
--

COPY coturn.denied_peer_ip (realm, ip_range, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: turn_secret; Type: TABLE DATA; Schema: coturn; Owner: postgres
--

COPY coturn.turn_secret (realm, value, inserted_at, updated_at) FROM stdin;
turkey	11eca9e308da4bb9d81d031e846ba4f1	2026-02-01 00:16:43.050901	2026-02-01 00:16:43.050901
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.schema_migrations (version, inserted_at) FROM stdin;
\.


--
-- Data for Name: account_favorites; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.account_favorites (account_favorite_id, account_id, hub_id, last_activated_at, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: accounts; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.accounts (account_id, inserted_at, updated_at, min_token_issued_at, is_admin, state) FROM stdin;
2216239147784339457	2026-01-31 23:32:15	2026-01-31 23:32:15	2026-01-31 23:55:56	t	enabled
\.


--
-- Data for Name: api_credentials; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.api_credentials (api_credentials_id, token_hash, api_credentials_sid, is_revoked, scopes, subject_type, account_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: app_configs; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.app_configs (app_config_id, key, value, owned_file_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: assets; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.assets (asset_id, asset_sid, name, type, account_id, asset_owned_file_id, thumbnail_owned_file_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: avatar_listings; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.avatar_listings (avatar_listing_id, avatar_listing_sid, slug, "order", state, tags, avatar_id, name, description, attributions, parent_avatar_listing_id, gltf_owned_file_id, bin_owned_file_id, thumbnail_owned_file_id, base_map_owned_file_id, emissive_map_owned_file_id, normal_map_owned_file_id, orm_map_owned_file_id, inserted_at, updated_at, account_id) FROM stdin;
\.


--
-- Data for Name: avatars; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.avatars (avatar_id, avatar_sid, slug, parent_avatar_id, name, description, attributions, allow_remixing, allow_promotion, account_id, gltf_owned_file_id, bin_owned_file_id, base_map_owned_file_id, emissive_map_owned_file_id, normal_map_owned_file_id, orm_map_owned_file_id, state, inserted_at, updated_at, thumbnail_owned_file_id, parent_avatar_listing_id, reviewed_at, imported_from_host, imported_from_port, imported_from_sid) FROM stdin;
\.


--
-- Data for Name: cached_files; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.cached_files (cached_file_id, cache_key, file_uuid, file_key, file_content_type, inserted_at, updated_at, accessed_at) FROM stdin;
\.


--
-- Data for Name: entities; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.entities (entity_id, nid, create_message, hub_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: hub_bindings; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.hub_bindings (hub_binding_id, hub_id, type, community_id, channel_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: hub_invites; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.hub_invites (hub_invite_id, hub_invite_sid, hub_id, state, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: hub_role_memberships; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.hub_role_memberships (hub_role_membership_id, hub_id, account_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: hubs; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.hubs (hub_id, hub_sid, slug, name, default_environment_gltf_bundle_url, inserted_at, updated_at, max_occupant_count, entry_mode, spawned_object_types, scene_id, host, created_by_account_id, scene_listing_id, creator_assignment_token, last_active_at, embed_token, embedded, member_permissions, allow_promotion, description, room_size, user_data) FROM stdin;
\.


--
-- Data for Name: identities; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.identities (identity_id, name, account_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: login_tokens; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.login_tokens (login_token_id, token, identifier_hash, inserted_at, updated_at, payload_key) FROM stdin;
2216256577885700103	9aa51122c66308478a1a55112ea031da	Ga2NsPpqDKUOQ5cKAp6lhinSS5zEzIeLKAysbkSfThU=	2026-02-01 00:06:53	2026-02-01 00:06:53	5008d3b8572fb4de2171d3c92aa8081b
2216257206167273480	04ac7601e942e29e25b972df998936a9	Ga2NsPpqDKUOQ5cKAp6lhinSS5zEzIeLKAysbkSfThU=	2026-02-01 00:08:08	2026-02-01 00:08:08	957eb4384f179839ffd0754f847d6534
\.


--
-- Data for Name: logins; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.logins (login_id, identifier_hash, account_id, inserted_at, updated_at) FROM stdin;
2216239147801116674	Ga2NsPpqDKUOQ5cKAp6lhinSS5zEzIeLKAysbkSfThU=	2216239147784339457	2026-01-31 23:32:15	2026-01-31 23:32:15
\.


--
-- Data for Name: node_stats_y2018_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2018_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2018_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2019_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2019_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2020_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2020_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2021_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2021_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2022_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2022_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2023_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2023_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2024_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2024_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2025_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2025_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2026_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2026_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2027_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2027_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2028_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2028_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2029_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2029_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m1 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m10 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m11 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m12 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m2 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m3 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m4 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m5 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m6 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m7 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m8 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: node_stats_y2030_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.node_stats_y2030_m9 (node_id, measured_at, present_sessions, present_rooms) FROM stdin;
\.


--
-- Data for Name: oauth_providers; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.oauth_providers (oauth_provider_id, account_id, source, provider_account_id, inserted_at, updated_at, provider_access_token, provider_access_token_secret) FROM stdin;
\.


--
-- Data for Name: owned_files; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.owned_files (owned_file_id, owned_file_uuid, key, account_id, content_type, content_length, state, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: project_assets; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.project_assets (project_asset_id, project_id, asset_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: projects; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.projects (project_id, project_sid, name, created_by_account_id, project_owned_file_id, thumbnail_owned_file_id, inserted_at, updated_at, scene_id, parent_scene_id, parent_scene_listing_id) FROM stdin;
\.


--
-- Data for Name: room_objects; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.room_objects (room_object_id, object_id, hub_id, gltf_node, inserted_at, updated_at, account_id) FROM stdin;
\.


--
-- Data for Name: scene_listings; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.scene_listings (scene_listing_id, scene_listing_sid, scene_id, slug, name, description, attributions, tags, model_owned_file_id, scene_owned_file_id, screenshot_owned_file_id, "order", state, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: scenes; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.scenes (scene_id, scene_sid, slug, name, description, account_id, model_owned_file_id, screenshot_owned_file_id, state, inserted_at, updated_at, attribution, allow_remixing, allow_promotion, scene_owned_file_id, attributions, reviewed_at, imported_from_host, imported_from_port, imported_from_sid, parent_scene_id, parent_scene_listing_id) FROM stdin;
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.schema_migrations (version, inserted_at) FROM stdin;
20170917234137	2026-01-31 22:57:41
20170917234138	2026-01-31 22:57:41
20180322000442	2026-01-31 22:57:41
20180322000712	2026-01-31 22:57:41
20180408231444	2026-01-31 22:57:42
20180409012805	2026-01-31 22:57:42
20180412225707	2026-01-31 22:57:42
20180416203936	2026-01-31 22:57:42
20180802004115	2026-01-31 22:57:42
20180808191456	2026-01-31 22:57:42
20180830224453	2026-01-31 22:57:42
20180830224557	2026-01-31 22:57:42
20180831012904	2026-01-31 22:57:42
20180904221221	2026-01-31 22:57:42
20180904221223	2026-01-31 22:57:42
20180904222223	2026-01-31 22:57:42
20180910200029	2026-01-31 22:57:42
20180919002949	2026-01-31 22:57:42
20180919235959	2026-01-31 22:57:42
20180920000254	2026-01-31 22:57:42
20180920032008	2026-01-31 22:57:42
20180920222237	2026-01-31 22:57:42
20180924005229	2026-01-31 22:57:42
20181015020416	2026-01-31 22:57:42
20181024050853	2026-01-31 22:57:42
20181102010842	2026-01-31 22:57:42
20181102011004	2026-01-31 22:57:42
20181113033726	2026-01-31 22:57:42
20181127021310	2026-01-31 22:57:42
20181128022000	2026-01-31 22:57:42
20181227040710	2026-01-31 22:57:42
20190114122412	2026-01-31 22:57:42
20190114232257	2026-01-31 22:57:42
20190115003917	2026-01-31 22:57:42
20190125190651	2026-01-31 22:57:42
20190130052213	2026-01-31 22:57:42
20190131231854	2026-01-31 22:57:42
20190208014624	2026-01-31 22:57:42
20190305181357	2026-01-31 22:57:42
20190305190955	2026-01-31 22:57:42
20190306032224	2026-01-31 22:57:42
20190312171503	2026-01-31 22:57:42
20190322222314	2026-01-31 22:57:42
20190329004012	2026-01-31 22:57:42
20190329004026	2026-01-31 22:57:42
20190424010558	2026-01-31 22:57:42
20190501221754	2026-01-31 22:57:42
20190503170158	2026-01-31 22:57:42
20190508021811	2026-01-31 22:57:42
20190514175300	2026-01-31 22:57:42
20190605002622	2026-01-31 22:57:42
20190605213019	2026-01-31 22:57:42
20190606012330	2026-01-31 22:57:42
20190613223618	2026-01-31 22:57:42
20190614211950	2026-01-31 22:57:42
20190615010958	2026-01-31 22:57:42
20190703224946	2026-01-31 22:57:42
20190717173132	2026-01-31 22:57:42
20190812211919	2026-01-31 22:57:42
20190819204535	2026-01-31 22:57:42
20190904000046	2026-01-31 22:57:42
20191011184435	2026-01-31 22:57:42
20191013002432	2026-01-31 22:57:42
20191015184128	2026-01-31 22:57:43
20191015190511	2026-01-31 22:57:43
20191111234010	2026-01-31 22:57:43
20191121222742	2026-01-31 22:57:43
20200115013245	2026-01-31 22:57:43
20200206023550	2026-01-31 22:57:43
20200206195625	2026-01-31 22:57:43
20200212011700	2026-01-31 22:57:43
20200212174135	2026-01-31 22:57:43
20200212220224	2026-01-31 22:57:43
20200220012135	2026-01-31 22:57:43
20200303214942	2026-01-31 22:57:43
20200309203501	2026-01-31 22:57:43
20200313232157	2026-01-31 22:57:43
20200320004303	2026-01-31 22:57:43
20200413202224	2026-01-31 22:57:43
20200730155900	2026-01-31 22:57:43
20200805190647	2026-01-31 22:57:43
20201027202054	2026-01-31 22:57:43
20210304010625	2026-01-31 22:57:43
20210420191647	2026-01-31 22:57:43
20220218024638	2026-01-31 22:57:43
20220304230943	2026-01-31 22:57:43
20220820164826	2026-01-31 22:57:43
20220908132321	2026-01-31 22:57:43
20220915094102	2026-01-31 22:57:43
20230104213552	2026-01-31 22:57:43
20230105144400	2026-01-31 22:58:03
20230105144433	2026-01-31 22:58:03
20230129061701	2026-01-31 22:58:03
20230129061719	2026-01-31 22:58:03
\.


--
-- Data for Name: session_stats_y2018_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2018_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2018_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2019_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2019_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2020_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2020_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2021_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2021_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2022_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2022_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2023_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2023_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2024_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2024_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2025_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2025_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2026_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2026_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2027_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2027_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2028_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2028_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2029_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2029_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m1; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m1 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m10; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m10 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m11; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m11 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m12; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m12 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m2; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m2 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m3; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m3 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m4; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m4 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m5; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m5 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m6; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m6 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m7; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m7 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m8; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m8 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: session_stats_y2030_m9; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.session_stats_y2030_m9 (session_id, started_at, ended_at, entered_event_payload, entered_event_received_at) FROM stdin;
\.


--
-- Data for Name: sub_entities; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.sub_entities (sub_entity_id, nid, update_message, hub_id, entity_id, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: support_subscriptions; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.support_subscriptions (support_subscription_id, channel, identifier, inserted_at, updated_at) FROM stdin;
\.


--
-- Data for Name: web_push_subscriptions; Type: TABLE DATA; Schema: ret0; Owner: postgres
--

COPY ret0.web_push_subscriptions (web_push_subscription_id, p256dh, endpoint, auth, hub_id, last_notified_at, inserted_at, updated_at) FROM stdin;
\.


--
-- Name: table_id_seq; Type: SEQUENCE SET; Schema: ret0; Owner: postgres
--

SELECT pg_catalog.setval('ret0.table_id_seq', 8, true);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: account_favorites account_favorites_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.account_favorites
    ADD CONSTRAINT account_favorites_pkey PRIMARY KEY (account_favorite_id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (account_id);


--
-- Name: api_credentials api_credentials_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.api_credentials
    ADD CONSTRAINT api_credentials_pkey PRIMARY KEY (api_credentials_id);


--
-- Name: app_configs app_configs_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.app_configs
    ADD CONSTRAINT app_configs_pkey PRIMARY KEY (app_config_id);


--
-- Name: assets assets_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (asset_id);


--
-- Name: avatar_listings avatar_listings_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_pkey PRIMARY KEY (avatar_listing_id);


--
-- Name: avatars avatars_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_pkey PRIMARY KEY (avatar_id);


--
-- Name: cached_files cached_files_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.cached_files
    ADD CONSTRAINT cached_files_pkey PRIMARY KEY (cached_file_id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (entity_id);


--
-- Name: hub_bindings hub_bindings_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hub_bindings
    ADD CONSTRAINT hub_bindings_pkey PRIMARY KEY (hub_binding_id);


--
-- Name: hub_invites hub_invites_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hub_invites
    ADD CONSTRAINT hub_invites_pkey PRIMARY KEY (hub_invite_id);


--
-- Name: hub_role_memberships hub_role_memberships_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hub_role_memberships
    ADD CONSTRAINT hub_role_memberships_pkey PRIMARY KEY (hub_role_membership_id);


--
-- Name: hubs hubs_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hubs
    ADD CONSTRAINT hubs_pkey PRIMARY KEY (hub_id);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (identity_id);


--
-- Name: login_tokens login_tokens_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.login_tokens
    ADD CONSTRAINT login_tokens_pkey PRIMARY KEY (login_token_id);


--
-- Name: logins logins_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.logins
    ADD CONSTRAINT logins_pkey PRIMARY KEY (login_id);


--
-- Name: oauth_providers oauth_providers_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.oauth_providers
    ADD CONSTRAINT oauth_providers_pkey PRIMARY KEY (oauth_provider_id);


--
-- Name: owned_files owned_files_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.owned_files
    ADD CONSTRAINT owned_files_pkey PRIMARY KEY (owned_file_id);


--
-- Name: project_assets project_assets_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.project_assets
    ADD CONSTRAINT project_assets_pkey PRIMARY KEY (project_asset_id, project_id, asset_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (project_id);


--
-- Name: room_objects room_objects_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.room_objects
    ADD CONSTRAINT room_objects_pkey PRIMARY KEY (room_object_id);


--
-- Name: scene_listings scene_listings_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.scene_listings
    ADD CONSTRAINT scene_listings_pkey PRIMARY KEY (scene_listing_id);


--
-- Name: scenes scenes_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.scenes
    ADD CONSTRAINT scenes_pkey PRIMARY KEY (scene_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sub_entities sub_entities_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.sub_entities
    ADD CONSTRAINT sub_entities_pkey PRIMARY KEY (sub_entity_id);


--
-- Name: support_subscriptions support_subscriptions_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.support_subscriptions
    ADD CONSTRAINT support_subscriptions_pkey PRIMARY KEY (support_subscription_id);


--
-- Name: web_push_subscriptions web_push_subscriptions_pkey; Type: CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.web_push_subscriptions
    ADD CONSTRAINT web_push_subscriptions_pkey PRIMARY KEY (web_push_subscription_id);


--
-- Name: account_favorites_account_id_hub_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX account_favorites_account_id_hub_id_index ON ret0.account_favorites USING btree (account_id, hub_id);


--
-- Name: api_credentials_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX api_credentials_account_id_index ON ret0.api_credentials USING btree (account_id);


--
-- Name: api_credentials_api_credentials_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX api_credentials_api_credentials_sid_index ON ret0.api_credentials USING btree (api_credentials_sid);


--
-- Name: api_credentials_token_hash_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX api_credentials_token_hash_index ON ret0.api_credentials USING btree (token_hash);


--
-- Name: app_configs_key_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX app_configs_key_index ON ret0.app_configs USING btree (key);


--
-- Name: assets_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX assets_account_id_index ON ret0.assets USING btree (account_id);


--
-- Name: assets_asset_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX assets_asset_sid_index ON ret0.assets USING btree (asset_sid);


--
-- Name: avatar_listings_avatar_listing_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX avatar_listings_avatar_listing_sid_index ON ret0.avatar_listings USING btree (avatar_listing_sid);


--
-- Name: avatars_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX avatars_account_id_index ON ret0.avatars USING btree (account_id);


--
-- Name: avatars_avatar_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX avatars_avatar_sid_index ON ret0.avatars USING btree (avatar_sid);


--
-- Name: avatars_imported_from_host_imported_from_port_imported_from_sid; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX avatars_imported_from_host_imported_from_port_imported_from_sid ON ret0.avatars USING btree (imported_from_host, imported_from_port, imported_from_sid);


--
-- Name: avatars_reviewed_at_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX avatars_reviewed_at_index ON ret0.avatars USING btree (reviewed_at) WHERE ((reviewed_at IS NULL) OR (reviewed_at < updated_at));


--
-- Name: cached_files_cache_key_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX cached_files_cache_key_index ON ret0.cached_files USING btree (cache_key);


--
-- Name: entities_hub_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX entities_hub_id_index ON ret0.entities USING btree (hub_id);


--
-- Name: entities_nid_hub_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX entities_nid_hub_id_index ON ret0.entities USING btree (nid, hub_id);


--
-- Name: entities_nid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX entities_nid_index ON ret0.entities USING btree (nid);


--
-- Name: hub_bindings_type_community_id_channel_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX hub_bindings_type_community_id_channel_id_index ON ret0.hub_bindings USING btree (type, community_id, channel_id);


--
-- Name: hub_invites_hub_invite_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX hub_invites_hub_invite_sid_index ON ret0.hub_invites USING btree (hub_invite_sid);


--
-- Name: hub_role_memberships_hub_id_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX hub_role_memberships_hub_id_account_id_index ON ret0.hub_role_memberships USING btree (hub_id, account_id);


--
-- Name: hubs_allow_promotion_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX hubs_allow_promotion_index ON ret0.hubs USING btree (allow_promotion);


--
-- Name: hubs_created_by_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX hubs_created_by_account_id_index ON ret0.hubs USING btree (created_by_account_id);


--
-- Name: hubs_host_inserted_at_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX hubs_host_inserted_at_index ON ret0.hubs USING btree (host, inserted_at) WHERE (host IS NOT NULL);


--
-- Name: hubs_hub_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX hubs_hub_sid_index ON ret0.hubs USING btree (hub_sid);


--
-- Name: hubs_last_active_at_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX hubs_last_active_at_index ON ret0.hubs USING btree (last_active_at);


--
-- Name: identities_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX identities_account_id_index ON ret0.identities USING btree (account_id);


--
-- Name: login_tokens_token_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX login_tokens_token_index ON ret0.login_tokens USING btree (token);


--
-- Name: logins_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX logins_account_id_index ON ret0.logins USING btree (account_id);


--
-- Name: logins_identifier_hash_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX logins_identifier_hash_index ON ret0.logins USING btree (identifier_hash);


--
-- Name: oauth_providers_source_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX oauth_providers_source_account_id_index ON ret0.oauth_providers USING btree (source, account_id);


--
-- Name: oauth_providers_source_provider_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX oauth_providers_source_provider_account_id_index ON ret0.oauth_providers USING btree (source, provider_account_id);


--
-- Name: owned_files_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX owned_files_account_id_index ON ret0.owned_files USING btree (account_id);


--
-- Name: owned_files_owned_file_uuid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX owned_files_owned_file_uuid_index ON ret0.owned_files USING btree (owned_file_uuid);


--
-- Name: project_assets_asset_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX project_assets_asset_id_index ON ret0.project_assets USING btree (asset_id);


--
-- Name: project_assets_project_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX project_assets_project_id_index ON ret0.project_assets USING btree (project_id);


--
-- Name: project_id_asset_id_unique_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX project_id_asset_id_unique_index ON ret0.project_assets USING btree (project_id, asset_id);


--
-- Name: projects_created_by_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX projects_created_by_account_id_index ON ret0.projects USING btree (created_by_account_id);


--
-- Name: projects_project_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX projects_project_sid_index ON ret0.projects USING btree (project_sid);


--
-- Name: room_objects_hub_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX room_objects_hub_id_index ON ret0.room_objects USING btree (hub_id);


--
-- Name: room_objects_object_id_hub_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX room_objects_object_id_hub_id_index ON ret0.room_objects USING btree (object_id, hub_id);


--
-- Name: scene_listings_scene_listing_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX scene_listings_scene_listing_sid_index ON ret0.scene_listings USING btree (scene_listing_sid);


--
-- Name: scenes_account_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX scenes_account_id_index ON ret0.scenes USING btree (account_id);


--
-- Name: scenes_imported_from_host_imported_from_port_imported_from_sid_; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX scenes_imported_from_host_imported_from_port_imported_from_sid_ ON ret0.scenes USING btree (imported_from_host, imported_from_port, imported_from_sid);


--
-- Name: scenes_reviewed_at_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX scenes_reviewed_at_index ON ret0.scenes USING btree (reviewed_at) WHERE ((reviewed_at IS NULL) OR (reviewed_at < updated_at));


--
-- Name: scenes_scene_sid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX scenes_scene_sid_index ON ret0.scenes USING btree (scene_sid);


--
-- Name: session_stats_y2018_m10_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m10_session_id ON ret0.session_stats_y2018_m10 USING btree (session_id);


--
-- Name: session_stats_y2018_m11_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m11_session_id ON ret0.session_stats_y2018_m11 USING btree (session_id);


--
-- Name: session_stats_y2018_m12_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m12_session_id ON ret0.session_stats_y2018_m12 USING btree (session_id);


--
-- Name: session_stats_y2018_m1_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m1_session_id ON ret0.session_stats_y2018_m1 USING btree (session_id);


--
-- Name: session_stats_y2018_m2_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m2_session_id ON ret0.session_stats_y2018_m2 USING btree (session_id);


--
-- Name: session_stats_y2018_m3_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m3_session_id ON ret0.session_stats_y2018_m3 USING btree (session_id);


--
-- Name: session_stats_y2018_m4_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m4_session_id ON ret0.session_stats_y2018_m4 USING btree (session_id);


--
-- Name: session_stats_y2018_m5_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m5_session_id ON ret0.session_stats_y2018_m5 USING btree (session_id);


--
-- Name: session_stats_y2018_m6_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m6_session_id ON ret0.session_stats_y2018_m6 USING btree (session_id);


--
-- Name: session_stats_y2018_m7_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m7_session_id ON ret0.session_stats_y2018_m7 USING btree (session_id);


--
-- Name: session_stats_y2018_m8_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m8_session_id ON ret0.session_stats_y2018_m8 USING btree (session_id);


--
-- Name: session_stats_y2018_m9_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2018_m9_session_id ON ret0.session_stats_y2018_m9 USING btree (session_id);


--
-- Name: session_stats_y2019_m10_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m10_session_id ON ret0.session_stats_y2019_m10 USING btree (session_id);


--
-- Name: session_stats_y2019_m11_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m11_session_id ON ret0.session_stats_y2019_m11 USING btree (session_id);


--
-- Name: session_stats_y2019_m12_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m12_session_id ON ret0.session_stats_y2019_m12 USING btree (session_id);


--
-- Name: session_stats_y2019_m1_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m1_session_id ON ret0.session_stats_y2019_m1 USING btree (session_id);


--
-- Name: session_stats_y2019_m2_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m2_session_id ON ret0.session_stats_y2019_m2 USING btree (session_id);


--
-- Name: session_stats_y2019_m3_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m3_session_id ON ret0.session_stats_y2019_m3 USING btree (session_id);


--
-- Name: session_stats_y2019_m4_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m4_session_id ON ret0.session_stats_y2019_m4 USING btree (session_id);


--
-- Name: session_stats_y2019_m5_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m5_session_id ON ret0.session_stats_y2019_m5 USING btree (session_id);


--
-- Name: session_stats_y2019_m6_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m6_session_id ON ret0.session_stats_y2019_m6 USING btree (session_id);


--
-- Name: session_stats_y2019_m7_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m7_session_id ON ret0.session_stats_y2019_m7 USING btree (session_id);


--
-- Name: session_stats_y2019_m8_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m8_session_id ON ret0.session_stats_y2019_m8 USING btree (session_id);


--
-- Name: session_stats_y2019_m9_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2019_m9_session_id ON ret0.session_stats_y2019_m9 USING btree (session_id);


--
-- Name: session_stats_y2020_m10_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m10_session_id ON ret0.session_stats_y2020_m10 USING btree (session_id);


--
-- Name: session_stats_y2020_m11_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m11_session_id ON ret0.session_stats_y2020_m11 USING btree (session_id);


--
-- Name: session_stats_y2020_m12_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m12_session_id ON ret0.session_stats_y2020_m12 USING btree (session_id);


--
-- Name: session_stats_y2020_m1_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m1_session_id ON ret0.session_stats_y2020_m1 USING btree (session_id);


--
-- Name: session_stats_y2020_m2_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m2_session_id ON ret0.session_stats_y2020_m2 USING btree (session_id);


--
-- Name: session_stats_y2020_m3_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m3_session_id ON ret0.session_stats_y2020_m3 USING btree (session_id);


--
-- Name: session_stats_y2020_m4_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m4_session_id ON ret0.session_stats_y2020_m4 USING btree (session_id);


--
-- Name: session_stats_y2020_m5_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m5_session_id ON ret0.session_stats_y2020_m5 USING btree (session_id);


--
-- Name: session_stats_y2020_m6_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m6_session_id ON ret0.session_stats_y2020_m6 USING btree (session_id);


--
-- Name: session_stats_y2020_m7_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m7_session_id ON ret0.session_stats_y2020_m7 USING btree (session_id);


--
-- Name: session_stats_y2020_m8_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m8_session_id ON ret0.session_stats_y2020_m8 USING btree (session_id);


--
-- Name: session_stats_y2020_m9_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2020_m9_session_id ON ret0.session_stats_y2020_m9 USING btree (session_id);


--
-- Name: session_stats_y2021_m10_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m10_session_id ON ret0.session_stats_y2021_m10 USING btree (session_id);


--
-- Name: session_stats_y2021_m11_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m11_session_id ON ret0.session_stats_y2021_m11 USING btree (session_id);


--
-- Name: session_stats_y2021_m12_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m12_session_id ON ret0.session_stats_y2021_m12 USING btree (session_id);


--
-- Name: session_stats_y2021_m1_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m1_session_id ON ret0.session_stats_y2021_m1 USING btree (session_id);


--
-- Name: session_stats_y2021_m2_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m2_session_id ON ret0.session_stats_y2021_m2 USING btree (session_id);


--
-- Name: session_stats_y2021_m3_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m3_session_id ON ret0.session_stats_y2021_m3 USING btree (session_id);


--
-- Name: session_stats_y2021_m4_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m4_session_id ON ret0.session_stats_y2021_m4 USING btree (session_id);


--
-- Name: session_stats_y2021_m5_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m5_session_id ON ret0.session_stats_y2021_m5 USING btree (session_id);


--
-- Name: session_stats_y2021_m6_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m6_session_id ON ret0.session_stats_y2021_m6 USING btree (session_id);


--
-- Name: session_stats_y2021_m7_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m7_session_id ON ret0.session_stats_y2021_m7 USING btree (session_id);


--
-- Name: session_stats_y2021_m8_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m8_session_id ON ret0.session_stats_y2021_m8 USING btree (session_id);


--
-- Name: session_stats_y2021_m9_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2021_m9_session_id ON ret0.session_stats_y2021_m9 USING btree (session_id);


--
-- Name: session_stats_y2022_m10_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m10_session_id ON ret0.session_stats_y2022_m10 USING btree (session_id);


--
-- Name: session_stats_y2022_m11_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m11_session_id ON ret0.session_stats_y2022_m11 USING btree (session_id);


--
-- Name: session_stats_y2022_m12_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m12_session_id ON ret0.session_stats_y2022_m12 USING btree (session_id);


--
-- Name: session_stats_y2022_m1_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m1_session_id ON ret0.session_stats_y2022_m1 USING btree (session_id);


--
-- Name: session_stats_y2022_m2_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m2_session_id ON ret0.session_stats_y2022_m2 USING btree (session_id);


--
-- Name: session_stats_y2022_m3_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m3_session_id ON ret0.session_stats_y2022_m3 USING btree (session_id);


--
-- Name: session_stats_y2022_m4_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m4_session_id ON ret0.session_stats_y2022_m4 USING btree (session_id);


--
-- Name: session_stats_y2022_m5_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m5_session_id ON ret0.session_stats_y2022_m5 USING btree (session_id);


--
-- Name: session_stats_y2022_m6_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m6_session_id ON ret0.session_stats_y2022_m6 USING btree (session_id);


--
-- Name: session_stats_y2022_m7_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m7_session_id ON ret0.session_stats_y2022_m7 USING btree (session_id);


--
-- Name: session_stats_y2022_m8_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m8_session_id ON ret0.session_stats_y2022_m8 USING btree (session_id);


--
-- Name: session_stats_y2022_m9_session_id; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX session_stats_y2022_m9_session_id ON ret0.session_stats_y2022_m9 USING btree (session_id);


--
-- Name: sub_entities_hub_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX sub_entities_hub_id_index ON ret0.sub_entities USING btree (hub_id);


--
-- Name: sub_entities_nid_hub_id_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX sub_entities_nid_hub_id_index ON ret0.sub_entities USING btree (nid, hub_id);


--
-- Name: sub_entities_nid_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX sub_entities_nid_index ON ret0.sub_entities USING btree (nid);


--
-- Name: support_subscriptions_channel_identifier_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX support_subscriptions_channel_identifier_index ON ret0.support_subscriptions USING btree (channel, identifier);


--
-- Name: web_push_subscriptions_endpoint_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE INDEX web_push_subscriptions_endpoint_index ON ret0.web_push_subscriptions USING btree (endpoint);


--
-- Name: web_push_subscriptions_hub_id_endpoint_index; Type: INDEX; Schema: ret0; Owner: postgres
--

CREATE UNIQUE INDEX web_push_subscriptions_hub_id_endpoint_index ON ret0.web_push_subscriptions USING btree (hub_id, endpoint);


--
-- Name: account_favorites account_favorites_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.account_favorites
    ADD CONSTRAINT account_favorites_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id) ON DELETE CASCADE;


--
-- Name: account_favorites account_favorites_hub_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.account_favorites
    ADD CONSTRAINT account_favorites_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES ret0.hubs(hub_id) ON DELETE CASCADE;


--
-- Name: api_credentials api_credentials_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.api_credentials
    ADD CONSTRAINT api_credentials_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id) ON DELETE CASCADE;


--
-- Name: assets assets_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.assets
    ADD CONSTRAINT assets_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id);


--
-- Name: avatar_listings avatar_listings_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id);


--
-- Name: avatar_listings avatar_listings_base_map_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_base_map_owned_file_id_fkey FOREIGN KEY (base_map_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatar_listings avatar_listings_bin_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_bin_owned_file_id_fkey FOREIGN KEY (bin_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatar_listings avatar_listings_emissive_map_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_emissive_map_owned_file_id_fkey FOREIGN KEY (emissive_map_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatar_listings avatar_listings_gltf_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_gltf_owned_file_id_fkey FOREIGN KEY (gltf_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatar_listings avatar_listings_normal_map_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_normal_map_owned_file_id_fkey FOREIGN KEY (normal_map_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatar_listings avatar_listings_orm_map_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_orm_map_owned_file_id_fkey FOREIGN KEY (orm_map_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatar_listings avatar_listings_parent_avatar_listing_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_parent_avatar_listing_id_fkey FOREIGN KEY (parent_avatar_listing_id) REFERENCES ret0.avatar_listings(avatar_listing_id);


--
-- Name: avatar_listings avatar_listings_thumbnail_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatar_listings
    ADD CONSTRAINT avatar_listings_thumbnail_owned_file_id_fkey FOREIGN KEY (thumbnail_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatars avatars_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id);


--
-- Name: avatars avatars_base_map_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_base_map_owned_file_id_fkey FOREIGN KEY (base_map_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatars avatars_bin_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_bin_owned_file_id_fkey FOREIGN KEY (bin_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatars avatars_emissive_map_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_emissive_map_owned_file_id_fkey FOREIGN KEY (emissive_map_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatars avatars_gltf_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_gltf_owned_file_id_fkey FOREIGN KEY (gltf_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatars avatars_normal_map_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_normal_map_owned_file_id_fkey FOREIGN KEY (normal_map_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatars avatars_orm_map_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_orm_map_owned_file_id_fkey FOREIGN KEY (orm_map_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: avatars avatars_parent_avatar_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_parent_avatar_id_fkey FOREIGN KEY (parent_avatar_id) REFERENCES ret0.avatars(avatar_id);


--
-- Name: avatars avatars_parent_avatar_listing_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_parent_avatar_listing_id_fkey FOREIGN KEY (parent_avatar_listing_id) REFERENCES ret0.avatar_listings(avatar_listing_id);


--
-- Name: avatars avatars_thumbnail_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.avatars
    ADD CONSTRAINT avatars_thumbnail_owned_file_id_fkey FOREIGN KEY (thumbnail_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: entities entities_hub_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.entities
    ADD CONSTRAINT entities_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES ret0.hubs(hub_id);


--
-- Name: hub_bindings hub_bindings_hub_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hub_bindings
    ADD CONSTRAINT hub_bindings_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES ret0.hubs(hub_id) ON DELETE CASCADE;


--
-- Name: hub_invites hub_invites_hub_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hub_invites
    ADD CONSTRAINT hub_invites_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES ret0.hubs(hub_id) ON DELETE CASCADE;


--
-- Name: hub_role_memberships hub_role_memberships_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hub_role_memberships
    ADD CONSTRAINT hub_role_memberships_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id) ON DELETE CASCADE;


--
-- Name: hub_role_memberships hub_role_memberships_hub_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hub_role_memberships
    ADD CONSTRAINT hub_role_memberships_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES ret0.hubs(hub_id) ON DELETE CASCADE;


--
-- Name: hubs hubs_created_by_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hubs
    ADD CONSTRAINT hubs_created_by_account_id_fkey FOREIGN KEY (created_by_account_id) REFERENCES ret0.accounts(account_id) ON DELETE CASCADE;


--
-- Name: hubs hubs_scene_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hubs
    ADD CONSTRAINT hubs_scene_id_fkey FOREIGN KEY (scene_id) REFERENCES ret0.scenes(scene_id) ON DELETE CASCADE;


--
-- Name: hubs hubs_scene_listing_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.hubs
    ADD CONSTRAINT hubs_scene_listing_id_fkey FOREIGN KEY (scene_listing_id) REFERENCES ret0.scene_listings(scene_listing_id);


--
-- Name: identities identities_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.identities
    ADD CONSTRAINT identities_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id) ON DELETE CASCADE;


--
-- Name: logins logins_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.logins
    ADD CONSTRAINT logins_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id) ON DELETE CASCADE;


--
-- Name: oauth_providers oauth_providers_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.oauth_providers
    ADD CONSTRAINT oauth_providers_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id) ON DELETE CASCADE;


--
-- Name: project_assets project_assets_asset_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.project_assets
    ADD CONSTRAINT project_assets_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES ret0.assets(asset_id) ON DELETE CASCADE;


--
-- Name: project_assets project_assets_project_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.project_assets
    ADD CONSTRAINT project_assets_project_id_fkey FOREIGN KEY (project_id) REFERENCES ret0.projects(project_id) ON DELETE CASCADE;


--
-- Name: projects projects_created_by_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.projects
    ADD CONSTRAINT projects_created_by_account_id_fkey FOREIGN KEY (created_by_account_id) REFERENCES ret0.accounts(account_id);


--
-- Name: projects projects_parent_scene_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.projects
    ADD CONSTRAINT projects_parent_scene_id_fkey FOREIGN KEY (parent_scene_id) REFERENCES ret0.scenes(scene_id);


--
-- Name: projects projects_parent_scene_listing_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.projects
    ADD CONSTRAINT projects_parent_scene_listing_id_fkey FOREIGN KEY (parent_scene_listing_id) REFERENCES ret0.scene_listings(scene_listing_id);


--
-- Name: projects projects_scene_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.projects
    ADD CONSTRAINT projects_scene_id_fkey FOREIGN KEY (scene_id) REFERENCES ret0.scenes(scene_id);


--
-- Name: room_objects room_objects_account_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.room_objects
    ADD CONSTRAINT room_objects_account_id_fkey FOREIGN KEY (account_id) REFERENCES ret0.accounts(account_id) ON DELETE CASCADE;


--
-- Name: room_objects room_objects_hub_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.room_objects
    ADD CONSTRAINT room_objects_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES ret0.hubs(hub_id) ON DELETE CASCADE;


--
-- Name: scenes scenes_parent_scene_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.scenes
    ADD CONSTRAINT scenes_parent_scene_id_fkey FOREIGN KEY (parent_scene_id) REFERENCES ret0.scenes(scene_id) ON DELETE CASCADE;


--
-- Name: scenes scenes_parent_scene_listing_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.scenes
    ADD CONSTRAINT scenes_parent_scene_listing_id_fkey FOREIGN KEY (parent_scene_listing_id) REFERENCES ret0.scene_listings(scene_listing_id);


--
-- Name: scenes scenes_scene_owned_file_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.scenes
    ADD CONSTRAINT scenes_scene_owned_file_id_fkey FOREIGN KEY (scene_owned_file_id) REFERENCES ret0.owned_files(owned_file_id);


--
-- Name: sub_entities sub_entities_entity_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.sub_entities
    ADD CONSTRAINT sub_entities_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES ret0.entities(entity_id) ON DELETE CASCADE;


--
-- Name: sub_entities sub_entities_hub_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.sub_entities
    ADD CONSTRAINT sub_entities_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES ret0.hubs(hub_id);


--
-- Name: web_push_subscriptions web_push_subscriptions_hub_id_fkey; Type: FK CONSTRAINT; Schema: ret0; Owner: postgres
--

ALTER TABLE ONLY ret0.web_push_subscriptions
    ADD CONSTRAINT web_push_subscriptions_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES ret0.hubs(hub_id) ON DELETE CASCADE;


--
-- Name: SCHEMA ret0; Type: ACL; Schema: -; Owner: postgres
--

GRANT USAGE ON SCHEMA ret0 TO ret_admin;


--
-- Name: SCHEMA ret0_admin; Type: ACL; Schema: -; Owner: postgres
--

GRANT USAGE ON SCHEMA ret0_admin TO ret_admin;


--
-- Name: SEQUENCE table_id_seq; Type: ACL; Schema: ret0; Owner: postgres
--

GRANT USAGE ON SEQUENCE ret0.table_id_seq TO ret_admin;


--
-- Name: TABLE accounts; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE ret0_admin.accounts TO ret_admin;


--
-- Name: TABLE avatar_listings; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE ret0_admin.avatar_listings TO ret_admin;


--
-- Name: TABLE avatars; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE ret0_admin.avatars TO ret_admin;


--
-- Name: TABLE featured_avatar_listings; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,UPDATE ON TABLE ret0_admin.featured_avatar_listings TO ret_admin;


--
-- Name: TABLE scene_listings; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE ret0_admin.scene_listings TO ret_admin;


--
-- Name: TABLE scenes; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE ret0_admin.scenes TO ret_admin;


--
-- Name: TABLE featured_scene_listings; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,UPDATE ON TABLE ret0_admin.featured_scene_listings TO ret_admin;


--
-- Name: TABLE identities; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ret0_admin.identities TO ret_admin;


--
-- Name: TABLE owned_files; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE ret0_admin.owned_files TO ret_admin;


--
-- Name: TABLE pending_avatars; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT ON TABLE ret0_admin.pending_avatars TO ret_admin;


--
-- Name: TABLE pending_scenes; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT ON TABLE ret0_admin.pending_scenes TO ret_admin;


--
-- Name: TABLE projects; Type: ACL; Schema: ret0_admin; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ret0_admin.projects TO ret_admin;


--
-- PostgreSQL database dump complete
--


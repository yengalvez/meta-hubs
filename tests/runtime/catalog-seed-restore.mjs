// A private, paired copy of the existing synthetic export, NOT a checkpoint,
// seed generator, production restore coordinator or native acceptance gate.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { approvedAssetBinding, preservedListings } from "./catalog-dataset.mjs";

const fail = code => { throw new Error(code); };
const check = (condition, code) => { if (!condition) fail(code); };
export const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sid = value => typeof value === "string" && /^[A-Za-z0-9_-]{7}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const id = value => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortRows = rows => rows.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
export const restoreScope = "native-PG14-existing-synthetic-seed-restore-not-kubernetes-production-browser-or-cycles";
// Reference observed by the primary on 2026-10-04, not a historical hash
// receipt or proof of immutability since the seed's original creation.
export const designatedSeedSqlSha256 = "fa47f64379c63ec6eba056dfaf93faea2b94eaf3465750568695b9e982ab8cdc";
const seedSourceIdentity = Object.freeze({
  ".": "d52e25f9bf4f787de6190f26a0260ce5deaf94f9",
  hubs: "2a3d7ab406466d6d69c6e0b8776df42fb7c1931e",
  "hubs-cloud": "cb15414037754a2dc4f08a1b375519bad7478958"
});

// Literal columns are shared with the independent SQL reader; no input can
// supply SQL identifiers, and keys stay out of the public/private JSON binding.
export const restoreTables = Object.freeze({
  accounts: ["account_id"],
  owned_files: ["owned_file_id", "owned_file_uuid", "account_id", "content_type", "content_length", "state"],
  avatars: ["avatar_id", "avatar_sid", "account_id", "gltf_owned_file_id", "bin_owned_file_id", "thumbnail_owned_file_id", "state"],
  avatar_listings: ["avatar_listing_id", "avatar_listing_sid", "avatar_id", "account_id", "gltf_owned_file_id", "bin_owned_file_id", "thumbnail_owned_file_id", "state"],
  hubs: ["hub_id", "hub_sid", "created_by_account_id", "scene_listing_id", "creator_assignment_token"],
  scenes: ["scene_id", "scene_sid", "account_id", "model_owned_file_id", "screenshot_owned_file_id", "scene_owned_file_id", "state"],
  scene_listings: ["scene_listing_id", "scene_listing_sid", "scene_id", "model_owned_file_id", "screenshot_owned_file_id", "scene_owned_file_id", "state"],
  projects: ["project_id", "project_sid", "created_by_account_id", "scene_id", "project_owned_file_id", "thumbnail_owned_file_id"],
  hub_role_memberships: ["hub_id", "account_id"]
});

export function catalogRestoreArguments(args) {
  check(Array.isArray(args) && args.length === 9 && args[0] === "--catalog-restore" &&
    args[1] === "--pg-bin" && args[3] === "--cache-reticulum" &&
    args[5] === "--seed-source" && args[7] === "--hex-cache" &&
    [args[2], args[4], args[8]].every(value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value) &&
    typeof args[6] === "string" && /^\/private\/tmp\/ynret-local-[A-Za-z0-9]+$/.test(args[6]),
    "explicit_catalog_restore_target_required");
  return { pgBin: args[2], cache: args[4], seedSource: args[6], hexCache: args[8] };
}

function copyValue(value) {
  if (value === "\\N") return null;
  let result = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\\") { result += value[index]; continue; }
    const code = value[++index], escapes = { b: "\b", t: "\t", n: "\n", r: "\r", f: "\f", v: "\v", "\\": "\\" };
    if (Object.hasOwn(escapes, code)) result += escapes[code];
    else if (/[0-7]/.test(code ?? "")) {
      const digits = /^[0-7]{1,3}/.exec(value.slice(index))[0];
      result += String.fromCharCode(parseInt(digits, 8)); index += digits.length - 1;
    } else if (code === "x" && /^[a-fA-F0-9]/.test(value[index + 1] ?? "")) {
      const digits = /^[a-fA-F0-9]{1,2}/.exec(value.slice(index + 1))[0];
      result += String.fromCharCode(parseInt(digits, 16)); index += digits.length;
    } else fail("seed_copy_escape_not_supported");
  }
  return result;
}

function copyIdentifiers(value) {
  // pg_dump quotes reserved lowercase names such as "order". This closed
  // grammar accepts only simple lowercase identifiers, never SQL fragments,
  // escaped quotes, qualification, expressions or quoted case folding.
  const columns = value.split(",").map(token => token.trim());
  check(columns.length > 0 && columns.every(token => /^(?:[a-z_][a-z0-9_]*|"[a-z_][a-z0-9_]*")$/.test(token)), "seed_copy_identifier_invalid");
  const normalized = columns.map(token => token.startsWith('"') ? token.slice(1, -1) : token);
  check(new Set(normalized).size === normalized.length, "seed_copy_duplicate");
  return normalized;
}

// Parse the existing pg_dump COPY rows without executing anything. The original
// SQL is later restored by psql, never reconstructed from these projections.
export function catalogSqlRows(sql) {
  check(typeof sql === "string" && sql.startsWith("--\n-- PostgreSQL database dump\n") &&
    /-- Dumped (?:from database|by pg_dump) version 14\./.test(sql), "synthetic_pg14_dump_required");
  const tables = {}, lines = sql.split("\n");
  let block, restrict;
  for (const line of lines) {
    if (block) {
      if (line === "\\.") { block = null; continue; }
      const values = line.split("\t").map(copyValue);
      check(values.length === block.columns.length, "seed_copy_column_count_mismatch");
      if (block.keep) tables[block.table].push(Object.fromEntries(block.columns.map((column, index) => [column, values[index]])));
      continue;
    }
    if (line.startsWith("\\")) {
      const marker = /^\\(unrestrict|restrict) ([A-Za-z0-9]+)$/.exec(line);
      check(marker && (marker[1] === "restrict" ? !restrict : restrict === marker[2]), "seed_psql_metacommand_forbidden");
      restrict = marker[1] === "restrict" ? marker[2] : undefined;
      continue;
    }
    const copy = /^COPY ("[a-z_][a-z0-9_]*"|[a-z_][a-z0-9_]*)\.("[a-z_][a-z0-9_]*"|[a-z_][a-z0-9_]*) \(([^()\r\n]+)\) FROM stdin;$/.exec(line);
    if (copy) {
      const [schema] = copyIdentifiers(copy[1]), [table] = copyIdentifiers(copy[2]);
      const columns = copyIdentifiers(copy[3]), keep = schema === "ret0" && Object.hasOwn(restoreTables, table);
      check(!keep || !tables[table], "seed_copy_duplicate");
      if (keep) {
        check([...restoreTables[table], ...(table === "owned_files" ? ["key"] : [])].every(column => columns.includes(column)), "seed_copy_missing_columns");
        tables[table] = [];
      }
      block = { table, columns, keep };
    } else check(!/^COPY\b/i.test(line), "seed_copy_external_target_forbidden");
  }
  check(!block && !restrict && Object.keys(restoreTables).every(table => tables[table]), "seed_copy_incomplete");
  return tables;
}

export function bindCatalogSeed({ summary, input, readback, sql }, assetBinding = approvedAssetBinding, expectedSqlSha256 = designatedSeedSqlSha256) {
  check(summary?.phase === "terminal" && summary.outcome === "PASS" && summary.tests === 1 &&
    summary.scope === "native-synthetic-reticulum-not-kubernetes-or-production" &&
    summary.metrics?.catalog?.models === 33 && summary.metrics.catalog.owned_pairs === 103 && summary.metrics.catalog.preserved === 7 &&
    summary.metrics.catalog.sql_bytes === 375445 && summary.metrics.catalog.postgres_version === "postgres (PostgreSQL) 14.23 (Homebrew)" &&
    summary.metrics.catalog.graph?.scope === "native-synthetic-room-project-graph-not-current-metaverse",
    "accepted_synthetic_seed_receipt_required");
  const before = summary.catalog_source_before, after = summary.catalog_source_after;
  check(before && equal(before, after) && Object.keys(before).sort().join(",") === ".,hubs,hubs-cloud" &&
    Object.values(before).every(value => /^[a-f0-9]{40}$/.test(value)) &&
    Object.entries(seedSourceIdentity).every(([name, commit]) => before[name] === commit), "seed_source_identity_mismatch");
  check(Buffer.byteLength(sql) === 375445, "seed_sql_size_changed");
  check(digest(expectedSqlSha256) && hash(sql) === expectedSqlSha256, "seed_sql_reference_mismatch");
  check(digest(assetBinding) && input?.schema === 1 && input.scope === "owned-synthetic-catalog-not-production-or-cycles" && input.binding === assetBinding &&
    readback?.scope === "native-synthetic-catalog-not-restore-or-browser-or-cycles" && readback.binding === assetBinding &&
    input.entries?.length === 33 && readback.entries?.length === 33 && readback.models === 33 && readback.listings === 33 && readback.owned_pairs === 103 && readback.preserved === 7,
    "synthetic_seed_readback_required");
  const graph = readback.graph;
  check(graph?.scope === "native-synthetic-room-project-graph-not-current-metaverse" && input.graph?.scope === graph.scope &&
    [graph.rooms, graph.scenes, graph.scene_listings, graph.projects, graph.co_owner_roles].every(count => count === 1) && graph.distinct_room_project_owners === true &&
    [graph.room_sid, graph.scene_sid, graph.scene_listing_sid, graph.project_sid].every(sid), "synthetic_seed_graph_required");
  const tables = catalogSqlRows(sql), files = [], entries = [];
  const one = (table, column, value) => {
    const rows = tables[table].filter(row => row[column] === value);
    check(rows.length === 1, "seed_sql_readback_identity_mismatch"); return rows[0];
  };
  const file = (expected, plaintext) => {
    check(uuid(expected?.uuid) && digest(expected?.plaintext_sha256) && digest(plaintext?.sha256) &&
      expected.plaintext_sha256 === plaintext.sha256 && Number.isSafeInteger(plaintext.size) && plaintext.size > 0,
      "seed_plaintext_binding_mismatch");
    const row = one("owned_files", "owned_file_uuid", expected.uuid);
    check(id(row.owned_file_id) && id(row.account_id) && row.state === "active" && typeof row.key === "string" && row.key.length > 0 &&
      row.content_type === plaintext.content_type && row.content_length === String(plaintext.size) &&
      (expected.owned_file_id === undefined || expected.owned_file_id === row.owned_file_id), "seed_owned_file_binding_mismatch");
    const result = { ...Object.fromEntries(restoreTables.owned_files.map(column => [column, row[column]])),
      key_sha256: hash(row.key), plaintext_sha256: expected.plaintext_sha256 };
    files.push(result); return result;
  };
  for (const original of input.entries) {
    const current = readback.entries.filter(entry => entry.listing_sid === original.listing_sid);
    check(current.length === 1 && sid(original.listing_sid) && current[0].source_sha256 === original.glb_sha256 && current[0].png_sha256 === original.png_sha256,
      "seed_listing_binding_mismatch");
    const expected = current[0], listing = one("avatar_listings", "avatar_listing_sid", expected.listing_sid);
    const avatar = one("avatars", "avatar_sid", expected.avatar_sid), kinds = ["gltf", "bin", "thumbnail"];
    check(listing.avatar_listing_id === expected.listing_id && listing.avatar_id === expected.avatar_id && avatar.avatar_id === expected.avatar_id &&
      avatar.account_id === listing.account_id && avatar.state === "active" && listing.state === "active", "seed_avatar_identity_mismatch");
    const owned = Object.fromEntries(kinds.map(kind => [kind, file(expected.files?.[kind], original.files?.[kind])]));
    check(kinds.every(kind => listing[`${kind}_owned_file_id`] === owned[kind].owned_file_id && avatar[`${kind}_owned_file_id`] === owned[kind].owned_file_id &&
      owned[kind].account_id === listing.account_id), "seed_avatar_relationship_mismatch");
    entries.push({ ...expected, name: original.name });
  }
  const assetRows = input.entries.map(entry => ({ stem: entry.stem, glb_sha256: entry.glb_sha256, png_sha256: entry.png_sha256, existing_listing: entry.existing_listing }));
  check(hash(JSON.stringify(assetRows)) === assetBinding && new Set(entries.map(entry => entry.listing_sid)).size === 33 &&
    equal(entries.filter(entry => preservedListings.includes(entry.listing_sid)).map(entry => entry.listing_sid).sort(), [...preservedListings].sort()), "seed_approved_asset_binding_mismatch");
  const graphFiles = Object.fromEntries(["model", "thumbnail", "scene", "project"].map(kind => [kind, file(graph.files?.[kind], input.graph.files?.[kind])]));
  const room = one("hubs", "hub_sid", graph.room_sid), scene = one("scenes", "scene_sid", graph.scene_sid);
  const listing = one("scene_listings", "scene_listing_sid", graph.scene_listing_sid), project = one("projects", "project_sid", graph.project_sid);
  const role = tables.hub_role_memberships[0];
  check(room.creator_assignment_token === null && room.scene_listing_id === listing.scene_listing_id && listing.scene_id === scene.scene_id && project.scene_id === scene.scene_id &&
    scene.account_id === project.created_by_account_id && room.created_by_account_id !== project.created_by_account_id &&
    role?.hub_id === room.hub_id && new Set([room.created_by_account_id, project.created_by_account_id, role.account_id]).size === 3 &&
    [scene, listing].every(row => row.state === "active" && row.model_owned_file_id === graphFiles.model.owned_file_id &&
      row.screenshot_owned_file_id === graphFiles.thumbnail.owned_file_id && row.scene_owned_file_id === graphFiles.scene.owned_file_id) &&
    project.project_owned_file_id === graphFiles.project.owned_file_id && project.thumbnail_owned_file_id === graphFiles.thumbnail.owned_file_id &&
    Object.values(graphFiles).every(row => row.account_id === project.created_by_account_id), "seed_graph_relationship_mismatch");
  check(tables.owned_files.length === 103 && tables.avatars.length === 33 && tables.avatar_listings.length === 33 &&
    ["hubs", "scenes", "scene_listings", "projects", "hub_role_memberships"].every(table => tables[table].length === 1) &&
    new Set(files.map(row => row.owned_file_uuid)).size === 103 && new Set(files.map(row => row.owned_file_id)).size === 103 &&
    files.every(row => tables.accounts.some(account => account.account_id === row.account_id)), "seed_exact_sql_graph_required");
  return { schema: 1, scope: restoreScope, crypto_domain: "unchanged-tracked-MIX_ENV-test-RetWeb.Endpoint-secret_key_base",
    fixture_kind: "Reticulum-MIX_ENV-test-public-fixture", dataset_binding_sha256: assetBinding, source_identity: before,
    sql_reference: { captured_on: "2026-10-04", capture_kind: "primary-source-only", sha256: expectedSqlSha256 },
    sequence: { name: "ret0.table_id_seq", last_value: "180", is_called: true, captured_on: "2026-10-04" },
    tables: Object.fromEntries(Object.entries(restoreTables).map(([table, columns]) => [table, { columns, rows: sortRows(tables[table].map(row => columns.map(column => row[column]))) }])),
    files: files.sort((a, b) => a.owned_file_uuid.localeCompare(b.owned_file_uuid, "en")), entries,
    graph: { ...graph, room_id: room.hub_id, room_owner_id: room.created_by_account_id, scene_id: scene.scene_id,
      scene_owner_id: scene.account_id, scene_listing_id: listing.scene_listing_id, project_id: project.project_id,
      project_owner_id: project.created_by_account_id, co_owner_id: role.account_id } };
}

function owned(io, filename, type, mode) {
  const stat = io.lstatSync(filename);
  check(io.realpathSync(filename) === filename && !stat.isSymbolicLink() && stat.uid === process.getuid() && (type === "directory" ? stat.isDirectory() : stat.isFile()) &&
    (mode === undefined ? (stat.mode & 0o022) === 0 : (stat.mode & 0o777) === mode), "seed_private_owned_direct_path_required");
  return stat;
}
function absent(io, filename) {
  try { io.lstatSync(filename); fail("seed_source_postmaster_present"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// io is a test seam for in-memory false fixtures; CLI always uses node:fs.
export function inspectCatalogSeed(seedSource, { testConfigSha, io = fs, bind = bindCatalogSeed } = {}) {
  check(/^\/private\/tmp\/ynret-local-[A-Za-z0-9]+$/.test(seedSource) && io.realpathSync(seedSource) === seedSource, "owned_synthetic_seed_source_required");
  owned(io, seedSource, "directory", 0o700);
  owned(io, path.join(seedSource, "database"), "directory", 0o700);
  absent(io, path.join(seedSource, "database/postmaster.pid"));
  const snapshots = [];
  const read = (relative, privateFile = true) => {
    const filename = path.join(seedSource, relative);
    for (let parent = path.dirname(filename); parent !== seedSource; parent = path.dirname(parent)) owned(io, parent, "directory");
    const stat = owned(io, filename, "file", privateFile ? 0o600 : undefined), bytes = io.readFileSync(filename);
    check(bytes.length === stat.size && bytes.length <= 128 * 1024 * 1024, "seed_file_size_mismatch");
    snapshots.push({ path: relative, sha256: hash(bytes), bytes: bytes.length }); return bytes;
  };
  check(read("database/PG_VERSION").toString().trim() === "14", "seed_native_major14_required");
  check(digest(testConfigSha) && hash(read("reticulum/config/test.exs", false)) === testConfigSha, "seed_fixture_crypto_config_mismatch");
  const sql = read("catalog-native.sql"), summary = JSON.parse(read("summary.json")), readback = JSON.parse(read("catalog-readback.json")), input = JSON.parse(read("catalog-input/input.json"));
  const binding = bind({ summary, input, readback, sql: sql.toString("utf8") });
  binding.fixture_config_sha256 = testConfigSha;
  const storage = "reticulum/storage/test/owned", media = [];
  const walk = relative => {
    const filename = path.join(seedSource, relative); owned(io, filename, "directory");
    for (const name of io.readdirSync(filename).sort()) {
      check(!name.includes("/") && name !== "." && name !== "..", "seed_unsafe_media_path");
      const child = `${relative}/${name}`, stat = io.lstatSync(path.join(seedSource, child));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child);
      else { read(child); media.push(child); }
    }
  };
  walk(storage);
  const expected = binding.files.flatMap(row => ["blob", "meta.json"].map(extension => `${storage}/${row.owned_file_uuid.slice(0, 2)}/${row.owned_file_uuid.slice(2, 4)}/${row.owned_file_uuid}.${extension}`)).sort();
  check(equal(media.sort(), expected), "seed_exact_media_pairs_required");
  for (const row of binding.files) {
    const base = `${storage}/${row.owned_file_uuid.slice(0, 2)}/${row.owned_file_uuid.slice(2, 4)}/${row.owned_file_uuid}`;
    const blob = snapshots.find(item => item.path === `${base}.blob`), meta = snapshots.find(item => item.path === `${base}.meta.json`);
    check(blob.bytes >= 12, "seed_ciphertext_header_required");
    Object.assign(row, { blob_sha256: blob.sha256, blob_bytes: blob.bytes, meta_sha256: meta.sha256, meta_bytes: meta.bytes });
    const metadata = JSON.parse(io.readFileSync(path.join(seedSource, `${base}.meta.json`)));
    check(metadata.content_type === row.content_type && String(metadata.content_length) === row.content_length, "seed_metadata_sql_mismatch");
  }
  snapshots.sort((a, b) => a.path.localeCompare(b.path, "en"));
  binding.source_files = snapshots;
  binding.pair_binding_sha256 = hash(JSON.stringify(snapshots));
  const assertUnchanged = () => {
    const current = inspectCatalogSeed(seedSource, { testConfigSha, io, bind });
    check(equal(current.binding, binding), "seed_source_changed_during_restore");
  };
  return { binding, sql, source: seedSource, assertUnchanged };
}

export function prepareCatalogSeedRestore({ seedSource, work, testConfigSha, io = fs }) {
  return copyCatalogSeedRestore(inspectCatalogSeed(seedSource, { testConfigSha, io }), work, { io });
}

// Pure copy lane shared by the driver and false-fixture tests. Native input
// selection/approval stays in prepareCatalogSeedRestore above.
export function copyCatalogSeedRestore(seed, work, { io = fs } = {}) {
  const seedSource = seed.source;
  check(/^\/private\/tmp\/ynret-local-[A-Za-z0-9]+$/.test(work) && io.realpathSync(work) === work &&
    work !== seedSource && !work.startsWith(seedSource + "/") && !seedSource.startsWith(work + "/"), "distinct_owned_restore_destination_required");
  owned(io, work, "directory", 0o700);
  const bundle = path.join(work, "catalog-restore"), storage = path.join(work, "reticulum/storage/test");
  // Every output is exclusive; never clobber an earlier attempt or original.
  io.mkdirSync(bundle, { mode: 0o700 });
  io.mkdirSync(storage, { recursive: true, mode: 0o700 });
  for (let parent = storage; parent !== work; parent = path.dirname(parent)) owned(io, parent, "directory");
  io.mkdirSync(path.join(storage, "owned"), { mode: 0o700 });
  for (const item of seed.binding.source_files.filter(row => row.path === "catalog-native.sql" || row.path.startsWith("reticulum/storage/test/owned/"))) {
    const destination = item.path === "catalog-native.sql" ? path.join(bundle, "catalog-native.sql") : path.join(storage, path.relative("reticulum/storage/test", item.path));
    io.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    for (let parent = path.dirname(destination); parent !== work; parent = path.dirname(parent)) owned(io, parent, "directory");
    io.copyFileSync(path.join(seedSource, item.path), destination, fs.constants.COPYFILE_EXCL); io.chmodSync(destination, 0o600);
    owned(io, destination, "file", 0o600);
    check(hash(io.readFileSync(destination)) === item.sha256, "seed_pair_copy_hash_mismatch");
  }
  const bindingFile = path.join(bundle, "binding.json");
  io.writeFileSync(bindingFile, JSON.stringify(seed.binding, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  seed.assertUnchanged();
  const assertDestinationUnchanged = () => {
    check(hash(io.readFileSync(bindingFile)) === hash(JSON.stringify(seed.binding, null, 2) + "\n"), "restore_binding_changed");
    for (const item of seed.binding.source_files.filter(row => row.path === "catalog-native.sql" || row.path.startsWith("reticulum/storage/test/owned/"))) {
      const destination = item.path === "catalog-native.sql" ? path.join(bundle, "catalog-native.sql") : path.join(storage, path.relative("reticulum/storage/test", item.path));
      owned(io, destination, "file", 0o600);
      check(hash(io.readFileSync(destination)) === item.sha256, "restore_pair_changed");
    }
    owned(io, bindingFile, "file", 0o600);
  };
  assertDestinationUnchanged();
  return { ...seed, bindingFile, sqlFile: path.join(bundle, "catalog-native.sql"), storage, assertDestinationUnchanged };
}

export function restorePsqlArguments({ work, data, port, sqlFile }) {
  check(/^\/private\/tmp\/ynret-local-[A-Za-z0-9]+$/.test(work) && data === path.join(work, "database") &&
    sqlFile === path.join(work, "catalog-restore/catalog-native.sql") && Number.isInteger(port) && port >= 1024 && port <= 65535,
    "explicit_owned_psql_restore_required");
  return ["-X", "-h", path.join(work, "socket"), "-p", String(port), "-U", "profile_test", "-d", "ret_test", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", sqlFile];
}

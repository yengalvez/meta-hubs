import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bindCatalogSeed, catalogSqlRows, catalogRestoreArguments, copyCatalogSeedRestore, designatedSeedSqlSha256, hash, inspectCatalogSeed, restorePsqlArguments, restoreScope, restoreTables } from "./catalog-seed-restore.mjs";
import { runtimeCases } from "./reticulum-local.mjs";
import { preservedListings } from "./catalog-dataset.mjs";

// Entirely false data in this test's in-memory FS. These strings are not real
// seed/cache paths; no tmp files, native PG/BEAM, account or crypto keys exist.
const source = "/private/tmp/ynret-local-FalseSeed", work = "/private/tmp/ynret-local-FalseDestination";
const config = Buffer.from("public false fixture config, never real key material\n"), testConfigSha = hash(config);
const uuid = index => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const fileId = index => String(9007199254740993n + BigInt(index));

function fixture() {
  const tables = Object.fromEntries(Object.keys(restoreTables).map(table => [table, []]));
  tables.accounts = ["101", "102", "103"].map(account_id => ({ account_id }));
  const input = { schema: 1, scope: "owned-synthetic-catalog-not-production-or-cycles", entries: [],
    graph: { scope: "native-synthetic-room-project-graph-not-current-metaverse", files: {} } };
  const readback = { scope: "native-synthetic-catalog-not-restore-or-browser-or-cycles", models: 33, listings: 33, owned_pairs: 103, preserved: 7, entries: [],
    graph: { scope: input.graph.scope, rooms: 1, scenes: 1, scene_listings: 1, projects: 1, co_owner_roles: 1, distinct_room_project_owners: true,
      room_sid: "Actual7", scene_sid: "Scene77", scene_listing_sid: "ScLst77", project_sid: "Prj7777", files: {} } };
  const media = [];
  const addFile = (index, account, contentType) => {
    const plaintext = Buffer.from(`false plaintext ${index}`), ownedUUID = uuid(index);
    tables.owned_files.push({ owned_file_id: fileId(index), owned_file_uuid: ownedUUID, account_id: account,
      content_type: contentType, content_length: String(plaintext.length), state: "active", key: `false-sql-key-${index}` });
    const base = `reticulum/storage/test/owned/00/00/${ownedUUID}`;
    media.push({ path: `${base}.blob`, bytes: Buffer.from(`false NON-CRYPTO ciphertext ${index}`) },
      { path: `${base}.meta.json`, bytes: Buffer.from(JSON.stringify({ content_type: contentType, content_length: plaintext.length, promotion_token: null })) });
    return [{ path: `${source}/catalog-input/false-${index}`, sha256: hash(plaintext), size: plaintext.length, content_type: contentType },
      { owned_file_id: fileId(index), uuid: ownedUUID, plaintext_sha256: hash(plaintext) }];
  };
  for (let index = 0; index < 33; index++) {
    const listing_sid = preservedListings[index] ?? `Aa${String(index).padStart(5, "0")}`, avatar_sid = `Av${String(index).padStart(5, "0")}`;
    const original = { stem: `False${index}`, name: `False avatar ${index}`, glb_sha256: hash(`false original ${index}`), png_sha256: hash(`false png ${index}`),
      existing_listing: preservedListings[index] ?? null, listing_sid, files: {} };
    const binding = { listing_sid, avatar_sid, avatar_id: String(200 + index), listing_id: String(300 + index),
      source_sha256: original.glb_sha256, png_sha256: original.png_sha256, files: {} };
    const references = {};
    for (const [offset, kind] of ["gltf", "bin", "thumbnail"].entries()) {
      const [file, expected] = addFile(index * 3 + offset, "101", ["model/gltf", "application/octet-stream", "image/png"][offset]);
      original.files[kind] = file; binding.files[kind] = expected; references[`${kind}_owned_file_id`] = expected.owned_file_id;
    }
    tables.avatars.push({ avatar_id: binding.avatar_id, avatar_sid, account_id: "101", ...references, state: "active" });
    tables.avatar_listings.push({ avatar_listing_id: binding.listing_id, avatar_listing_sid: listing_sid, avatar_id: binding.avatar_id, account_id: "101", ...references, state: "active" });
    input.entries.push(original); readback.entries.push(binding);
  }
  for (const [offset, kind] of ["model", "thumbnail", "scene", "project"].entries()) {
    const [file, expected] = addFile(99 + offset, "102", ["model/gltf-binary", "image/png", "application/json", "application/json"][offset]);
    input.graph.files[kind] = file;
    readback.graph.files[kind] = { uuid: expected.uuid, plaintext_sha256: expected.plaintext_sha256 };
  }
  const graphFiles = { model_owned_file_id: fileId(99), screenshot_owned_file_id: fileId(100), scene_owned_file_id: fileId(101), state: "active" };
  tables.hubs.push({ hub_id: "401", hub_sid: readback.graph.room_sid, created_by_account_id: "101", scene_listing_id: "501", creator_assignment_token: null });
  tables.scenes.push({ scene_id: "601", scene_sid: readback.graph.scene_sid, account_id: "102", ...graphFiles });
  tables.scene_listings.push({ scene_listing_id: "501", scene_listing_sid: readback.graph.scene_listing_sid, scene_id: "601", ...graphFiles });
  tables.projects.push({ project_id: "701", project_sid: readback.graph.project_sid, created_by_account_id: "102", scene_id: "601", project_owned_file_id: fileId(102), thumbnail_owned_file_id: fileId(100) });
  tables.hub_role_memberships.push({ hub_id: "401", account_id: "103" });
  const assetBinding = hash(JSON.stringify(input.entries.map(entry => ({ stem: entry.stem, glb_sha256: entry.glb_sha256, png_sha256: entry.png_sha256, existing_listing: entry.existing_listing }))));
  input.binding = readback.binding = assetBinding;
  const identity = { ".": "d52e25f9bf4f787de6190f26a0260ce5deaf94f9", hubs: "2a3d7ab406466d6d69c6e0b8776df42fb7c1931e", "hubs-cloud": "cb15414037754a2dc4f08a1b375519bad7478958" };
  const summary = { phase: "terminal", outcome: "PASS", tests: 1, scope: "native-synthetic-reticulum-not-kubernetes-or-production",
    catalog_source_before: identity, catalog_source_after: { ...identity }, metrics: { catalog: { models: 33, owned_pairs: 103, preserved: 7,
      sql_bytes: 375445, postgres_version: "postgres (PostgreSQL) 14.23 (Homebrew)", graph: readback.graph } } };
  const sqlFor = () => {
    let sql = "--\n-- PostgreSQL database dump\n-- Dumped from database version 14.23\n-- Dumped by pg_dump version 14.23\n";
    const encode = value => value === null ? "\\N" : value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    for (const [table, rows] of Object.entries(tables)) {
      const columns = [...restoreTables[table], ...(["avatar_listings", "scene_listings"].includes(table) ? ["order"] : []), ...(table === "owned_files" ? ["key"] : [])];
      sql += `COPY ret0.${table} (${columns.map(column => column === "order" ? '"order"' : column).join(", ")}) FROM stdin;\n`;
      sql += rows.map(row => columns.map(column => encode(column === "order" ? "10000" : row[column])).join("\t") + "\n").join("");
      sql += "\\.\n";
    }
    sql += "SELECT pg_catalog.setval('ret0.table_id_seq', 180, true);\n";
    sql += "--" + " ".repeat(375445 - Buffer.byteLength(sql) - 3) + "\n";
    return sql;
  };
  const sql = sqlFor();
  return { summary, input, readback, tables, media, assetBinding, sql, sqlSha256: hash(sql), sqlFor };
}

function memoryFs() {
  const nodes = new Map([["/", { type: "directory", mode: 0o700, uid: process.getuid() }]]);
  const error = code => Object.assign(new Error(code), { code });
  const get = filename => { if (!nodes.has(filename)) throw error("ENOENT"); return nodes.get(filename); };
  const mkdir = (filename, options = {}) => {
    if (nodes.has(filename)) { if (options.recursive && get(filename).type === "directory") return; throw error("EEXIST"); }
    if (options.recursive && !nodes.has(path.dirname(filename))) mkdir(path.dirname(filename), options);
    nodes.set(filename, { type: "directory", mode: options.mode ?? 0o700, uid: process.getuid() });
  };
  const io = {
    nodes, mkdirSync: mkdir,
    realpathSync(filename) {
      for (let current = filename; current !== "/"; current = path.dirname(current)) {
        const node = get(current);
        if (node.type === "symlink" || (node.realpath && node.realpath !== current)) return "/false-symlink-target";
      }
      return filename;
    },
    lstatSync(filename) { const node = get(filename); return { ...node, size: node.bytes?.length ?? 0,
      isFile: () => node.type === "file", isDirectory: () => node.type === "directory", isSymbolicLink: () => node.type === "symlink" }; },
    readFileSync(filename) { return Buffer.from(get(filename).bytes); },
    readdirSync(filename) { get(filename); return [...nodes.keys()].filter(child => path.dirname(child) === filename).map(child => path.basename(child)); },
    writeFileSync(filename, bytes, options = {}) {
      if (options.flag === "wx" && nodes.has(filename)) throw error("EEXIST");
      nodes.set(filename, { type: "file", bytes: Buffer.from(bytes), mode: options.mode ?? 0o600, uid: process.getuid() });
    },
    copyFileSync(from, to, flags) { assert.equal(flags, fs.constants.COPYFILE_EXCL); if (nodes.has(to)) throw error("EEXIST"); io.writeFileSync(to, io.readFileSync(from), { mode: 0o600 }); },
    chmodSync(filename, mode) { get(filename).mode = mode; }
  };
  return io;
}

function virtualSeed(value = fixture()) {
  const io = memoryFs();
  const add = (relative, bytes, mode = 0o600) => {
    const filename = path.join(source, relative); io.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); io.writeFileSync(filename, bytes, { mode });
  };
  add("database/PG_VERSION", "14\n"); add("reticulum/config/test.exs", config, 0o644);
  add("catalog-native.sql", value.sql); add("summary.json", JSON.stringify(value.summary));
  add("catalog-readback.json", JSON.stringify(value.readback)); add("catalog-input/input.json", JSON.stringify(value.input));
  for (const item of value.media) add(item.path, item.bytes);
  io.mkdirSync(work, { mode: 0o700 }); io.mkdirSync(path.join(work, "reticulum"), { mode: 0o700 });
  const options = { testConfigSha, io, bind: data => bindCatalogSeed(data, value.assetBinding, value.sqlSha256) };
  return { io, value, options, inspect: () => inspectCatalogSeed(source, options) };
}

test("restore opt-in is closed, exact and selects one NEW native case", () => {
  const args = ["--catalog-restore", "--pg-bin", "/false/pg/bin", "--cache-reticulum", "/false/cache", "--seed-source", source, "--hex-cache", "/false/hex"];
  assert.deepEqual(runtimeCases(args[0]), [{ profile: "catalog-restore", count: 1 }]);
  assert.equal(catalogRestoreArguments(args).seedSource, source);
  for (const mutate of [a => a.pop(), a => a.push("extra"), a => a[0] = "--catalog-graph-dataset", a => a[5] = "--catalog-receipts", a => a[7] = "--fallback-hex",
    a => a[6] = "/tmp/ynret-local-FalseSeed", a => a[6] += "/reticulum", a => a[4] = "relative/cache", a => a[2] += "/../bin", a => a[8] = "--network"]) {
    const changed = [...args]; mutate(changed);
    assert.throws(() => catalogRestoreArguments(changed), /explicit_catalog_restore_target_required/);
  }
});

test("original false COPY rows bind every key/ID/relationship and real source SID, not fabricated constants", () => {
  const value = fixture(), binding = bindCatalogSeed(value, value.assetBinding, value.sqlSha256);
  assert.equal(binding.scope, restoreScope); assert.equal(binding.files.length, 103);
  assert.equal(binding.entries.length, 33); assert.equal(binding.graph.room_sid, "Actual7");
  assert.equal(binding.files[0].owned_file_id, "9007199254740993");
  assert.equal(binding.files[0].key_sha256, hash("false-sql-key-0"));
  assert.doesNotMatch(JSON.stringify(binding), /false-sql-key|"key":/);
  assert.equal(binding.graph.room_owner_id, "101"); assert.equal(binding.graph.project_owner_id, "102"); assert.equal(binding.graph.co_owner_id, "103");
  assert.throws(() => bindCatalogSeed(value), /seed_sql_reference_mismatch/, "native default never accepts a false SQL reference");
  assert.throws(() => bindCatalogSeed(value, undefined, value.sqlSha256), /synthetic_seed_readback_required/, "native asset pin also rejects a false asset binding");
});

test("binding rejects changed scope, acceptance receipt, catalogue identities and plaintext expectations", () => {
  for (const mutate of [v => v.summary.outcome = "FAIL", v => v.summary.tests = 2, v => v.summary.metrics.catalog.owned_pairs = 99,
    v => v.summary.metrics.catalog.postgres_version = "postgres (PostgreSQL) 12.22", v => v.summary.catalog_source_after["."] = "a".repeat(40),
    v => v.input.scope = "production", v => v.readback.owned_pairs = 99, v => v.readback.entries[0].listing_sid = "NoMatch",
    v => v.readback.entries[0].files.gltf.plaintext_sha256 = "0".repeat(64), v => v.readback.entries[0].files.gltf.owned_file_id = "1",
    v => v.readback.graph.room_sid = "ynCgHub", v => v.input.entries[0].glb_sha256 = "0".repeat(64), v => v.sql = v.sql.slice(1)]) {
    const value = fixture(); mutate(value);
    assert.throws(() => bindCatalogSeed(value, value.assetBinding, value.sqlSha256));
  }
});

test("designated historical source tuple is exact and never substituted by current target commits", () => {
  const target = { ".": "425a6b3b0fbec1e29be11e39561b6be2f6fc311e", hubs: "137eb876513ab272e6cabcba45ea0447c81120b9", "hubs-cloud": "81d5be0d13b67e487ffeebb81a2ea10f0c9d197b" };
  for (const name of Object.keys(target)) {
    const value = fixture();
    value.summary.catalog_source_before[name] = value.summary.catalog_source_after[name] = target[name];
    assert.throws(() => bindCatalogSeed(value, value.assetBinding, value.sqlSha256), /seed_source_identity_mismatch/);
  }
  const value = fixture(); value.summary.metrics.catalog.postgres_version = "postgres (PostgreSQL) 14.23";
  assert.throws(() => bindCatalogSeed(value, value.assetBinding, value.sqlSha256), /accepted_synthetic_seed_receipt_required/);
});

test("SQL reference captured today rejects changed/omitted setval even when file byte size is retained", () => {
  const value = fixture(), statement = "SELECT pg_catalog.setval('ret0.table_id_seq', 180, true);";
  for (const changed of [value.sql.replace("table_id_seq', 180", "table_id_seq', 181"),
    value.sql.replace(statement, "--" + " ".repeat(statement.length - 2))]) {
    assert.equal(Buffer.byteLength(changed), 375445);
    assert.throws(() => bindCatalogSeed({ ...value, sql: changed }, value.assetBinding, value.sqlSha256), /seed_sql_reference_mismatch/);
  }
  assert.throws(() => bindCatalogSeed(value, value.assetBinding, "0".repeat(64)), /seed_sql_reference_mismatch/);
  assert.throws(() => bindCatalogSeed(value, value.assetBinding), /seed_sql_reference_mismatch/, "CLI uses the one designated digest, never a fixture override");
  const binding = bindCatalogSeed(value, value.assetBinding, value.sqlSha256);
  assert.deepEqual(binding.sequence, { name: "ret0.table_id_seq", last_value: "180", is_called: true, captured_on: "2026-10-04" });
  assert.deepEqual(binding.sql_reference, { captured_on: "2026-10-04", capture_kind: "primary-source-only", sha256: value.sqlSha256 });
  assert.match(designatedSeedSqlSha256, /^[a-f0-9]{64}$/);
});

test("SQL relation and distinct ownership mutations fail despite preserved counts", () => {
  for (const mutate of [t => t.avatars[0].gltf_owned_file_id = t.avatars[1].gltf_owned_file_id,
    t => t.avatar_listings[0].account_id = "102", t => t.projects[0].scene_id = "999",
    t => t.hubs[0].created_by_account_id = "102", t => t.hub_role_memberships[0].account_id = "101",
    t => t.scenes[0].screenshot_owned_file_id = fileId(99), t => t.owned_files[102].account_id = "101",
    t => t.owned_files[0].state = "inactive", t => t.owned_files[0].owned_file_uuid = t.owned_files[1].owned_file_uuid]) {
    const value = fixture(); mutate(value.tables); value.sql = value.sqlFor();
    assert.throws(() => bindCatalogSeed(value, value.assetBinding, hash(value.sql)), "false-fixture digest seam keeps the relationship guard under test");
  }
});

test("COPY projection rejects incomplete, duplicate and external/metacommand dump targets", () => {
  const sql = fixture().sql;
  for (const changed of [sql.replace("COPY ret0.accounts", "COPY public.accounts"), sql.replace(" FROM stdin;", " TO PROGRAM 'false';"),
    sql.replace("\\.\n", "\\! false\n"), sql + "\\connect remote\n", sql + "\\copy x FROM '/outside'\n",
    sql.replace("account_id) FROM", "account_id, account_id) FROM"), sql.replace("101\n", "101\t102\n")])
    assert.throws(() => catalogSqlRows(changed));
  assert.doesNotThrow(() => catalogSqlRows(sql.replace("-- Dumped from", "\\restrict FalseToken77\n-- Dumped from") + "\\unrestrict FalseToken77\n"));
});

test("COPY identifier tokenizer normalizes quoted order and rejects duplicate or injected identifiers", () => {
  const sql = fixture().sql, rows = catalogSqlRows(sql);
  assert.equal(rows.avatar_listings[0].order, "10000"); assert.equal(rows.scene_listings[0].order, "10000");
  assert.deepEqual(catalogSqlRows(sql.replaceAll('"order"', "order")), rows);
  assert.deepEqual(catalogSqlRows(sql.replace("COPY ret0.accounts", 'COPY "ret0"."accounts"')), rows);
  for (const column of ['order, "order"', '"order"; DROP TABLE x;', '"order"."other"', '"order" || x', '"or""der"', '"ORDER"', '"order",', ', "order"'])
    assert.throws(() => catalogSqlRows(sql.replace('"order"', column)), /seed_copy_identifier_invalid|seed_copy_duplicate|seed_copy_external_target_forbidden|seed_copy_column_count_mismatch/);
});

test("COPY text decoding consumes escaped backslashes atomically and supports dump control/octet escapes", () => {
  const value = fixture();
  value.tables.owned_files[0].key = "false\\N\\u0000\t\nkey"; value.sql = value.sqlFor();
  const rows = catalogSqlRows(value.sql);
  assert.equal(rows.owned_files[0].key, value.tables.owned_files[0].key);
  const octal = value.sql.replace("false\\\\N\\\\u0000\\t\\nkey", "false\\134N\\x5cu0000\\t\\nkey");
  assert.equal(catalogSqlRows(octal).owned_files[0].key, value.tables.owned_files[0].key);
});

test("source-only false filesystem validates all 103 exact encrypted+metadata pairs and source snapshots", () => {
  const seed = virtualSeed(), inspected = seed.inspect();
  assert.equal(inspected.binding.source_files.filter(row => row.path.endsWith(".blob")).length, 103);
  assert.equal(inspected.binding.source_files.filter(row => row.path.endsWith(".meta.json")).length, 103);
  assert.equal(inspected.binding.pair_binding_sha256.length, 64);
  inspected.assertUnchanged();
  const before = [...seed.io.nodes].map(([name, node]) => [name, node.bytes?.toString("base64"), node.mode]);
  seed.inspect();
  assert.deepEqual([...seed.io.nodes].map(([name, node]) => [name, node.bytes?.toString("base64"), node.mode]), before, "source-only reads never write/chmod originals");
});

test("source rejects running PG, ownership/mode/symlink/config/pair alterations before copying", () => {
  for (const mutate of [s => s.io.writeFileSync(`${source}/database/postmaster.pid`, "false-pid"),
    s => s.io.nodes.get(source).mode = 0o755, s => s.io.nodes.get(source).realpath = "/other",
    s => s.io.nodes.get(`${source}/reticulum/storage/test/owned`).type = "symlink",
    s => s.io.nodes.get(`${source}/catalog-native.sql`).mode = 0o644, s => s.io.nodes.get(`${source}/catalog-readback.json`).uid++,
    s => s.io.nodes.get(`${source}/reticulum/config/test.exs`).bytes = Buffer.from("changed domain"),
    s => s.io.nodes.delete(`${source}/${s.value.media[0].path}`),
    s => s.io.writeFileSync(`${source}/reticulum/storage/test/owned/00/00/extra.blob`, "unexpected"),
    s => s.io.nodes.get(`${source}/${s.value.media[1].path}`).bytes = Buffer.from('{"content_type":"changed","content_length":17}')]) {
    const seed = virtualSeed(); mutate(seed);
    assert.throws(seed.inspect); assert.ok(!seed.io.nodes.has(`${work}/catalog-restore`));
  }
});

test("paired copy is no-clobber/private, binds physical bytes, and preserves fake source original", () => {
  const seed = virtualSeed(), inspected = seed.inspect(), before = new Map([...seed.io.nodes].filter(([name]) => name.startsWith(source)).map(([name, node]) => [name, { ...node }]));
  const copied = copyCatalogSeedRestore(inspected, work, { io: seed.io });
  assert.equal(copied.sqlFile, `${work}/catalog-restore/catalog-native.sql`);
  assert.equal(seed.io.nodes.get(copied.bindingFile).mode, 0o600);
  assert.equal(seed.io.nodes.get(`${work}/catalog-restore`).mode, 0o700);
  for (const item of seed.value.media) {
    const output = `${work}/${item.path}`;
    assert.equal(seed.io.nodes.get(output).mode, 0o600); assert.equal(hash(seed.io.readFileSync(output)), hash(item.bytes));
  }
  assert.deepEqual(new Map([...seed.io.nodes].filter(([name]) => name.startsWith(source))), before);
  assert.notEqual(inspected.binding.files[0].blob_bytes, Number(inspected.binding.files[0].content_length), "physical cipher bytes are not claimed as plaintext bytes");
  copied.assertDestinationUnchanged();
  assert.throws(() => copyCatalogSeedRestore(inspected, work, { io: seed.io }), /EEXIST/);
  assert.throws(() => copyCatalogSeedRestore(inspected, source, { io: seed.io }), /distinct_owned_restore_destination_required/);
});

test("copy refuses an existing media byte and rechecks source/destination pair drift", () => {
  const seed = virtualSeed(), inspected = seed.inspect();
  const destination = `${work}/${seed.value.media[0].path}`;
  seed.io.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); seed.io.writeFileSync(destination, "untouched existing byte");
  assert.throws(() => copyCatalogSeedRestore(inspected, work, { io: seed.io }), /EEXIST/);
  assert.equal(seed.io.readFileSync(destination).toString(), "untouched existing byte");
  const fresh = virtualSeed(), copied = copyCatalogSeedRestore(fresh.inspect(), work, { io: fresh.io });
  fresh.io.nodes.get(`${source}/${fresh.value.media[0].path}`).bytes = Buffer.from("changed source ciphertext");
  assert.throws(copied.assertUnchanged, /seed_source_changed_during_restore/);
  fresh.io.nodes.get(`${work}/${fresh.value.media[2].path}`).bytes = Buffer.from("changed destination ciphertext");
  assert.throws(copied.assertDestinationUnchanged, /restore_pair_changed/);
});

test("destination rechecks reject symlinked parents and never accept an existing owned subtree", () => {
  const seed = virtualSeed(), copied = copyCatalogSeedRestore(seed.inspect(), work, { io: seed.io });
  seed.io.nodes.get(`${work}/reticulum/storage/test/owned`).type = "symlink";
  assert.throws(copied.assertDestinationUnchanged, /seed_private_owned_direct_path_required/);
  const original = virtualSeed(); original.io.mkdirSync(`${work}/reticulum/storage/test/owned`, { recursive: true, mode: 0o700 });
  assert.throws(() => copyCatalogSeedRestore(original.inspect(), work, { io: original.io }), /EEXIST/);
});

test("psql restore arguments explicitly bind owned DB/socket/input and stop on SQL failure", () => {
  const context = { work, data: `${work}/database`, port: 18001, sqlFile: `${work}/catalog-restore/catalog-native.sql` };
  const argv = restorePsqlArguments(context);
  assert.deepEqual(argv, ["-X", "-h", `${work}/socket`, "-p", "18001", "-U", "profile_test", "-d", "ret_test", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", context.sqlFile]);
  for (const change of [{ work: "/tmp" }, { data: `${source}/database` }, { port: 543 }, { port: 65536 }, { sqlFile: `${source}/catalog-native.sql` }])
    assert.throws(() => restorePsqlArguments({ ...context, ...change }), /explicit_owned_psql_restore_required/);
});

test("native route has psql reload and exact storage/negative SQL readers, never seed generation or migration", () => {
  const driver = fs.readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
  const bootstrap = fs.readFileSync(new URL("./reticulum-local.exs", import.meta.url), "utf8");
  const native = fs.readFileSync(new URL("./reticulum-catalog-restore.exs", import.meta.url), "utf8");
  const restoreBranch = driver.slice(driver.indexOf("    if (restoreMode) {"), driver.indexOf("    if (socketMode) {", driver.indexOf("    if (restoreMode) {")));
  assert.match(restoreBranch, /prepareCatalogSeedRestore/); assert.match(restoreBranch, /restorePsqlArguments/);
  assert.match(restoreBranch, /assertPostmaster\(work, data, port, epoch\)/); assert.match(restoreBranch, /restore\.assertUnchanged\(\)/);
  assert.doesNotMatch(restoreBranch, /prepareCatalogDataset|pg_dump|local\.hex|\b(?:store|promote)\(/);
  assert.match(driver, /socketMode \|\| canaryHexCache \|\| restoreMode/);
  assert.match(bootstrap, /unless catalog_restore do\s+Mix\.Task\.run\("ecto.create"[\s\S]*Mix\.Task\.run\("ecto.migrate"/);
  assert.match(bootstrap, /default_transaction_read_only/);
  assert.match(native, /Storage\.fetch\(owned\) == \{:error, :not_allowed\}/);
  assert.match(native, /after\s+Application.put_env\(:ret, RetWeb.Endpoint, config\)/);
  assert.match(native, /sql_reload!\(binding\)/); assert.match(native, /Hub.is_owner\?/); assert.match(native, /Project.project_by_sid_for_account/);
  assert.match(native, /SELECT last_value::text,is_called FROM ret0.table_id_seq/);
  assert.doesNotMatch(native, /\bnextval\b|Mix\.Task\.run|setval\(/);
  assert.match(driver, /readback.sequence_verified !== true/);
  assert.doesNotMatch(native, /Storage\.(?:store|promote)|Repo\.(?:insert|update)|create_and_verify|PHX_KEY/);
  for (const [table, columns] of Object.entries(restoreTables)) assert.ok(native.includes(`"${table}" => [${columns.map(column => `"${column}"`).join(", ")}]`));
});

test("missing restore options fail finitely before any scratch/native invocation", () => {
  for (const args of [["--catalog-restore"], ["--catalog-restore", "--pg-bin", "/false", "--cache-reticulum", "/false", "--seed-source", source]]) {
    const result = spawnSync(process.execPath, [new URL("./reticulum-local.mjs", import.meta.url).pathname, ...args], {
      env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.match(result.stderr, /RET_LOCAL_FAIL:arguments:explicit_catalog_restore_target_required/);
  }
});

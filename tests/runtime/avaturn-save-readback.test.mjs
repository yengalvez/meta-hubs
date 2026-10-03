// Pure synthetic contracts only. No bootstrap/PG/HTTP/browser/provider runtime
// runs, and these controls do not prove SDK save, reload or native acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deflateSync } from "node:zlib";
import { validateReadback, readbackSql } from "./normal-glb-readback.mjs";
import {
  avaturnReadbackArguments, validateAvaturnReadback, avaturnReadbackSql, readbackRemaining,
  validateReadbackStorageMetadata, avaturnReadbackHttpRequest, validateReadbackHttpHeaders,
  readbackHttpLength, validateAvaturnMedia, validateAvaturnGeometry, unchangedReadbackPath, avaturnReadbackLimits
} from "./avaturn-save-readback.mjs";

const work = "/private/tmp/ynret-local-Abc123", pgBin = "/opt/homebrew/Cellar/postgresql@14/14.23/bin";
const args = ["--work", work, "--avatar-sid", "Ab123Xy", "--pg-bin", pgBin];
const context = { work, data: `${work}/database`, socket: `${work}/socket`, home: `${work}/home`,
  pgBin, psql: `${pgBin}/psql`, sid: args[3], accountId: "784512345678901234", port: 15439, epoch: 1780000000 };
const clone = value => structuredClone(value);
function bootstrap() {
  return { schema: 1, kind: "reticulum-profile-avaturn-save", mode: "avaturn-save",
    ws_url: "ws://127.0.0.1:18444/socket", browser_origin: "http://127.0.0.1:18443",
    hub_sid: "Local77", auth_token: "local.local.local", backend_pid: 123,
    source: { root: "f".repeat(40), hubs: "d".repeat(40), cloud: "2".repeat(40) },
    app_config_provenance: "Ret.ProductModules.project_config/committed-SQL",
    app_config: { features: { enable_room_bots: false, enable_bot_chat: false, enable_avaturn_creator: true },
      links: { avaturn_creator: "https://virtualmente.avaturn.dev" } },
    auth_bootstrap: "local-native-guardian", auth_email: "ui-socket-99@example.invalid", account_id: context.accountId,
    reticulum_origin: "http://127.0.0.1:18444", storage_origin: "http://127.0.0.1:18444" };
}
function readback() {
  return { identity: { data: context.data, port: String(context.port), user: "profile_test", database: "ret_test", read_only: "on" },
    creator_configs: [{ value: { value: false }, owned_file_absent: true }],
    avatars: [{ sid: context.sid, owner: context.accountId, name: "Mi avatar Avaturn", state: "active", allow_remixing: false,
      allow_promotion: false, listings: "0", parents_absent: true, extra_files_absent: true,
      files: ["gltf", "bin", "thumbnail"].map((role, i) => ({ role, id: String(i + 1),
        uuid: `00000000-0000-4000-8000-00000000000${i}`, owner: context.accountId, state: "active", bytes: "4",
        type: { gltf: "model/gltf", bin: "application/octet-stream", thumbnail: "image/png" }[role] })) }] };
}
function gltf() {
  return { asset: { version: "2.0" }, buffers: [{ byteLength: 96 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }, { buffer: 0, byteOffset: 48, byteLength: 48 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5121, count: 3, type: "VEC4" }, { bufferView: 2, componentType: 5126, count: 3, type: "VEC4" }],
    nodes: [{ mesh: 0, skin: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    skins: [{ joints: [0] }], scenes: [{ nodes: [0] }], scene: 0 };
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width = 720, height = 1280, filter = 0) {
  const chunk = (type, body) => {
    const bytes = Buffer.alloc(body.length + 12); bytes.writeUInt32BE(body.length);
    bytes.write(type, 4, 4, "ascii"); body.copy(bytes, 8); bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height); raw[0] = filter;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const media = () => ({ gltf: Buffer.from(JSON.stringify(gltf())), bin: Buffer.alloc(96), thumbnail: png() });
const response = (file, patch = {}) => ({ status: 200, body: {}, headers: new Headers({ "content-type": file.type, "content-length": file.bytes }), ...patch });

test("closed arguments require private local target, exact SID and installed PG 14.23 path", () => {
  assert.deepEqual(avaturnReadbackArguments(args), { work, sid: context.sid, pgBin });
  for (const values of [[], ["--work", "/tmp/ynret-local-Abc123", ...args.slice(2)],
    ["--work", `${work}/../other`, ...args.slice(2)], ["--work", work, "--avatar-sid", "abcd", "--pg-bin", pgBin],
    [...args.slice(0, 5), "/usr/bin"], [...args.slice(0, 5), pgBin.replace("14.23", "14.24")],
    [...args, "--force"], [...args, "--asset", "/approved.glb"]]) assert.throws(() => avaturnReadbackArguments(values));
  assert.equal(avaturnReadbackLimits.totalMs, 20000);
});

test("new shared validator preserves the old GLB wrapper and enforces exact Avaturn private name", () => {
  assert.deepEqual(Object.keys(validateAvaturnReadback(readback(), context)).sort(), ["bin", "gltf", "thumbnail"]);
  assert.throws(() => validateReadback(readback(), context), /private_avatar_mismatch/);
  const normal = readback(); normal.avatars[0].name = "GLB local privado probado";
  assert.equal(Object.keys(validateReadback(normal, context)).length, 3);
  assert.throws(() => validateAvaturnReadback(normal, context), /private_avatar_mismatch/);
  for (const patch of [{ owner: Number(context.accountId) }, { owner: "1" }, { sid: "Another" }, { name: "Mi avatar Avaturn " },
    { state: "removed" }, { allow_remixing: true }, { allow_remixing: null }, { allow_promotion: true },
    { listings: "1" }, { listings: 0 }, { parents_absent: false }, { extra_files_absent: false }]) {
    const value = readback(); Object.assign(value.avatars[0], patch);
    assert.throws(() => validateAvaturnReadback(value, context), /private_avatar_mismatch/);
  }
  for (const rows of [null, [], [readback().avatars[0], readback().avatars[0]]])
    assert.throws(() => validateAvaturnReadback({ ...readback(), avatars: rows }, context), /exact_private_avatar_required/);
});

test("ownership, role, SQL ID, UUID and size are exact with no duplicate or fourth file", () => {
  for (const mutate of [f => f.pop(), f => f.push(clone(f[0])), f => f[1].id = f[0].id, f => f[1].uuid = f[0].uuid,
    f => f[1].role = f[0].role, f => f[1].owner = "1", f => f[1].state = "removed", f => f[1].type = "text/html",
    f => f[1].uuid = "../local", f => f[1].id = "9223372036854775808", f => f[1].bytes = "0", f => f[1].bytes = 4,
    f => f[1].bytes = "67108865", f => f[2].bytes = "5242881"]) {
    const value = readback(); mutate(value.avatars[0].files);
    assert.throws(() => validateAvaturnReadback(value, context), /three_owned_files_required|owned_file_mismatch/);
  }
});

test("current committed config requires exactly one false JSON wrapper, not stale bootstrap or primitives", () => {
  assert.equal(Object.keys(validateAvaturnReadback(readback(), context)).length, 3);
  assert.equal(bootstrap().app_config.features.enable_avaturn_creator, true, "initial bootstrap stays immutable and is not current config");
  for (const wrapper of [{ value: true }, { value: null }, null, false, "false", [], {},
    { value: "false" }, { value: 0 }, { value: false, extra: true }, { other: false }]) {
    const value = readback(); value.creator_configs[0].value = wrapper;
    assert.throws(() => validateAvaturnReadback(value, context), /committed_creator_off_required/);
  }
  for (const rows of [null, [], [null], [readback().creator_configs[0], readback().creator_configs[0]],
    [{ value: { value: false }, owned_file_absent: false }]])
    assert.throws(() => validateAvaturnReadback({ ...readback(), creator_configs: rows }, context), /committed_creator_off_required/);
  const missing = readback(); delete missing.creator_configs;
  assert.throws(() => validateAvaturnReadback(missing, context), /committed_creator_off_required/);
});

test("SQL identity rejects other ports, peers, databases and write-capable sessions", () => {
  for (const patch of [{ data: "/another/database" }, { port: "5432" }, { port: context.port },
    { user: "postgres" }, { database: "production" }, { read_only: "off" }]) {
    const value = readback(); Object.assign(value.identity, patch);
    assert.throws(() => validateAvaturnReadback(value, context), /database_identity_mismatch/);
  }
  for (const patch of [{ work: "/tmp/ynret-local-Abc123" }, { data: "/another/database" }, { socket: "/tmp" },
    { home: "/Users/other" }, { pgBin: "/usr/bin" }, { psql: "/bin/sh" }, { port: 5432 }, { port: 65536 },
    { epoch: "1; SELECT secret" }, { epoch: -1 }, { epoch: Date.now() / 1000 + 1 }, { sid: "a';SELECT" }]) {
    assert.throws(() => avaturnReadbackSql({ ...context, ...patch }));
    assert.throws(() => validateAvaturnReadback(readback(), { ...context, ...patch }));
  }
});

test("epoch guard precedes unchanged read-only row/file query without secret columns or writes", () => {
  const sql = avaturnReadbackSql(context), original = readbackSql(context);
  assert.ok(sql.startsWith(original.slice(0, original.indexOf("SELECT json_build_object("))));
  assert.ok(sql.endsWith(original.slice(original.indexOf("SELECT json_build_object(") + "SELECT json_build_object(".length)));
  assert.ok(sql.indexOf("pg_postmaster_start_time()") < sql.indexOf("SELECT json_build_object("));
  assert.match(sql, /floor\(extract\(epoch FROM pg_postmaster_start_time\(\)\)\)::bigint = 1780000000/);
  assert.match(sql, /transaction_read_only'\) = 'on'/);
  assert.match(sql, /current_user = 'profile_test' AND current_database\(\) = 'ret_test'/);
  assert.match(sql, /json_agg\(json_build_object\('value', cfg\.value,/);
  assert.match(sql, /'owned_file_absent', cfg\.owned_file_id IS NULL/);
  assert.match(sql, /FROM ret0\.app_configs cfg WHERE cfg\.key = 'features\|enable_avaturn_creator'/);
  assert.match(sql, /statement_timeout = '3000ms'/); assert.match(sql, /lock_timeout = '500ms'/);
  assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/); assert.match(sql, /ROLLBACK;$/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|COPY|LOCK|GRANT|token)\b/i);
  assert.doesNotMatch(sql, /f\.key|auth_token|promotion_token/);
});

test("metadata equals SQL type/length and encrypted local blob envelope stays bounded", () => {
  const file = readback().avatars[0].files[1], meta = { content_type: file.type, content_length: 4 };
  assert.equal(validateReadbackStorageMetadata(meta, file, 16), true);
  assert.equal(validateReadbackStorageMetadata(meta, file, 27), true);
  for (const [value, size] of [[{ ...meta, content_type: "text/html" }, 16], [{ ...meta, content_length: 5 }, 17],
    [{ ...meta, content_length: "4" }, 16], [meta, 15], [meta, 28], [meta, 16.5], [null, 16]])
    assert.throws(() => validateReadbackStorageMetadata(value, file, size), /owned_storage_metadata_mismatch/);
});

test("HTTP request only targets bootstrap native loopback storage with no credentials or redirect", () => {
  const file = readback().avatars[0].files[1], value = bootstrap(), deadline = performance.now() + 1000;
  const request = avaturnReadbackHttpRequest(value, file, deadline);
  assert.equal(request.url, `${value.storage_origin}/files/${file.uuid}`);
  assert.deepEqual({ ...request.options, signal: undefined }, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: undefined });
  assert.equal(new URL(request.url).search, ""); assert.equal(new URL(request.url).username, "");
  for (const patch of [{ storage_origin: "https://remote.invalid" }, { storage_origin: "http://localhost:18444" },
    { storage_origin: "http://127.0.0.1:18445" }, { reticulum_origin: "http://127.0.0.1:18445" }, { kind: "reticulum-profile-normal-glb" }])
    assert.throws(() => avaturnReadbackHttpRequest({ ...value, ...patch }, file, deadline));
  for (const patch of [{ uuid: "../remote" }, { role: "other" }, { type: "text/html" }, { bytes: "67108865" }, { bytes: "0" }, { bytes: 4 }])
    assert.throws(() => avaturnReadbackHttpRequest(value, { ...file, ...patch }, deadline));
});

test("HTTP headers and streamed size reject errors, compression, truncation and overflow", () => {
  const file = readback().avatars[0].files[1];
  assert.equal(validateReadbackHttpHeaders(response(file), file), true);
  for (const patch of [{ status: 302 }, { status: 404 }, { body: null },
    { headers: new Headers({ "content-type": file.type, "content-length": "5" }) },
    { headers: new Headers({ "content-type": "text/html", "content-length": file.bytes }) },
    { headers: new Headers({ "content-type": file.type, "content-length": file.bytes, "content-encoding": "gzip" }) }])
    assert.throws(() => validateReadbackHttpHeaders(response(file, patch), file));
  assert.equal(readbackHttpLength(0, 2, 4), 2); assert.equal(readbackHttpLength(2, 2, 4, true), 4);
  for (const values of [[0, 5, 4], [2, 1, 4, true], [-1, 2, 4], [0, -1, 4], [0, 1.5, 4], [0, 1, 0]])
    assert.throws(() => readbackHttpLength(...values));
  assert.equal(readbackRemaining(20000, 5000, 0), 5000);
  assert.equal(readbackRemaining(20000, 5000, 19000), 1000);
  for (const now of [20000, 21000, NaN]) assert.throws(() => readbackRemaining(20000, 5000, now), /readback_deadline/);
});

test("plaintext glTF/BIN and exact 720x1280 PNG pass structure/CRC/pixel checks, not preservation", () => {
  assert.deepEqual(validateAvaturnMedia(media()), { width: 720, height: 1280 });
  for (const mutate of [g => g.buffers[0].uri = "remote.bin", g => g.skins = [], g => g.bufferViews[0].byteLength = 97,
    g => g.extras = { url: "relative" }, g => g.extras = { note: "https://remote.invalid" },
    g => g.extras = { nested: [{ source: "file:///private/local" }] }, g => g.extras = { source: "data:secret" }]) {
    const value = media(), model = gltf(); mutate(model); value.gltf = Buffer.from(JSON.stringify(model));
    assert.throws(() => validateAvaturnMedia(value));
  }
  for (const thumbnail of [png(1, 1), png(1280, 720), png(720, 1280, 5), Buffer.from("not-png")])
    assert.throws(() => validateAvaturnMedia({ ...media(), thumbnail }));
  const broken = media(); broken.thumbnail[20] ^= 1;
  assert.throws(() => validateAvaturnMedia(broken), /invalid_png_crc/);
  assert.throws(() => validateAvaturnMedia({ ...media(), gltf: Buffer.from([0xff]) }), /invalid_plaintext_gltf/);
});

test("Avaturn geometry refuses empty primitives, dangling references and accessor/view overflow", () => {
  assert.equal(validateAvaturnGeometry(gltf()), true);
  for (const componentType of [5121, 5123]) {
    const normalized = gltf(); Object.assign(normalized.accessors[2], { componentType, normalized: true });
    assert.equal(validateAvaturnGeometry(normalized), true);
    normalized.accessors[2].normalized = false;
    assert.throws(() => validateAvaturnGeometry(normalized), /invalid_gltf_geometry/);
    delete normalized.accessors[2].normalized;
    assert.throws(() => validateAvaturnGeometry(normalized), /invalid_gltf_geometry/);
  }
  for (const mutate of [g => g.accessors = [], g => g.meshes[0].primitives = [{}],
    g => delete g.meshes[0].primitives[0].attributes.POSITION, g => g.meshes[0].primitives[0].attributes.POSITION = 3,
    g => g.meshes[0].primitives[0].indices = 3, g => g.meshes[0].primitives[0].indices = 0,
    g => g.meshes[0].primitives[0].material = 0, g => g.nodes[0].mesh = 1, g => g.nodes[0].skin = 1,
    g => g.nodes[0].children = [1], g => g.scenes[0].nodes = [1], g => g.scene = 1,
    g => g.skins[0].joints = [1], g => g.skins[0].joints = [0, 0], g => g.skins[0].skeleton = 1,
    g => g.skins[0].inverseBindMatrices = 0, g => g.accessors[0].bufferView = 3,
    g => g.accessors[0].count = 4, g => g.accessors[0].byteOffset = 1,
    g => g.bufferViews[0].byteStride = 8, g => g.accessors[1].type = "VEC3",
    g => g.accessors[2].count = 2, g => g.meshes[0].primitives[0].targets = [{ POSITION: 3 }],
    g => g.accessors[0].sparse = { count: 4, indices: { bufferView: 1, componentType: 5121 }, values: { bufferView: 0 } }]) {
    const value = gltf(); mutate(value);
    assert.throws(() => validateAvaturnGeometry(value), /invalid_gltf_geometry/);
  }
});

test("context recheck refuses changed inode/socket/owner/mode and metadata timestamps or bytes", () => {
  const stat = { dev: 1, ino: 2, uid: 501, mode: 0o100600, size: 100, mtimeMs: 123, ctimeMs: 123 };
  assert.equal(unchangedReadbackPath(stat, { ...stat }, true), true);
  for (const patch of [{ dev: 2 }, { ino: 3 }, { uid: 502 }, { mode: 0o100644 }, { size: 101 }, { mtimeMs: 124 }, { ctimeMs: 124 }])
    assert.throws(() => unchangedReadbackPath(stat, { ...stat, ...patch }, true), /native_context_changed/);
  // Directory entries may change without replacing the owned directory itself.
  assert.equal(unchangedReadbackPath(stat, { ...stat, mtimeMs: 124 }), true);
});

test("readback entry point is read-only, has closed redacted output and enforces native checks before/after", () => {
  const source = fs.readFileSync(new URL("./avaturn-save-readback.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fs\.(write|append|mkdir|chmod|rm|unlink|rename|copyFile)|\bspawn\(|PGPASSWORD|process\.env|\.auth_token|\.promotion_token|onSave\(|validateAvatarMaterials|validateAvatarStructure|splitOriginalGlb/);
  assert.deepEqual([...source.matchAll(/\b(\w+)\.key\b/g)].map(match => match[1]), ["cfg"], "only the non-secret config key column is referenced");
  assert.match(source, /validateAvaturnBootstrap/); assert.match(source, /boundaryPostmaster/); assert.match(source, /boundaryPsqlOptions/);
  assert.match(source, /O_RDONLY \| fs\.constants\.O_NOFOLLOW/);
  assert.match(source, /process\.kill\(bootstrap\.backend_pid, 0\)/); assert.match(source, /process\.kill\(postmaster\.pid, 0\)/);
  assert.match(source, /"status", "--porcelain", "--untracked-files=all"/);
  assert.equal((source.match(/"--no-optional-locks", "-C", repository/g) || []).length, 2);
  assert.match(source, /GIT_OPTIONAL_LOCKS: "0"/);
  assert.match(source, /GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "\/dev\/null"/);
  assert.match(source, /head\.stdout\.trim\(\) !== bootstrap\.source\[name\]/);
  assert.equal((source.match(/recheck\(\);/g) || []).length, 2);
  assert.match(source, /isDeepStrictEqual\(query\(context, deadline\), files\)/);
  assert.doesNotMatch(source, /process\.(stdout|stderr)\.write\([^\n]*(error|result\.stdout|bootstrap|file\.uuid)/);
  const failureCodes = [...source.matchAll(/(?:let failureCode =|failureCode =) "([a-z_]+)"/g)].map(match => match[1]);
  assert.deepEqual(failureCodes, ["arguments", "native_context", "read_only_sql", "owned_http_media", "media_integrity", "unchanged_native_context"]);
  assert.match(source, /pass: false, failure_code: failureCode/);
  assert.match(source, /creator_off: true/);
  assert.equal((source.match(/process\.stdout\.write/g) || []).length, 2);
});

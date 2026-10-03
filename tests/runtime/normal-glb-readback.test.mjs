import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deflateSync } from "node:zlib";
import { readbackArguments, validateReadback, validateGltf, validateAvatarStructure, validateAvatarMaterials, splitOriginalGlb, validatePng, readbackSql } from "./normal-glb-readback.mjs";

const args = ["--work", "/private/tmp/ynret-local-Abc123", "--avatar-sid", "Ab123Xy", "--asset", "/approved/Bata.glb", "--pg-bin", "/explicit/postgres/bin"];
const peer = { data: `${args[1]}/database`, port: 55483, sid: args[3], accountId: "784512345678901234" };
const clone = value => structuredClone(value);
function readback() {
  return {
    identity: { data: peer.data, port: String(peer.port), user: "profile_test", database: "ret_test", read_only: "on" },
    avatars: [{ sid: peer.sid, owner: peer.accountId, name: "GLB local privado probado", state: "active", allow_remixing: false,
      allow_promotion: false, listings: "0", parents_absent: true, extra_files_absent: true,
      files: ["gltf", "bin", "thumbnail"].map((role, i) => ({ role, id: String(i + 1),
        uuid: `00000000-0000-4000-8000-00000000000${i}`, owner: peer.accountId, state: "active", bytes: "4",
        type: { gltf: "model/gltf", bin: "application/octet-stream", thumbnail: "image/png" }[role] })) }]
  };
}
function gltf() {
  return { asset: { version: "2.0" }, buffers: [{ byteLength: 4 }], bufferViews: [{ buffer: 0, byteLength: 4 }],
    nodes: [{ mesh: 0, skin: 0 }], meshes: [{ primitives: [{}] }], skins: [{ joints: [0] }], scenes: [{ nodes: [0] }], scene: 0 };
}
function glb() {
  let json = Buffer.from(JSON.stringify(gltf()));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const bytes = Buffer.alloc(28 + json.length + 4);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  bytes.writeUInt32LE(4, 20 + json.length); bytes.writeUInt32LE(0x004e4942, 24 + json.length);
  Buffer.from([1, 2, 3, 4]).copy(bytes, 28 + json.length);
  return bytes;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png(raw = Buffer.from([0, 1, 2, 3, 255])) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("CLI requires one explicit private local target, SID, approved GLB and PostgreSQL bin", () => {
  assert.deepEqual(readbackArguments(args), { work: args[1], sid: args[3], asset: args[5], pgBin: args[7] });
  for (const mutate of [a => a.pop(), a => a.push("--extra"), a => a[0] = "--all", a => a[1] = "/tmp/ynret-local-Abc123",
    a => a[1] += "/../other", a => a[1] += "'", a => a[3] = "x';DROP", a => a[5] = "Bata.glb", a => a[5] += ".json", a => a[7] = "bin"])
    assert.throws(() => { const value = [...args]; mutate(value); readbackArguments(value); }, /explicit_local_readback_required/);
});

test("peer identity requires native owned data, port, synthetic role/database and read-only transaction", () => {
  for (const field of ["data", "port", "user", "database", "read_only"]) {
    const value = readback(); value.identity[field] = "other";
    assert.throws(() => validateReadback(value, peer), /database_identity_mismatch/);
  }
});

test("private avatar preserves int64 owner text and exact deliberate name with zero listings", () => {
  assert.deepEqual(Object.keys(validateReadback(readback(), peer)).sort(), ["bin", "gltf", "thumbnail"]);
  for (const patch of [{ owner: Number(peer.accountId) }, { owner: "784512345678901235" }, { name: "Mi avatar GLB" }, { state: "removed" },
    { allow_remixing: true }, { allow_promotion: null }, { listings: "1" }, { listings: 0 }, { parents_absent: false }, { extra_files_absent: false }]) {
    const value = readback(); Object.assign(value.avatars[0], patch);
    assert.throws(() => validateReadback(value, peer), /private_avatar_mismatch/);
  }
  for (const rows of [null, [], [readback().avatars[0], readback().avatars[0]]])
    assert.throws(() => validateReadback({ ...readback(), avatars: rows }, peer), /exact_private_avatar_required/);
});

test("three owned pieces cannot duplicate IDs, UUIDs, roles or cross account boundaries", () => {
  for (const mutate of [f => f.pop(), f => f[1].id = f[0].id, f => f[1].uuid = f[0].uuid, f => f[1].role = f[0].role,
    f => f[1].owner = "1", f => f[1].bytes = "0", f => f[1].bytes = "67108865", f => f[1].bytes = 4,
    f => f[1].id = "9223372036854775808", f => f[1].uuid = "../file", f => f[1].state = "inactive", f => f[1].type = "text/html"])
    assert.throws(() => { const value = readback(); mutate(value.avatars[0].files); validateReadback(value, peer); }, /three_owned_files_required|owned_file_mismatch/);
});

test("SQL is one bounded read-only transaction with identity-fenced rows and no secrets", () => {
  const sql = readbackSql(peer);
  assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /statement_timeout = '3000ms'/); assert.match(sql, /lock_timeout = '500ms'/); assert.match(sql, /ROLLBACK;$/);
  assert.match(sql, /current_setting\('data_directory'\) = '\/private\/tmp\/ynret-local-Abc123\/database'/);
  assert.match(sql, /current_user = 'profile_test' AND current_database\(\) = 'ret_test'/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|COPY|key|token)\b/i);
});

test("GLB splitter returns its BIN chunk rather than treating the whole GLB as uploaded BIN", () => {
  const original = glb(), split = splitOriginalGlb(original);
  assert.deepEqual(split.gltf, gltf()); assert.deepEqual(split.bin, Buffer.from([1, 2, 3, 4]));
  assert.notDeepEqual(split.bin, original);
  for (const mutate of [b => b.writeUInt32LE(0, 0), b => b.writeUInt32LE(1, 4), b => b.writeUInt32LE(1, 8),
    b => b.writeUInt32LE(0, 16), b => b.writeUInt32LE(0, b.length - 8), b => b.writeUInt32LE(8, b.length - 12)])
    assert.throws(() => { const value = Buffer.from(original); mutate(value); splitOriginalGlb(value); }, /invalid_original_glb/);
  assert.throws(() => splitOriginalGlb(original.subarray(0, -1)), /invalid_original_glb/);
});

test("glTF requires self-contained skinned structure and bounded BIN views", () => {
  assert.deepEqual(validateGltf(gltf(), 4), gltf());
  for (const mutate of [g => g.skins = [], g => g.buffers[0].uri = "http://remote.invalid/bin", g => g.buffers[0].byteLength = 5,
    g => g.bufferViews[0].byteLength = 5, g => g.bufferViews[0].byteOffset = -1, g => g.bufferViews[0].buffer = 1,
    g => g.images = [{ uri: "file:///private/secret" }], g => g.images = [{ bufferView: 9, mimeType: "image/png" }]])
    assert.throws(() => { const value = clone(gltf()); mutate(value); validateGltf(value, 4); }, /invalid_gltf_structure|external_or_invalid_gltf_image/);
});

function annotatedStructure() {
  const original = { ...gltf(), asset: { version: "2.0", generator: "approved" },
    nodes: [{ mesh: 0, skin: 0, translation: [1, 2, 3] }, { mesh: 1 }, { name: "joint" }, { name: "untouched", isBone: false }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }, { primitives: [{}], isSkinnedMesh: false }],
    skins: [{ joints: [2], skeleton: 2, inverseBindMatrices: 1 }],
    materials: [{ name: "Body", doubleSided: true }], extras: { approved: "metadata" }, unknownFutureField: { preserved: true } };
  const expected = clone(original);
  expected.nodes[2].isBone = true;
  expected.meshes[0].isSkinnedMesh = true;
  expected.materials[0].name = "Bot_PBS";
  return { original, expected };
}

test("complete glTF comparison permits only exact loader marks plus separately checked material rename", () => {
  const { original, expected } = annotatedStructure(), before = clone(original);
  assert.equal(validateAvatarStructure(expected, original), true);
  assert.equal(validateAvatarMaterials(expected, original), true);
  assert.deepEqual(original, before, "loader expectations must not mutate the approved source");
  // _markDefs assigns true even when a referenced original flag was false.
  original.nodes[2].isBone = false; original.meshes[0].isSkinnedMesh = false;
  assert.equal(validateAvatarStructure(expected, original), true);
});

test("complete glTF comparison models splitter JSON serialization of negative zero in nodes and metadata", () => {
  const { original, expected } = annotatedStructure();
  original.nodes[0].translation[0] = expected.nodes[0].translation[0] = -0;
  original.extras.offset = expected.extras.offset = -0;
  const serialized = JSON.parse(JSON.stringify(expected));
  assert.equal(Object.is(original.nodes[0].translation[0], -0), true);
  assert.equal(Object.is(original.extras.offset, -0), true);
  assert.equal(Object.is(serialized.nodes[0].translation[0], 0), true);
  assert.equal(Object.is(serialized.extras.offset, 0), true);
  assert.equal(validateAvatarStructure(serialized, original), true);
});

test("loader marks reject stray, absent and wrong-valued flags while preserving unrelated original flags", () => {
  const { original, expected } = annotatedStructure();
  for (const mutate of [g => g.nodes[0].isBone = true, g => g.nodes[2].isBone = false, g => g.nodes[2].isBone = "true",
    g => { delete g.nodes[2].isBone; }, g => g.meshes[1].isSkinnedMesh = true, g => g.meshes[0].isSkinnedMesh = false,
    g => g.meshes[0].isSkinnedMesh = 1, g => { delete g.meshes[0].isSkinnedMesh; },
    g => { delete g.nodes[3].isBone; }, g => { delete g.meshes[1].isSkinnedMesh; }]) {
    const changed = clone(expected); mutate(changed);
    assert.throws(() => validateAvatarStructure(changed, original), /original_gltf_structure_mismatch/);
  }
});

test("complete non-material comparison rejects changed transforms, geometry, skins, metadata and unknown fields", () => {
  const { original, expected } = annotatedStructure();
  for (const mutate of [g => g.nodes[0].translation[0] = 99, g => g.meshes[0].primitives[0].attributes.POSITION = 2,
    g => g.meshes[0].primitives[0].indices = 3, g => g.bufferViews[0].byteLength = 3,
    g => g.skins[0].joints[0] = 3, g => g.skins[0].inverseBindMatrices = 2,
    g => g.asset.generator = "changed", g => g.extras.approved = "changed",
    g => g.unknownFutureField.preserved = false, g => { delete g.unknownFutureField; }, g => g.newUnknownField = true]) {
    const changed = clone(expected); mutate(changed);
    assert.throws(() => validateAvatarStructure(changed, original), /original_gltf_structure_mismatch/);
  }
});

function materialGltf() {
  return { ...gltf(), materials: [
    { name: "Body", pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0.25, 1], baseColorTexture: { index: 0 }, metallicFactor: 0 }, alphaMode: "BLEND", doubleSided: true },
    { name: "Eyes", emissiveFactor: [0.1, 0.2, 0.3] }
  ], nodes: [{ children: [2] }, { mesh: 1 }, { mesh: 0 }],
  meshes: [{ primitives: [{}, { material: 1 }, { material: 0 }] }, { primitives: [{ material: 0 }] }],
  scenes: [{ nodes: [0, 1] }] };
}

test("materials allow only the exact product rename with its node queue and first defined primitive", () => {
  const original = materialGltf(), expected = clone(original);
  expected.materials[0].name = "Bot_PBS"; // Node 1 precedes node 0's child in the product queue.
  assert.equal(validateAvatarMaterials(expected, original), true);
  assert.equal(original.materials[0].name, "Body", "the approved original must not be modified");
  const wrongQueue = clone(original); wrongQueue.materials[1].name = "Bot_PBS";
  assert.throws(() => validateAvatarMaterials(wrongQueue, original), /original_materials_mismatch/);
  const primitiveOriginal = clone(original); primitiveOriginal.scenes[0].nodes = [2];
  const primitiveExpected = clone(primitiveOriginal); primitiveExpected.materials[1].name = "Bot_PBS";
  assert.equal(validateAvatarMaterials(primitiveExpected, primitiveOriginal), true);
});

test("an existing Bot_PBS authorizes no additional rename or material change", () => {
  const original = materialGltf(); original.materials[1].name = "Bot_PBS";
  assert.equal(validateAvatarMaterials(clone(original), original), true);
  const changed = clone(original); changed.materials[0].name = "Bot_PBS";
  assert.throws(() => validateAvatarMaterials(changed, original), /original_materials_mismatch/);
});

test("same BIN and structure cannot hide altered material color, transparency, textures or other names", () => {
  const original = materialGltf(), expected = clone(original); expected.materials[0].name = "Bot_PBS";
  for (const mutate of [m => m[0].pbrMetallicRoughness.baseColorFactor[0] = 0,
    m => m[0].alphaMode = "OPAQUE", m => m[0].pbrMetallicRoughness.baseColorTexture.index = 1,
    m => m[0].doubleSided = false, m => m[1].emissiveFactor[0] = 1, m => m[1].name = "other",
    m => m[0].name = "Body", m => m[0].extensions = { altered: true }]) {
    const changed = clone(expected); mutate(changed.materials);
    assert.throws(() => validateAvatarMaterials(changed, original), /original_materials_mismatch/);
  }
});

test("PNG checks chunks, CRC, decompressed scanline length and filters without rendering", () => {
  assert.deepEqual(validatePng(png()), { width: 1, height: 1 });
  const broken = png(); broken[20] ^= 1;
  assert.throws(() => validatePng(broken), /invalid_png_crc/);
  assert.throws(() => validatePng(Buffer.concat([png(), Buffer.from([1])])), /invalid_png/);
  assert.throws(() => validatePng(png().subarray(0, -1)), /invalid_png/);
  assert.throws(() => validatePng(png(Buffer.from([5, 1, 2, 3, 255]))), /invalid_png_pixels/);
  assert.throws(() => validatePng(png(Buffer.from([0, 1]))), /invalid_png_pixels/);
});

test("helper has no mutators, credentials, query URLs, browser automation or receipt writes", () => {
  const source = fs.readFileSync(new URL("./normal-glb-readback.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fs\.(write|append|mkdir|chmod|rm|unlink|rename|copyFile)|PGPASSWORD|meta\.promotion_token|\.auth_token|\.key\b|onSave\(/);
  assert.match(source, /method: "GET", redirect: "error"/);
  assert.match(source, /PGPASSFILE: "\/dev\/null"/);
  assert.match(source, /scope = "local-not-production-not-six-profiles"/);
  assert.match(source, /validateAvatarMaterials\(gltf, original\.gltf\)/);
  assert.match(source, /validateAvatarStructure\(gltf, original\.gltf\)/);
  assert.doesNotMatch(source, /process\.(stdout|stderr)\.write\([^\n]*(error|result\.stdout|bootstrap|file\.uuid)/);
});

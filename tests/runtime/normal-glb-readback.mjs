// Run only AFTER real AvatarEditor onSave + browser reload, BEFORE native STOP.
// Read-only peer evidence, not browser/visual/production or six-profile acceptance.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { validateNormalGlbBootstrap } from "./reticulum-local.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scope = "local-not-production-not-six-profiles";
const maxModel = 64 * 1024 * 1024, maxPng = 5 * 1024 * 1024;
const fail = code => { throw new Error(code); };
const decimal = value => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function readbackArguments(args) {
  if (args.length !== 8 || args[0] !== "--work" || args[2] !== "--avatar-sid" || args[4] !== "--asset" || args[6] !== "--pg-bin" ||
      !/^\/private\/tmp\/ynret-local-[A-Za-z0-9_-]+$/.test(args[1]) || !/^[A-Za-z0-9]{7}$/.test(args[3]) ||
      !path.isAbsolute(args[5]) || !args[5].toLowerCase().endsWith(".glb") || !path.isAbsolute(args[7])) fail("explicit_local_readback_required");
  return { work: args[1], sid: args[3], asset: args[5], pgBin: args[7] };
}

export function validateReadback(value, { data, port, sid, accountId }) {
  const identity = value?.identity;
  if (!identity || identity.data !== data || identity.port !== String(port) || identity.user !== "profile_test" ||
      identity.database !== "ret_test" || identity.read_only !== "on") fail("database_identity_mismatch");
  const rows = value.avatars;
  if (!Array.isArray(rows) || rows.length !== 1) fail("exact_private_avatar_required");
  const avatar = rows[0];
  if (!decimal(accountId) || avatar.sid !== sid || avatar.owner !== accountId || avatar.name !== "GLB local privado probado" ||
      avatar.state !== "active" || avatar.allow_remixing !== false || avatar.allow_promotion !== false || avatar.listings !== "0" ||
      avatar.parents_absent !== true || avatar.extra_files_absent !== true) fail("private_avatar_mismatch");
  if (!Array.isArray(avatar.files) || avatar.files.length !== 3) fail("three_owned_files_required");
  const types = { gltf: "model/gltf", bin: "application/octet-stream", thumbnail: "image/png" };
  const roles = new Set(), ids = new Set(), uuids = new Set();
  for (const file of avatar.files) {
    if (!file || !Object.hasOwn(types, file.role) || roles.has(file.role) || !decimal(file.id) || ids.has(file.id) ||
        !uuid(file.uuid) || uuids.has(file.uuid) || file.owner !== accountId || file.state !== "active" || file.type !== types[file.role] ||
        !decimal(file.bytes) || BigInt(file.bytes) > BigInt(file.role === "thumbnail" ? maxPng : maxModel)) fail("owned_file_mismatch");
    roles.add(file.role); ids.add(file.id); uuids.add(file.uuid);
  }
  return Object.fromEntries(avatar.files.map(file => [file.role, file]));
}

export function validateGltf(gltf, binLength) {
  if (!gltf || gltf.asset?.version !== "2.0" || !Array.isArray(gltf.buffers) || gltf.buffers.length !== 1 ||
      !Number.isInteger(gltf.buffers[0].byteLength) || gltf.buffers[0].byteLength < 1 ||
      gltf.buffers[0].byteLength > binLength || binLength - gltf.buffers[0].byteLength > 3 ||
      Object.hasOwn(gltf.buffers[0], "uri") || !Array.isArray(gltf.nodes) || !gltf.nodes.length ||
      !Array.isArray(gltf.meshes) || !gltf.meshes.length || !Array.isArray(gltf.skins) || !gltf.skins.length ||
      !Array.isArray(gltf.scenes) || !gltf.scenes[gltf.scene ?? 0]?.nodes?.length ||
      !Array.isArray(gltf.bufferViews) || !gltf.bufferViews.length) fail("invalid_gltf_structure");
  for (const view of gltf.bufferViews) {
    const offset = view.byteOffset ?? 0;
    if (view.buffer !== 0 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(view.byteLength) || view.byteLength < 1 ||
        offset + view.byteLength > gltf.buffers[0].byteLength) fail("invalid_gltf_structure");
  }
  for (const image of gltf.images || []) {
    // This approved GLB must remain self-contained; never follow model URLs.
    if (Object.hasOwn(image, "uri") || !Number.isInteger(image.bufferView) || !gltf.bufferViews[image.bufferView] ||
        !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)) fail("external_or_invalid_gltf_image");
  }
  return gltf;
}

export function validateAvatarMaterials(gltf, original) {
  if (!Array.isArray(original.materials)) fail("original_materials_required");
  const materials = structuredClone(original.materials);
  // Mirror ONLY ensureAvatarMaterial's exact selection/name assignment
  // (hubs/src/utils/avatar-utils.js:63-85); every other property stays intact.
  if (!materials.find(material => material.name === "Bot_PBS")) {
    const materialForMesh = mesh => {
      if (!mesh.primitives) return;
      const primitive = mesh.primitives.find(p => p.material !== undefined);
      return primitive && materials[primitive.material];
    };
    let nodes = original.scenes[original.scene].nodes.slice(0);
    while (nodes.length) {
      const node = original.nodes[nodes.shift()];
      const material = node.mesh !== undefined && materialForMesh(original.meshes[node.mesh]);
      if (material) { material.name = "Bot_PBS"; break; }
      if (node.children) nodes = nodes.concat(node.children);
    }
  }
  if (!isDeepStrictEqual(gltf.materials, materials)) fail("original_materials_mismatch");
  return true;
}

export function splitOriginalGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 28 || bytes.length > maxModel || bytes.readUInt32LE(0) !== 0x46546c67 ||
      bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail("invalid_original_glb");
  const jsonLength = bytes.readUInt32LE(12), binHeader = 20 + jsonLength;
  if (jsonLength % 4 !== 0 || bytes.readUInt32LE(16) !== 0x4e4f534a || binHeader + 8 > bytes.length ||
      bytes.readUInt32LE(binHeader + 4) !== 0x004e4942 || bytes.readUInt32LE(binHeader) % 4 !== 0 ||
      binHeader + 8 + bytes.readUInt32LE(binHeader) !== bytes.length) fail("invalid_original_glb");
  let gltf;
  try { gltf = JSON.parse(bytes.subarray(20, binHeader).toString("utf8")); } catch { fail("invalid_original_glb_json"); }
  const bin = bytes.subarray(binHeader + 8);
  validateGltf(gltf, bin.length);
  return { gltf, bin };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validatePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > maxPng ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail("invalid_png");
  let offset = 8, dimensions, ended = false, idatEnded = false;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) fail("invalid_png");
    const type = bytes.toString("ascii", offset + 4, offset + 8), body = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail("invalid_png_crc");
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) fail("invalid_png");
      const width = body.readUInt32BE(0), height = body.readUInt32BE(4);
      const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[body[9]];
      // Real canvas snapshots use 8-bit, non-interlaced PNG. Reject an unrelated image format.
      if (!width || !height || width > 4096 || height > 4096 || body[8] !== 8 || !channels || body[10] || body[11] || body[12]) fail("invalid_png_header");
      dimensions = { width, height, rowBytes: width * channels + 1 };
    } else if (type === "IHDR") fail("invalid_png");
    if (type === "IDAT") {
      if (idatEnded) fail("invalid_png");
      data.push(body);
    } else if (data.length) idatEnded = true;
    if (type === "IEND") {
      if (length || end !== bytes.length || !data.length) fail("invalid_png");
      ended = true; break;
    }
    offset = end;
  }
  if (!ended) fail("invalid_png");
  let raw;
  try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: 32 * 1024 * 1024 }); } catch { fail("invalid_png_pixels"); }
  if (raw.length !== dimensions.rowBytes * dimensions.height) fail("invalid_png_pixels");
  for (let row = 0; row < dimensions.height; row++) if (raw[row * dimensions.rowBytes] > 4) fail("invalid_png_pixels");
  return { width: dimensions.width, height: dimensions.height };
}

function ownedPath(file, type, mode) {
  const stat = fs.lstatSync(file);
  if (stat.uid !== process.getuid() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file) ||
      (type === "directory" ? !stat.isDirectory() : type === "socket" ? !stat.isSocket() : !stat.isFile()) ||
      (mode !== undefined && (stat.mode & 0o777) !== mode) || (type !== "socket" && (stat.mode & 0o022))) fail("unowned_or_unsafe_local_path");
  return stat;
}

function readOwned(file, maximum, mode) {
  ownedPath(file, "file", mode);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size < 1 || stat.size > maximum) fail("invalid_local_metadata_size");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function readbackSql({ data, port, sid }) {
  const literal = text => "'" + String(text).replaceAll("'", "''") + "'";
  // No key/token columns. The row subquery is fenced by the expected peer identity.
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '3000ms'; SET LOCAL lock_timeout = '500ms';
SELECT json_build_object('identity', json_build_object('data', current_setting('data_directory'), 'port', current_setting('port'),
  'user', current_user, 'database', current_database(), 'read_only', current_setting('transaction_read_only')),
  'avatars', (SELECT json_agg(json_build_object('sid', a.avatar_sid, 'owner', a.account_id::text, 'name', a.name,
    'state', a.state::text, 'allow_remixing', a.allow_remixing, 'allow_promotion', a.allow_promotion,
    'listings', (SELECT count(*)::text FROM ret0.avatar_listings l WHERE l.avatar_id = a.avatar_id),
    'parents_absent', a.parent_avatar_id IS NULL AND a.parent_avatar_listing_id IS NULL,
    'extra_files_absent', a.base_map_owned_file_id IS NULL AND a.emissive_map_owned_file_id IS NULL AND a.normal_map_owned_file_id IS NULL AND a.orm_map_owned_file_id IS NULL,
    'files', (SELECT json_agg(json_build_object('role', refs.role, 'id', f.owned_file_id::text, 'uuid', f.owned_file_uuid,
      'owner', f.account_id::text, 'state', f.state::text, 'type', f.content_type, 'bytes', f.content_length::text) ORDER BY refs.role)
      FROM (VALUES ('gltf', a.gltf_owned_file_id), ('bin', a.bin_owned_file_id), ('thumbnail', a.thumbnail_owned_file_id)) refs(role, id)
      JOIN ret0.owned_files f ON f.owned_file_id = refs.id)))
    FROM ret0.avatars a WHERE a.avatar_sid = ${literal(sid)} AND current_setting('data_directory') = ${literal(data)}
      AND current_setting('port') = ${literal(port)} AND current_user = 'profile_test' AND current_database() = 'ret_test'));
ROLLBACK;`;
}

async function main() {
  let phase = "arguments";
  try {
    const args = readbackArguments(process.argv.slice(2));
    if (process.platform !== "darwin") fail("local_macos_required");
    const deadline = performance.now() + 20000, { work, sid, asset } = args;
    phase = "private-native-context";
    for (const directory of [work, path.join(work, "database"), path.join(work, "socket"), path.join(work, "home")]) ownedPath(directory, "directory", 0o700);
    const bootstrap = validateNormalGlbBootstrap(JSON.parse(readOwned(path.join(work, "normal-glb-socket-bootstrap.json"), 65536, 0o600)));
    for (const [name, repository] of [["root", root], ["hubs", path.join(root, "hubs")], ["cloud", path.join(root, "hubs-cloud")]]) {
      const head = spawnSync("/usr/bin/git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 2000, maxBuffer: 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
      if (head.status !== 0 || head.stdout.trim() !== bootstrap.source[name]) fail("bootstrap_source_mismatch");
    }
    process.kill(bootstrap.backend_pid, 0);
    const data = path.join(work, "database"), fields = readOwned(path.join(data, "postmaster.pid"), 4096, 0o600).toString("utf8").split("\n");
    const pid = Number(fields[0]), port = Number(fields[3]);
    if (!Number.isInteger(pid) || pid < 2 || fields[1] !== data || !/^[0-9]+$/.test(fields[2]) || Number(fields[2]) > Date.now() / 1000 ||
        !Number.isInteger(port) || port < 1024 || port > 65535 || fields[4] !== path.join(work, "socket") || fields[5] !== "127.0.0.1") fail("postmaster_identity_mismatch");
    process.kill(pid, 0);
    ownedPath(path.join(work, "socket", `.s.PGSQL.${port}`), "socket");
    const pgBin = fs.realpathSync(args.pgBin), psql = path.join(pgBin, "psql");
    if (!fs.statSync(pgBin).isDirectory() || !fs.statSync(psql).isFile()) fail("explicit_psql_required");
    fs.accessSync(psql, fs.constants.X_OK);
    const originalBytes = readOwned(asset, maxModel), originalHash = sha(originalBytes), original = splitOriginalGlb(originalBytes);
    phase = "read-only-sql-peer";
    const peer = { data, port, sid, accountId: bootstrap.account_id };
    const result = spawnSync(psql, ["-X", "--no-password", "-qAt", "-h", path.join(work, "socket"), "-p", String(port), "-U", "profile_test", "-d", "ret_test", "-v", "ON_ERROR_STOP=1"], {
      input: readbackSql(peer), encoding: "utf8", timeout: 6000, maxBuffer: 65536,
      env: { PATH: `${pgBin}:/usr/bin:/bin`, HOME: path.join(work, "home"), LC_ALL: "C", PGCONNECT_TIMEOUT: "2", PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null", PGSYSCONFDIR: path.join(work, "home") }
    });
    if (result.status !== 0 || !result.stdout?.trim()) fail("read_only_peer_query_failed");
    const files = validateReadback(JSON.parse(result.stdout), peer), media = {};
    phase = "native-owned-http-media";
    for (const [role, file] of Object.entries(files)) {
      const directory = path.join(work, "reticulum/storage/test/owned", file.uuid.slice(0, 2), file.uuid.slice(2, 4));
      ownedPath(directory, "directory");
      const meta = JSON.parse(readOwned(path.join(directory, `${file.uuid}.meta.json`), 16384));
      if (meta.content_type !== file.type || String(meta.content_length) !== file.bytes || !ownedPath(path.join(directory, `${file.uuid}.blob`), "file").size) fail("owned_storage_metadata_mismatch");
      const remaining = Math.min(5000, deadline - performance.now());
      if (remaining < 1) fail("readback_deadline");
      // OwnedFile lookup + native Ret.Storage decryption; no query/key/token needed.
      const response = await fetch(`${bootstrap.storage_origin}/files/${file.uuid}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(Math.floor(remaining)) });
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== file.type || response.headers.get("content-length") !== file.bytes) fail("owned_http_response_mismatch");
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > Number(file.bytes)) fail("owned_http_size_mismatch"); chunks.push(chunk); }
      if (length !== Number(file.bytes)) fail("owned_http_size_mismatch");
      media[role] = Buffer.concat(chunks);
    }
    phase = "gltf-bin-png-integrity";
    const gltf = validateGltf(JSON.parse(media.gltf.toString("utf8")), media.bin.length);
    if (!media.bin.equals(original.bin)) fail("original_bin_mismatch");
    validateAvatarMaterials(gltf, original.gltf);
    // Non-material model structure must remain unchanged too.
    for (const field of ["nodes", "skins", "meshes", "accessors", "bufferViews", "animations", "scenes", "scene", "images", "textures", "buffers"])
      if (JSON.stringify(gltf[field]) !== JSON.stringify(original.gltf[field])) fail("original_gltf_structure_mismatch");
    const png = validatePng(media.thumbnail);
    if (sha(readOwned(asset, maxModel)) !== originalHash) fail("original_asset_changed");
    process.stdout.write(JSON.stringify({ scope, status: "PASS", sql_read_only: true, private_avatar: true, owned_files: 3,
      bin_matches_original: true, bin_bytes: media.bin.length, gltf_structure: true, materials_preserved: true, png_structure: true,
      thumbnail_width: png.width, thumbnail_height: png.height, original_unchanged: true }) + "\n");
  } catch {
    // Never print exception messages, private rows, paths, credentials or URLs.
    process.stdout.write(JSON.stringify({ scope, status: "FAIL", failed_check: phase }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

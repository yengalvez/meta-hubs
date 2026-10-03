// Run AFTER observed SDK onSave + real API reload with creator OFF, BEFORE STOP.
// Read-only native peer evidence; not SDK preservation, browser or live acceptance.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateAvaturnBootstrap } from "./reticulum-local.mjs";
import { boundaryPostmaster, validateBoundaryContext, boundaryPsqlOptions } from "./avaturn-save-sql-boundary.mjs";
import { readbackSql, validatePrivateAvatarReadback, validateGltf, validatePng } from "./normal-glb-readback.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pgPath = "/opt/homebrew/Cellar/postgresql@14/14.23/bin";
const fail = code => { throw new Error(code); };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const avaturnReadbackLimits = Object.freeze({ totalMs: 20000, httpMs: 5000, sqlMs: 6000, modelBytes: 64 * 1024 * 1024, pngBytes: 5 * 1024 * 1024 });

export function avaturnReadbackArguments(args) {
  if (args.length !== 6 || args[0] !== "--work" || args[2] !== "--avatar-sid" || args[4] !== "--pg-bin" ||
      !/^\/private\/tmp\/ynret-local-[A-Za-z0-9_-]+$/.test(args[1]) || !/^[A-Za-z0-9]{7}$/.test(args[3]) || args[5] !== pgPath)
    fail("explicit_owned_readback_required");
  return { work: args[1], sid: args[3], pgBin: args[5] };
}

export function validateAvaturnReadback(value, context) {
  validateBoundaryContext(context);
  if (!/^[A-Za-z0-9]{7}$/.test(context.sid)) fail("invalid_owned_readback_context");
  const files = validatePrivateAvatarReadback(value, context, "Mi avatar Avaturn");
  const rows = value.creator_configs, wrapper = rows?.[0]?.value;
  // AppConfig changeset persists primitives inside %{value: ...}; the initial
  // bootstrap is immutable and is deliberately NOT current config evidence.
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.owned_file_absent !== true ||
      !wrapper || typeof wrapper !== "object" || Array.isArray(wrapper) ||
      Object.keys(wrapper).join(",") !== "value" || wrapper.value !== false) fail("committed_creator_off_required");
  return files;
}

export function avaturnReadbackSql(context) {
  validateBoundaryContext(context);
  if (!/^[A-Za-z0-9]{7}$/.test(context.sid)) fail("invalid_owned_readback_context");
  // Reuse the original exact row/file query, adding a read-only epoch guard
  // before its SELECT. No credentials, query text or other session IDs leave PG.
  const sql = readbackSql(context), marker = "SELECT json_build_object(", start = sql.indexOf(marker);
  if (start < 0) fail("readback_sql_contract_changed");
  const literal = text => "'" + String(text).replaceAll("'", "''") + "'";
  const guard = `DO $owned_readback$ BEGIN IF NOT (current_setting('data_directory') = ${literal(context.data)}
    AND current_setting('port') = ${literal(context.port)} AND current_user = 'profile_test' AND current_database() = 'ret_test'
    AND current_setting('transaction_read_only') = 'on'
    AND floor(extract(epoch FROM pg_postmaster_start_time()))::bigint = ${context.epoch}) THEN
    RAISE EXCEPTION 'owned_readback_identity_mismatch'; END IF; END $owned_readback$;\n`;
  const committedConfig = `'creator_configs', (SELECT json_agg(json_build_object('value', cfg.value,
    'owned_file_absent', cfg.owned_file_id IS NULL)) FROM ret0.app_configs cfg WHERE cfg.key = 'features|enable_avaturn_creator'), `;
  return sql.slice(0, start) + guard + marker + committedConfig + sql.slice(start + marker.length);
}

export function readbackRemaining(deadline, maximum, now = performance.now()) {
  const remaining = Math.floor(Math.min(maximum, deadline - now));
  if (!Number.isFinite(remaining) || remaining < 1) fail("readback_deadline");
  return remaining;
}

export function validateReadbackStorageMetadata(meta, file, blobSize) {
  if (!meta || !file || meta.content_type !== file.type || !Number.isSafeInteger(meta.content_length) ||
      String(meta.content_length) !== file.bytes || !Number.isSafeInteger(blobSize) ||
      blobSize < meta.content_length + 12 || blobSize > meta.content_length + 23) fail("owned_storage_metadata_mismatch");
  // Ret.Crypto's local file envelope is 12 bytes plus at most 11 tail-pad bytes.
  // Native HTTP, not this helper, obtains the key and decrypts the actual blob.
  return true;
}

export function avaturnReadbackHttpRequest(bootstrap, file, deadline) {
  validateAvaturnBootstrap(bootstrap);
  if (!file || !uuid(file.uuid) || !["gltf", "bin", "thumbnail"].includes(file.role) ||
      file.type !== { gltf: "model/gltf", bin: "application/octet-stream", thumbnail: "image/png" }[file.role] ||
      typeof file.bytes !== "string" || !/^[1-9][0-9]{0,8}$/.test(file.bytes) ||
      Number(file.bytes) > (file.role === "thumbnail" ? avaturnReadbackLimits.pngBytes : avaturnReadbackLimits.modelBytes)) fail("invalid_owned_http_file");
  return { url: `${bootstrap.storage_origin}/files/${file.uuid}`, options: {
    method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(readbackRemaining(deadline, avaturnReadbackLimits.httpMs))
  } };
}

export function validateReadbackHttpHeaders(response, file) {
  if (!response || response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== file.type ||
      response.headers.get("content-length") !== file.bytes ||
      ![null, "identity"].includes(response.headers.get("content-encoding")) || !response.body) fail("owned_http_response_mismatch");
  return true;
}

export function readbackHttpLength(length, chunkBytes, expected, complete = false) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 0 ||
      !Number.isSafeInteger(expected) || expected < 1 || length + chunkBytes > expected ||
      (complete && length + chunkBytes !== expected)) fail("owned_http_size_mismatch");
  return length + chunkBytes;
}

export function validateAvaturnMedia(media) {
  if (!Buffer.isBuffer(media?.gltf) || !Buffer.isBuffer(media.bin) || !Buffer.isBuffer(media.thumbnail)) fail("owned_media_required");
  let gltf;
  try { gltf = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(media.gltf)); }
  catch { fail("invalid_plaintext_gltf"); }
  validateGltf(gltf, media.bin.length);
  validateAvaturnGeometry(gltf);
  // No resource URI, remote URL or local-file URL is accepted, even in extras.
  const inspect = value => {
    if (Array.isArray(value)) { for (const item of value) inspect(item); }
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key.toLowerCase() === "uri" || key.toLowerCase() === "url") fail("external_gltf_reference");
        inspect(item);
      }
    } else if (typeof value === "string" && /(?:[a-z][a-z0-9+.-]*:\/\/|^(?:data|blob|file):|^\/\/)/i.test(value)) fail("external_gltf_reference");
  };
  inspect(gltf);
  const png = validatePng(media.thumbnail);
  if (png.width !== 720 || png.height !== 1280) fail("avatar_thumbnail_dimensions_mismatch");
  return png;
}

// Directed glTF 2.0 reference/range checks, not a full Khronos validator or
// visual/material acceptance. The real AvatarPreview remains a separate gate.
export function validateAvaturnGeometry(gltf) {
  const bad = () => fail("invalid_gltf_geometry");
  const index = (value, rows) => Number.isSafeInteger(value) && value >= 0 && Array.isArray(rows) && value < rows.length;
  const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const shapes = { SCALAR: [1, 1], VEC2: [1, 2], VEC3: [1, 3], VEC4: [1, 4], MAT2: [2, 2], MAT3: [3, 3], MAT4: [4, 4] };
  if (!Array.isArray(gltf.accessors) || !gltf.accessors.length) bad();
  const span = (viewIndex, offset, count, bytes, alignment, allowStride = true) => {
    if (!index(viewIndex, gltf.bufferViews) || !Number.isSafeInteger(offset) || offset < 0 || offset % alignment) bad();
    const view = gltf.bufferViews[viewIndex], stride = allowStride ? (view.byteStride ?? bytes) : bytes;
    if (!Number.isSafeInteger(stride) || stride < bytes || stride % alignment ||
        (view.byteStride !== undefined && (!allowStride || stride < 4 || stride > 252 || stride % 4)) ||
        !Number.isSafeInteger(count) || count < 1 || offset + (count - 1) * stride + bytes > view.byteLength) bad();
  };
  for (const accessor of gltf.accessors) {
    const size = sizes[accessor?.componentType], shape = shapes[accessor?.type];
    if (!size || !shape || !Number.isSafeInteger(accessor.count) || accessor.count < 1) bad();
    const element = shape[0] === 1 ? shape[1] * size : shape[0] * Math.ceil(shape[1] * size / 4) * 4;
    if (accessor.bufferView !== undefined) span(accessor.bufferView, accessor.byteOffset ?? 0, accessor.count, element, size);
    else if (!accessor.sparse || (accessor.byteOffset ?? 0) !== 0) bad();
    if (accessor.sparse) {
      const sparse = accessor.sparse, component = sizes[sparse.indices?.componentType];
      if (!Number.isSafeInteger(sparse.count) || sparse.count < 1 || sparse.count > accessor.count ||
          ![5121, 5123, 5125].includes(sparse.indices?.componentType)) bad();
      span(sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, sparse.count, component, component, false);
      span(sparse.values?.bufferView, sparse.values?.byteOffset ?? 0, sparse.count, element, size, false);
    }
  }
  for (const scene of gltf.scenes) {
    if (!Array.isArray(scene?.nodes) || !scene.nodes.every(node => index(node, gltf.nodes))) bad();
  }
  if (!index(gltf.scene ?? 0, gltf.scenes)) bad();
  for (const node of gltf.nodes) {
    if (!node || (node.children !== undefined && (!Array.isArray(node.children) || !node.children.every(child => index(child, gltf.nodes)))) ||
        (node.mesh !== undefined && !index(node.mesh, gltf.meshes)) || (node.skin !== undefined && !index(node.skin, gltf.skins))) bad();
  }
  for (const skin of gltf.skins) {
    if (!Array.isArray(skin?.joints) || !skin.joints.length || !skin.joints.every(joint => index(joint, gltf.nodes)) ||
        new Set(skin.joints).size !== skin.joints.length || (skin.skeleton !== undefined && !index(skin.skeleton, gltf.nodes))) bad();
    if (skin.inverseBindMatrices !== undefined) {
      if (!index(skin.inverseBindMatrices, gltf.accessors)) bad();
      const accessor = gltf.accessors[skin.inverseBindMatrices];
      if (accessor.type !== "MAT4" || accessor.componentType !== 5126 || accessor.count < skin.joints.length) bad();
    }
  }
  for (const mesh of gltf.meshes) {
    if (!Array.isArray(mesh?.primitives) || !mesh.primitives.length) bad();
    for (const primitive of mesh.primitives) {
      if (!primitive?.attributes || !index(primitive.attributes.POSITION, gltf.accessors) ||
          !Object.values(primitive.attributes).every(value => index(value, gltf.accessors))) bad();
      const position = gltf.accessors[primitive.attributes.POSITION];
      if (position.type !== "VEC3" || position.componentType !== 5126 ||
          !Object.values(primitive.attributes).every(value => gltf.accessors[value].count === position.count) ||
          (primitive.mode !== undefined && (!Number.isSafeInteger(primitive.mode) || primitive.mode < 0 || primitive.mode > 6)) ||
          (primitive.material !== undefined && !index(primitive.material, gltf.materials))) bad();
      if (primitive.indices !== undefined) {
        if (!index(primitive.indices, gltf.accessors)) bad();
        const accessor = gltf.accessors[primitive.indices];
        if (accessor.type !== "SCALAR" || ![5121, 5123, 5125].includes(accessor.componentType)) bad();
      }
      for (const target of primitive.targets ?? [])
        if (!target || !Object.values(target).every(value => index(value, gltf.accessors) && gltf.accessors[value].count === position.count)) bad();
    }
  }
  for (const node of gltf.nodes.filter(node => node.skin !== undefined)) {
    if (!index(node.mesh, gltf.meshes)) bad();
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      const joints = gltf.accessors[primitive.attributes.JOINTS_0], weights = gltf.accessors[primitive.attributes.WEIGHTS_0];
      if (!joints || joints.type !== "VEC4" || ![5121, 5123].includes(joints.componentType) ||
          !weights || weights.type !== "VEC4" || ![5121, 5123, 5126].includes(weights.componentType) ||
          ([5121, 5123].includes(weights.componentType) && weights.normalized !== true)) bad();
    }
  }
  return true;
}

function ownedPath(file, type, mode) {
  const stat = fs.lstatSync(file);
  if (stat.uid !== process.getuid() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file) ||
      (type === "directory" ? !stat.isDirectory() : type === "socket" ? !stat.isSocket() : !stat.isFile()) ||
      (mode !== undefined && (stat.mode & 0o777) !== mode) || (type !== "socket" && (stat.mode & 0o022))) fail("unsafe_owned_path");
  return stat;
}

function readOwned(file, maximum, mode) {
  const before = ownedPath(file, "file", mode), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.dev !== before.dev || stat.ino !== before.ino ||
        (mode !== undefined && (stat.mode & 0o777) !== mode) || (stat.mode & 0o022) || stat.size < 1 || stat.size > maximum) fail("unsafe_owned_metadata");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size) fail("unsafe_owned_metadata");
    unchangedReadbackPath(stat, fs.fstatSync(fd), true);
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function unchangedReadbackPath(before, after, content = false) {
  if (!before || !after || before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid || before.mode !== after.mode ||
      (content && (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs))) fail("native_context_changed");
  return true;
}

function nativeContext({ work, sid, pgBin }, deadline) {
  if (process.platform !== "darwin") fail("native_macos_required");
  const data = path.join(work, "database"), socket = path.join(work, "socket"), home = path.join(work, "home");
  const bootstrapFile = path.join(work, "avaturn-save-socket-bootstrap.json"), pidFile = path.join(data, "postmaster.pid");
  const directories = [work, data, socket, home].map(file => ({ file, stat: ownedPath(file, "directory", 0o700) }));
  const bootstrapStat = ownedPath(bootstrapFile, "file", 0o600), bootstrapBytes = readOwned(bootstrapFile, 65536, 0o600);
  const bootstrap = validateAvaturnBootstrap(JSON.parse(bootstrapBytes));
  const pidStat = ownedPath(pidFile, "file", 0o600), pidBytes = readOwned(pidFile, 4096, 0o600);
  const postmaster = boundaryPostmaster(pidBytes.toString("utf8"), work);
  const socketFile = path.join(socket, `.s.PGSQL.${postmaster.port}`), socketStat = ownedPath(socketFile, "socket");
  const psql = path.join(pgBin, "psql");
  if (fs.realpathSync(pgBin) !== pgBin || !fs.statSync(pgBin).isDirectory() ||
      fs.realpathSync(psql) !== psql || !fs.statSync(psql).isFile()) fail("exact_psql_required");
  fs.accessSync(psql, fs.constants.X_OK);
  const context = { work, data, socket, home, pgBin, psql, ...postmaster, sid, accountId: bootstrap.account_id };
  validateBoundaryContext(context);
  const recheck = () => {
    readbackRemaining(deadline, avaturnReadbackLimits.totalMs);
    for (const { file, stat } of directories) unchangedReadbackPath(stat, ownedPath(file, "directory", 0o700));
    unchangedReadbackPath(bootstrapStat, ownedPath(bootstrapFile, "file", 0o600), true);
    unchangedReadbackPath(pidStat, ownedPath(pidFile, "file", 0o600), true);
    if (digest(readOwned(bootstrapFile, 65536, 0o600)) !== digest(bootstrapBytes) ||
        digest(readOwned(pidFile, 4096, 0o600)) !== digest(pidBytes)) fail("native_context_changed");
    unchangedReadbackPath(socketStat, ownedPath(socketFile, "socket"));
    process.kill(bootstrap.backend_pid, 0); process.kill(postmaster.pid, 0);
    for (const [name, repository] of [["root", root], ["hubs", path.join(root, "hubs")], ["cloud", path.join(root, "hubs-cloud")]]) {
      const options = { encoding: "utf8", timeout: readbackRemaining(deadline, 2000), maxBuffer: 65536,
        env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } };
      const head = spawnSync("/usr/bin/git", ["--no-optional-locks", "-C", repository, "rev-parse", "HEAD"], options);
      if (head.error || head.signal || head.status !== 0 || head.stdout.trim() !== bootstrap.source[name]) fail("bootstrap_source_mismatch");
      const status = spawnSync("/usr/bin/git", ["--no-optional-locks", "-C", repository, "status", "--porcelain", "--untracked-files=all"], {
        ...options, timeout: readbackRemaining(deadline, 2000)
      });
      if (status.error || status.signal || status.status !== 0 || status.stdout.trim()) fail("bootstrap_source_not_clean");
    }
    readbackRemaining(deadline, avaturnReadbackLimits.totalMs);
  };
  recheck();
  return { context, bootstrap, recheck };
}

function query(context, deadline) {
  const options = boundaryPsqlOptions(context);
  const result = spawnSync(context.psql, options.args, { input: avaturnReadbackSql(context), encoding: "utf8",
    timeout: readbackRemaining(deadline, avaturnReadbackLimits.sqlMs), maxBuffer: 65536, env: options.env });
  if (result.error || result.signal || result.status !== 0 || !result.stdout?.trim()) fail("read_only_peer_query_failed");
  return validateAvaturnReadback(JSON.parse(result.stdout), context);
}

async function main() {
  let failureCode = "arguments";
  try {
    const args = avaturnReadbackArguments(process.argv.slice(2)), deadline = performance.now() + avaturnReadbackLimits.totalMs;
    failureCode = "native_context";
    const { context, bootstrap, recheck } = nativeContext(args, deadline);
    failureCode = "read_only_sql";
    const files = query(context, deadline), media = {}, storage = [];
    failureCode = "owned_http_media";
    for (const [role, file] of Object.entries(files)) {
      const directory = path.join(args.work, "reticulum/storage/test/owned", file.uuid.slice(0, 2), file.uuid.slice(2, 4));
      for (const parent of ["reticulum", "reticulum/storage", "reticulum/storage/test", "reticulum/storage/test/owned", `reticulum/storage/test/owned/${file.uuid.slice(0, 2)}`])
        ownedPath(path.join(args.work, parent), "directory");
      const directoryStat = ownedPath(directory, "directory"), metaFile = path.join(directory, `${file.uuid}.meta.json`), blobFile = path.join(directory, `${file.uuid}.blob`);
      const metaStat = ownedPath(metaFile, "file"), metaBytes = readOwned(metaFile, 16384), blobStat = ownedPath(blobFile, "file");
      validateReadbackStorageMetadata(JSON.parse(metaBytes), file, blobStat.size);
      const request = avaturnReadbackHttpRequest(bootstrap, file, deadline), response = await fetch(request.url, request.options);
      validateReadbackHttpHeaders(response, file);
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        readbackRemaining(deadline, avaturnReadbackLimits.totalMs);
        length = readbackHttpLength(length, chunk.length, Number(file.bytes)); chunks.push(chunk);
      }
      readbackHttpLength(length, 0, Number(file.bytes), true);
      media[role] = Buffer.concat(chunks);
      storage.push({ directory, directoryStat, metaFile, metaStat, metaBytes, blobFile, blobStat });
    }
    failureCode = "media_integrity";
    const png = validateAvaturnMedia(media);
    failureCode = "unchanged_native_context";
    for (const item of storage) {
      unchangedReadbackPath(item.directoryStat, ownedPath(item.directory, "directory"));
      unchangedReadbackPath(item.metaStat, ownedPath(item.metaFile, "file"), true);
      unchangedReadbackPath(item.blobStat, ownedPath(item.blobFile, "file"), true);
      if (digest(readOwned(item.metaFile, 16384)) !== digest(item.metaBytes)) fail("owned_storage_changed");
    }
    if (!isDeepStrictEqual(query(context, deadline), files)) fail("private_avatar_changed");
    recheck();
    process.stdout.write(JSON.stringify({ pass: true, sql_read_only: true, creator_off: true, private_avatar: true, owned_files: 3,
      postmaster_epoch_checked: true, source_clean_unchanged: true, storage_unchanged: true, plaintext_gltf_bin: true,
      bin_bytes: media.bin.length, png_crc_pixels: true, thumbnail_width: png.width, thumbnail_height: png.height }) + "\n");
  } catch {
    // The failure enum is closed; never print exceptions, IDs, paths or secrets.
    process.stdout.write(JSON.stringify({ pass: false, failure_code: failureCode }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const CREATE_INTERVAL_MS = 1100;

function usage() {
  console.error(
    "Usage: YENHUBS_AUTH_TOKEN=... (or YENHUBS_ADMIN_EMAIL=... YENHUBS_DASHBOARD_ACCESS_KEY=...) " +
      "node deployment/import-local-avatars.mjs --base-url https://meta-hubs.org " +
      "--thumbnail-dir /path/to/pngs [--featured] [--base NAME.glb] [--default NAME.glb] FILE.glb..."
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { files: [], featured: false, base: null, default: null, thumbnailDir: null };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--base-url") options.baseUrl = argv[++i];
    else if (value === "--thumbnail-dir") options.thumbnailDir = argv[++i];
    else if (value === "--featured") options.featured = true;
    else if (value === "--base") options.base = argv[++i];
    else if (value === "--default") options.default = argv[++i];
    else if (value.startsWith("--")) usage();
    else options.files.push(value);
  }
  if (!options.baseUrl || !options.thumbnailDir || !options.files.length) usage();
  options.baseUrl = options.baseUrl.replace(/\/$/, "");
  return options;
}

function ensureAvatarMaterial(gltf) {
  gltf.materials ||= [];
  if (gltf.materials.some(material => material.name === "Bot_PBS")) return gltf;

  const pending = [...(gltf.scenes?.[gltf.scene || 0]?.nodes || [])];
  while (pending.length) {
    const node = gltf.nodes?.[pending.shift()];
    if (!node) continue;
    const mesh = node.mesh !== undefined ? gltf.meshes?.[node.mesh] : null;
    const primitive = mesh?.primitives?.find(candidate => candidate.material !== undefined);
    if (primitive && gltf.materials[primitive.material]) {
      gltf.materials[primitive.material].name = "Bot_PBS";
      break;
    }
    if (node.children) pending.push(...node.children);
  }
  return gltf;
}

function avatarTags(gltf) {
  const nodeNames = (gltf.nodes || []).map(node => node.name || "");
  const has = pattern => nodeNames.some(name => pattern.test(name));
  const fullbody = has(/Left(?:Up|Upper)Leg/i) && has(/Right(?:Up|Upper)Leg/i) && has(/Hips/i);
  const rpm = has(/Wolf3D_/i);
  return [...(fullbody ? ["fullbody"] : []), ...(rpm ? ["rpm"] : [])];
}

function splitGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== 2) {
    throw new Error("Only GLB v2 files are supported");
  }
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error("Invalid GLB length");

  let offset = 12;
  let json;
  let binary;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) json = JSON.parse(chunk.toString("utf8").replace(/\u0000+$/g, "").trimEnd());
    if (type === BIN_CHUNK) binary = chunk;
    offset += 8 + length;
  }
  if (!json || !binary) throw new Error("GLB is missing JSON or BIN data");
  const tags = avatarTags(json);
  return { gltf: Buffer.from(JSON.stringify(ensureAvatarMaterial(json))), binary, tags };
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} failed (${response.status}): ${text}`);
  if (!text) return null;
  try {
    // PostgREST exposes 64-bit IDs as JSON numbers. Preserve them as strings so
    // JavaScript does not round foreign keys above Number.MAX_SAFE_INTEGER.
    return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
  } catch {
    return text;
  }
}

async function findReusableAvatar(baseUrl, token, name) {
  const rows = await request(
    `${baseUrl}/api/postgrest/avatars?name=eq.${encodeURIComponent(name)}&order=id.desc&limit=1`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const avatar = rows?.[0];
  return avatar && !avatar.avatar_listing_id && !avatar.reviewed_at && avatar.allow_promotion ? avatar : null;
}

async function resolveAvatarRecord(baseUrl, token, avatarSid) {
  const rows = await request(
    `${baseUrl}/api/postgrest/avatars?avatar_sid=eq.${encodeURIComponent(avatarSid)}&limit=1`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!rows?.length) throw new Error(`Unable to resolve imported avatar ${avatarSid}`);
  return rows[0];
}

async function getAdminToken(baseUrl, email, dashboardAccessKey) {
  return request(`${baseUrl}/api-internal/v1/make_auth_token_for_email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ret-dashboard-access-key": dashboardAccessKey
    },
    body: JSON.stringify({ email })
  });
}

async function uploadOwnedFile(baseUrl, token, bytes, filename, contentType) {
  const form = new FormData();
  form.append("media", new File([bytes], filename, { type: contentType }));
  form.append("promotion_mode", "with_token");
  form.append("desired_content_type", contentType);
  return request(`${baseUrl}/api/v1/media`, {
    method: "POST",
    headers: { authorization: `bearer ${token}` },
    body: form
  });
}

function listingPayload(avatar, tags) {
  const now = new Date().toISOString();
  return {
    avatar_listing_sid: randomBytes(6).toString("base64url").slice(0, 7),
    avatar_id: avatar.id,
    slug: avatar.slug,
    name: avatar.name,
    description: avatar.description,
    attributions: avatar.attributions,
    tags: { tags },
    account_id: avatar.account_id,
    parent_avatar_listing_id: avatar.parent_avatar_listing_id,
    gltf_owned_file_id: avatar.gltf_owned_file_id,
    bin_owned_file_id: avatar.bin_owned_file_id,
    thumbnail_owned_file_id: avatar.thumbnail_owned_file_id,
    base_map_owned_file_id: avatar.base_map_owned_file_id,
    emissive_map_owned_file_id: avatar.emissive_map_owned_file_id,
    normal_map_owned_file_id: avatar.normal_map_owned_file_id,
    orm_map_owned_file_id: avatar.orm_map_owned_file_id,
    order: 10000,
    state: "active",
    inserted_at: now,
    updated_at: now
  };
}

async function createListing(baseUrl, token, avatar, tags) {
  return request(`${baseUrl}/api/postgrest/avatar_listings`, {
    method: "POST",
    headers: {
      accept: "application/vnd.pgrst.object+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer: "return=representation"
    },
    body: JSON.stringify(listingPayload(avatar, tags))
  });
}

async function markReviewed(baseUrl, token, avatar) {
  return request(`${baseUrl}/api/postgrest/avatars?id=eq.${avatar.id}`, {
    method: "PATCH",
    headers: {
      accept: "application/vnd.pgrst.object+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer: "return=representation"
    },
    body: JSON.stringify({ reviewed_at: new Date().toISOString(), allow_promotion: true })
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const email = process.env.YENHUBS_ADMIN_EMAIL;
  const dashboardAccessKey = process.env.YENHUBS_DASHBOARD_ACCESS_KEY;
  const suppliedToken = process.env.YENHUBS_AUTH_TOKEN;
  if (!suppliedToken && (!email || !dashboardAccessKey)) usage();

  const token = suppliedToken || (await getAdminToken(options.baseUrl, email, dashboardAccessKey));
  const tempDir = path.resolve("output/avatar-import-work");
  await mkdir(tempDir, { recursive: true });

  const results = [];
  let lastCreateAt = 0;
  for (const fileArg of options.files) {
    const glbPath = path.resolve(fileArg);
    const fileName = path.basename(glbPath);
    const stem = path.basename(fileName, path.extname(fileName));
    const thumbnailPath = path.join(path.resolve(options.thumbnailDir), `${stem}.png`);
    const { gltf, binary, tags: detectedTags } = splitGlb(await readFile(glbPath));
    let avatar = await findReusableAvatar(options.baseUrl, token, stem);

    if (avatar) {
      console.log(`Reusing pending avatar ${stem} (${avatar.avatar_sid})`);
    } else {
      const thumbnail = await readFile(thumbnailPath);
      const [gltfUpload, binUpload, thumbnailUpload] = await Promise.all([
        uploadOwnedFile(options.baseUrl, token, gltf, `${stem}.gltf`, "model/gltf"),
        uploadOwnedFile(options.baseUrl, token, binary, `${stem}.bin`, "application/octet-stream"),
        uploadOwnedFile(options.baseUrl, token, thumbnail, `${stem}.png`, "image/png")
      ]);

      const waitMs = Math.max(0, lastCreateAt + CREATE_INTERVAL_MS - Date.now());
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      lastCreateAt = Date.now();

      const avatarResponse = await request(`${options.baseUrl}/api/v1/avatars`, {
        method: "POST",
        headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          avatar: {
            name: stem,
            parent_avatar_listing_id: "",
            allow_promotion: true,
            files: {
              gltf: [gltfUpload.file_id, gltfUpload.meta.access_token, gltfUpload.meta.promotion_token],
              bin: [binUpload.file_id, binUpload.meta.access_token, binUpload.meta.promotion_token],
              thumbnail: [
                thumbnailUpload.file_id,
                thumbnailUpload.meta.access_token,
                thumbnailUpload.meta.promotion_token
              ]
            }
          }
        })
      });
      avatar = await resolveAvatarRecord(options.baseUrl, token, avatarResponse.avatars[0].avatar_id);
    }
    const tags = [...detectedTags];
    if (options.featured && options.base !== fileName) tags.push("featured");
    if (options.base === fileName) tags.push("base");
    if (options.default === fileName) tags.push("default");

    await createListing(options.baseUrl, token, avatar, [...new Set(tags)]);
    await markReviewed(options.baseUrl, token, avatar);
    results.push({ name: stem, avatar_sid: avatar.avatar_sid, tags: [...new Set(tags)] });
    console.log(`Imported ${stem} (${avatar.avatar_sid})`);
  }

  const manifestPath = path.join(tempDir, `avatar-import-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(manifestPath, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  console.log(`Import manifest: ${manifestPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

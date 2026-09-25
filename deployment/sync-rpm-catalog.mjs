#!/usr/bin/env node
// Explicit catalogue allowlist; journal every irreversible create before sending it.
// Credentials stay in memory. Originals and existing model file IDs are preserved.
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir, open, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLocalValuesFile } from "./parse-local-values.mjs";
import { splitGlb } from "./import-local-avatars.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const apply = args.includes("--apply");
const verify = args.includes("--verify");
const base = "https://meta-hubs.org";
const journalDir = option("--journal-dir");
const valuesPath = option("--values");
const checkpoint = option("--checkpoint");
const adminOrigin = option("--admin-origin");
if (adminOrigin && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(adminOrigin)) {
  throw new Error("Administrative origin must be an explicitly forwarded loopback port");
}
if (!journalDir || !valuesPath || (apply && !checkpoint) || (apply && verify)) {
  throw new Error("Use --values PRIVATE_VALUES --journal-dir PRIVATE_DIR [--apply --checkpoint DIR | --verify] [--only STEM,...]");
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const parse = text => JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
const readJSON = async file => JSON.parse(await readFile(file, "utf8"));
const manifestBytes = await readFile(path.join(root, "features/avatar-creator/rpm-catalog.json"));
const { entries } = JSON.parse(manifestBytes);
const receipts = await readJSON(path.join(root, "output/rpm-catalog-20260925/thumbnails/render-receipts.json"));
if (entries.length !== 33 || new Set(entries.map(e => e.name)).size !== 33) throw new Error("Invalid catalogue allowlist");
const assets = new Map();
for (const e of entries) {
  const r = receipts.find(r => path.basename(r.file, ".glb") === e.stem);
  if (!r) throw new Error(`Missing source: ${e.stem}`);
  const bytes = await readFile(r.file);
  if (sha(bytes) !== r.sha256) throw new Error(`Changed original: ${e.stem}`);
  const thumbnail = await readFile(r.thumbnail);
  if (!thumbnail.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Not a PNG");
  assets.set(e.stem, { ...splitGlb(bytes), thumbnail, sourceHash: r.sha256, thumbnailHash: sha(thumbnail) });
}
if (new Set([...assets.values()].map(a => a.sourceHash)).size !== 33) throw new Error("Duplicate GLB");
await mkdir(journalDir, { recursive: true, mode: 0o700 });
if (((await stat(journalDir)).mode & 0o077) !== 0) throw new Error("Journal must be owner-only");
const lockPath = path.join(journalDir, "sync.lock");
const lock = await open(lockPath, "wx", 0o600);
const journalPath = path.join(journalDir, "journal.json");
let journal;
try { journal = await readJSON(journalPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
journal ||= { version: 1, base, manifestHash: sha(manifestBytes), entries: {}, createdAt: new Date().toISOString() };
if (journal.base !== base || journal.manifestHash !== sha(manifestBytes)) throw new Error("Journal belongs to another catalogue");
async function save() {
  const tmp = journalPath + ".next";
  await writeFile(tmp, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, journalPath);
}
let token;
async function request(route, method = "GET", body, extraHeaders = {}) {
  const internal = route.startsWith("/api-internal/");
  if (internal && !adminOrigin) throw new Error("Use authenticated kubectl port-forward and --admin-origin; internal API is not public");
  const response = await fetch((internal ? adminOrigin : base) + route, {
    method, redirect: "error", signal: AbortSignal.timeout(90000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(internal ? { "x-forwarded-proto": "https", host: "meta-hubs.org" } : {}),
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...extraHeaders },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`${method} ${route.split("?")[0]} HTTP ${response.status}; reconcile journal before retry`);
  const text = await response.text();
  if (!text) return null;
  if (route === "/api-internal/v1/make_auth_token_for_email" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text.trim())) return text.trim();
  try { return parse(text); }
  catch { throw new Error(`Unexpected response format: ${route.split("?")[0]}`); }
}
const rows = (table, query) => request(`/api/postgrest/${table}?${query}`);
const patch = (table, id, body) => request(`/api/postgrest/${table}?id=eq.${id}`, "PATCH", body, { prefer: "return=representation" });
async function exact(table, query) {
  const found = await rows(table, query);
  if (found.length !== 1) throw new Error(`Expected one ${table}: got ${found.length}`);
  return found[0];
}
async function binaryHash(sid) {
  const gltf = await request(`/api/v1/avatars/${sid}/avatar.gltf`);
  if (gltf.buffers?.length !== 1 || !gltf.buffers[0].uri) throw new Error("Unexpected avatar buffers");
  const response = await fetch(new URL(gltf.buffers[0].uri, base), { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`Avatar binary HTTP ${response.status}`);
  return sha(Buffer.from(await response.arrayBuffer()));
}
async function checkModel(sid, a) {
  if (await binaryHash(sid) !== sha(a.binary)) throw new Error(`Model identity mismatch: ${sid}`);
}
async function upload(bytes, filename, type) {
  const form = new FormData();
  form.append("media", new File([bytes], filename, { type }));
  form.append("promotion_mode", "with_token");
  form.append("desired_content_type", type);
  const result = await request("/api/v1/media", "POST", form);
  return [result.file_id, result.meta.access_token, result.meta.promotion_token];
}
function desiredTags(e, before) {
  return { tags: [...new Set([...(before?.tags?.tags || []), "fullbody", "rpm", "featured", e.category.toLowerCase()])] };
}
async function validateCheckpoint() {
  try { await stat(path.join(checkpoint, ".yenhubs-incomplete")); throw new Error("Checkpoint is incomplete"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const sums = (await readFile(path.join(checkpoint, "SHA256SUMS"), "utf8")).trim().split("\n");
  if (sums.length < 3) throw new Error("Missing checkpoint artifacts");
  for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/);
    if (!match || sha(await readFile(path.join(checkpoint, match[2]))) !== match[1]) throw new Error("Checkpoint digest mismatch");
  }
  if (!sums.some(x => x.includes("retdb-")) || !sums.some(x => x.includes("ret-storage-"))) throw new Error("Need joint DB/media checkpoint");
}
async function main() {
  const values = parseLocalValuesFile(valuesPath);
  token = await request("/api-internal/v1/make_auth_token_for_email", "POST", { email: "info@virtualmente.com" },
    { "x-ret-dashboard-access-key": values.get("DASHBOARD_ACCESS_KEY") });
  if (typeof token !== "string") throw new Error("Unexpected authentication result");
  const allListings = await rows("avatar_listings", "select=*&limit=1000");
  if (allListings.length >= 1000) throw new Error("Catalogue requires pagination");
  journal.untouchedListings ||= allListings.filter(l => !entries.some(e => e.existing_listing === l.avatar_listing_sid));
  // Build the entire plan before a single upload. Initial snapshots support metadata rollback.
  for (const e of entries) {
    const a = assets.get(e.stem);
    let item = journal.entries[e.stem];
    if (!item) {
      item = { name: e.name, sourceHash: a.sourceHash, thumbnailHash: a.thumbnailHash, stage: "planned" };
      if (e.existing_listing) {
        const listing = allListings.find(l => l.avatar_listing_sid === e.existing_listing);
        if (!listing) throw new Error(`Missing existing listing ${e.stem}`);
        const avatar = await exact("avatars", `id=eq.${listing.avatar_id}`);
        await checkModel(e.existing_listing, a);
        item.before = { listing, avatar };
        item.listingSid = e.existing_listing;
        item.avatarSid = avatar.avatar_sid;
      } else {
        const collisions = await rows("avatars", `name=eq.${encodeURIComponent(e.name)}`);
        if (collisions.length || allListings.some(l => l.name === e.name)) throw new Error(`Name already exists: ${e.name}`);
        item.listingSid = createHash("sha256").update(`yenhubs-rpm-catalog-v1:${a.sourceHash}`).digest("base64url").slice(0, 7);
        if (allListings.some(l => l.avatar_listing_sid === item.listingSid)) throw new Error("Listing SID collision");
      }
      journal.entries[e.stem] = item;
      await save();
    }
    if (item.sourceHash !== a.sourceHash || item.thumbnailHash !== a.thumbnailHash) throw new Error(`Assets changed: ${e.stem}`);
  }
  console.log("PLAN: 33 unique models; 7 existing IDs preserved; 26 new listings. Originals unchanged.");
  if (verify) {
    const featured = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const response = await request("/api/v1/media/search?source=avatar_listings&filter=featured" +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
      featured.push(...response.entries);
      cursor = response.meta.next_cursor;
      if (!cursor) break;
    }
    if (cursor) throw new Error("Featured catalogue pagination exceeds verification bound");
    let checked = 0;
    for (const e of entries) {
      const item = journal.entries[e.stem];
      if (item.stage !== "done") throw new Error(`Not published: ${e.stem}`);
      const listing = await exact("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`);
      if (listing.name !== e.name || listing.state !== "active" || !listing.tags.tags.includes("featured")) throw new Error("Listing readback mismatch");
      if (allListings.filter(l => l.name === e.name).length !== 1) throw new Error("Duplicate or missing name");
      const visible = featured.filter(l => l.id === item.listingSid);
      if (visible.length !== 1 || visible[0].name !== e.name || /Ready Player Me/i.test(visible[0].description || "")) throw new Error("Public catalogue mismatch");
      const image = await fetch(visible[0].images.preview.url, { signal: AbortSignal.timeout(90000) });
      if (!image.ok || sha(Buffer.from(await image.arrayBuffer())) !== assets.get(e.stem).thumbnailHash) throw new Error("Published thumbnail does not match approved render");
      await checkModel(item.listingSid, assets.get(e.stem));
      checked++;
    }
    for (const before of journal.untouchedListings) {
      if (JSON.stringify(allListings.find(l => l.avatar_listing_sid === before.avatar_listing_sid)) !== JSON.stringify(before)) throw new Error("Unrelated listing changed");
    }
    journal.verifiedAt = new Date().toISOString(); await save();
    console.log(`VERIFIED: ${checked} published originals and exact thumbnails; ${featured.length} featured entries; unrelated listings unchanged.`);
    return;
  }
  if (!apply) return;
  await validateCheckpoint();
  journal.checkpoint = checkpoint; await save();
  const only = option("--only")?.split(",");
  if (only?.some(stem => !entries.some(e => e.stem === stem))) throw new Error("Unknown --only entry");
  for (const [index, e] of entries.entries()) {
    if (only && !only.includes(e.stem)) continue;
    const item = journal.entries[e.stem];
    const a = assets.get(e.stem);
    if (item.stage === "done") { console.log(`SKIP ${e.stem}: already verified`); continue; }
    if (item.before && item.stage === "planned") {
      const currentListing = await exact("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`);
      const currentAvatar = await exact("avatars", `avatar_sid=eq.${item.avatarSid}`);
      for (const key of ["name", "description", "thumbnail_owned_file_id", "gltf_owned_file_id", "bin_owned_file_id", "updated_at"]) {
        if (currentListing[key] !== item.before.listing[key] || currentAvatar[key] !== item.before.avatar[key]) throw new Error(`Existing avatar changed since plan: ${e.stem}`);
      }
    }
    let avatar;
    if (!item.avatarSid && item.stage === "create-requested") {
      const found = await rows("avatars", `name=eq.${encodeURIComponent(e.name)}`);
      if (found.length !== 1) throw new Error(`Uncertain prior create for ${e.stem}; manual reconciliation required`);
      await checkModel(found[0].avatar_sid, a);
      item.avatarSid = found[0].avatar_sid; item.stage = "avatar-saved"; await save();
    }
    if (!item.avatarSid) {
      const files = {
        gltf: await upload(a.gltf, `${e.stem}.gltf`, "model/gltf"),
        bin: await upload(a.binary, `${e.stem}.bin`, "application/octet-stream"),
        thumbnail: await upload(a.thumbnail, `${e.stem}.png`, "image/png")
      };
      item.stage = "create-requested"; await save();
      const response = await request("/api/v1/avatars", "POST", { avatar: {
        name: e.name, parent_avatar_listing_id: "", allow_promotion: true,
        description: `Avatar · ${e.category}`, files
      } });
      item.avatarSid = response.avatars[0].avatar_id;
      item.stage = "avatar-saved"; await save();
      await new Promise(resolve => setTimeout(resolve, 1100));
    } else if (item.before && item.stage === "planned") {
      // Only name/description/thumbnail change. Never upload a replacement body.
      const thumbnail = await upload(a.thumbnail, `${e.stem}.png`, "image/png");
      await request(`/api/v1/avatars/${item.avatarSid}`, "PUT", { avatar: {
        name: e.name, description: `Avatar · ${e.category}`, files: { thumbnail }
      } });
      item.stage = "avatar-saved"; await save();
    }
    avatar = await exact("avatars", `avatar_sid=eq.${item.avatarSid}`);
    const common = { name: e.name, description: `Avatar · ${e.category}`, tags: desiredTags(e, item.before?.listing),
      thumbnail_owned_file_id: avatar.thumbnail_owned_file_id, order: 10000 - index,
      updated_at: new Date().toISOString() };
    if (item.before) {
      if (avatar.gltf_owned_file_id !== item.before.avatar.gltf_owned_file_id || avatar.bin_owned_file_id !== item.before.avatar.bin_owned_file_id) throw new Error("Existing model changed unexpectedly");
      await patch("avatar_listings", item.before.listing.id, common);
    } else {
      const existing = await rows("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`);
      if (existing.length === 0) {
        const payload = { ...common, avatar_listing_sid: item.listingSid, avatar_id: avatar.id,
          slug: avatar.slug, account_id: avatar.account_id, attributions: avatar.attributions,
          parent_avatar_listing_id: avatar.parent_avatar_listing_id, state: "active", inserted_at: common.updated_at };
        for (const key of ["gltf", "bin", "base_map", "emissive_map", "normal_map", "orm_map"]) payload[`${key}_owned_file_id`] = avatar[`${key}_owned_file_id`];
        await request("/api/postgrest/avatar_listings", "POST", payload);
      } else if (existing.length !== 1 || existing[0].avatar_id !== avatar.id) throw new Error("Listing ownership collision");
      await patch("avatars", avatar.id, { reviewed_at: common.updated_at, allow_promotion: true });
    }
    const listing = await exact("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`);
    if (listing.name !== e.name || listing.thumbnail_owned_file_id !== avatar.thumbnail_owned_file_id) throw new Error("Write readback mismatch");
    await checkModel(item.listingSid, a);
    item.stage = "done"; item.avatarId = avatar.id; item.listingId = listing.id;
    item.thumbnailOwnedFileId = avatar.thumbnail_owned_file_id; item.completedAt = new Date().toISOString(); await save();
    console.log(`PUBLISHED ${e.name} (${item.listingSid})`);
  }
}
try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await lock.close(); await unlink(lockPath); }

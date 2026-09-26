#!/usr/bin/env node
// Explicit catalogue allowlist; journal every irreversible create before sending it.
// Authentication stays in memory; upload receipts remain in the private journal.
// Originals and existing model file IDs are preserved.
import { createHash } from "node:crypto";
import { readFile, mkdir, open, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseLocalValuesFile } from "./parse-local-values.mjs";
import { splitGlb } from "./import-local-avatars.mjs";
import { durableSave, mutation, assertRow, equal, fieldEqual, catalogAvatarSlug, hasMutationIntent, checkpointBindingForJournal, validateCatalogCheckpoint } from "./rpm-catalog-safety.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function runCatalog(args = process.argv.slice(2), dependencies = {}) {
const fetch = dependencies.fetch || globalThis.fetch;
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const apply = args.includes("--apply");
const verify = args.includes("--verify");
const base = option("--base") || "https://meta-hubs.org";
if (new URL(base).origin !== base || new URL(base).protocol !== "https:") throw new Error("Base must be an HTTPS origin");
const adminEmail = option("--admin-email") || "info@virtualmente.com";
const journalDir = option("--journal-dir");
const valuesPath = option("--values");
const checkpoint = option("--checkpoint");
const adminOrigin = option("--admin-origin");
if (adminOrigin && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(adminOrigin)) {
  throw new Error("Administrative origin must be an explicitly forwarded loopback port");
}
if (!journalDir || !valuesPath || (apply && (!checkpoint || !option("--target-identity"))) || (apply && verify)) {
  throw new Error("Use --values PRIVATE_VALUES --journal-dir PRIVATE_DIR [--apply --checkpoint DIR --target-identity JSON | --verify] [--manifest JSON --receipts JSON --base HTTPS_ORIGIN --admin-email EMAIL --only STEM,...]");
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const parse = text => JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
const readJSON = async file => JSON.parse(await readFile(file, "utf8"));
const manifestBytes = await readFile(option("--manifest") || path.join(root, "features/avatar-creator/rpm-catalog.json"));
const { entries } = JSON.parse(manifestBytes);
const receipts = await readJSON(option("--receipts") || path.join(root, "output/rpm-catalog-20260925/thumbnails/render-receipts.json"));
const preserved = ["84PKFaQ", "y_GoczU", "x0h-wd0", "f8zTm-g", "mKOnfC8", "t_zomhE", "3LVfOJj"];
if (entries.length !== 33 || new Set(entries.map(e => e.name)).size !== 33 || new Set(entries.map(e => e.stem)).size !== 33 ||
    !equal(entries.filter(e => e.existing_listing).map(e => e.existing_listing).sort(), preserved.sort())) throw new Error("Invalid catalogue allowlist");
const assets = new Map();
for (const e of entries) {
  const matches = receipts.filter(r => path.basename(r.file, ".glb") === e.stem);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous source: ${e.stem}`);
  const r = matches[0];
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
await lock.writeFile(JSON.stringify({ pid: process.pid, base })); await lock.sync();
try {
const journalPath = path.join(journalDir, "journal.json");
let journal;
try { journal = await readJSON(journalPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
journal ||= { version: 2, base, adminEmail, manifestHash: sha(manifestBytes), entries: {}, createdAt: new Date().toISOString() };
if (journal.version !== 2 || journal.base !== base || journal.adminEmail !== adminEmail || journal.manifestHash !== sha(manifestBytes)) throw new Error("Journal belongs to another catalogue or requires explicit legacy reconciliation");
let bindFirstMutation;
async function save() {
  if (hasMutationIntent(journal) && !journal.checkpointReceipt) {
    if (!bindFirstMutation) throw new Error("First mutation requires a fresh checkpoint gate");
    // Receipt and first intent share one fsync+rename; a preflight receipt alone
    // must never authorize a first write days later.
    journal.checkpointReceipt = await bindFirstMutation();
  }
  await durableSave(journalPath, journal);
}
let token;
async function request(route, method = "GET", body, extraHeaders = {}) {
  const internal = route.startsWith("/api-internal/");
  if (internal && !adminOrigin) throw new Error("Use authenticated kubectl port-forward and --admin-origin; internal API is not public");
  const response = await fetch((internal ? adminOrigin : base) + route, {
    method, redirect: "error", signal: AbortSignal.timeout(90000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(internal ? { "x-forwarded-proto": "https", host: new URL(base).host } : {}),
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
const patch = (table, before, body) => {
  if (!before.updated_at) throw new Error("Missing concurrency revision");
  // Include the complete snapshot, not only updated_at: some administrative
  // PostgREST writers do not advance Ecto-managed timestamps.
  const filters = Object.entries(before).filter(([, value]) => value !== undefined).map(([key, value]) =>
    `${encodeURIComponent(key)}=${value === null ? "is.null" : "eq." + encodeURIComponent(typeof value === "object" ? JSON.stringify(value) : value)}`).join("&");
  return request(`/api/postgrest/${table}?${filters}`, "PATCH", body, { prefer: "return=representation" });
};
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
async function upload(item, key, bytes, filename, type) {
  item.uploads ||= {};
  const previous = item.uploads[key];
  if (previous) {
    if (previous.hash !== sha(bytes) || !previous.result) throw new Error(`Uncertain upload ${key}; reconcile, never re-upload blindly`);
    return previous.result;
  }
  item.uploads[key] = { hash: sha(bytes), state: "requested" }; await save();
  const form = new FormData();
  form.append("media", new File([bytes], filename, { type }));
  form.append("promotion_mode", "with_token");
  form.append("desired_content_type", type);
  const result = await request("/api/v1/media", "POST", form);
  if (![result?.file_id, result?.meta?.access_token, result?.meta?.promotion_token].every(v => typeof v === "string" && v)) throw new Error("Invalid upload receipt");
  const receipt = [result.file_id, result.meta.access_token, result.meta.promotion_token];
  item.uploads[key].result = receipt; item.uploads[key].state = "confirmed"; await save();
  return receipt;
}
function desiredTags(e, before) {
  return { tags: [...new Set([...(before?.tags?.tags || []), "fullbody", "rpm", "featured", e.category.toLowerCase()])] };
}
async function checkUploaded(avatar, files, a) {
  const view = await request(`/api/v1/avatars/${avatar.avatar_sid}`);
  const publicAvatar = view.avatars?.[0];
  if (publicAvatar?.avatar_id !== avatar.avatar_sid) throw new Error("Avatar identity readback mismatch");
  for (const [key, receipt] of Object.entries(files)) {
    const owned = await exact("owned_files", `select=id,owned_file_uuid&id=eq.${avatar[`${key}_owned_file_id`]}`);
    if (owned.owned_file_uuid !== receipt[0]) throw new Error("Uploaded file identity mismatch");
    const response = await fetch(publicAvatar.files[key], { redirect: "error", signal: AbortSignal.timeout(90000) });
    const expected = key === "bin" ? a.binary : key === "gltf" ? a.gltf : a.thumbnail;
    if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== sha(expected)) throw new Error("Uploaded file hash mismatch");
  }
  await checkModel(avatar.avatar_sid, a);
}
async function main() {
  // Offline gate precedes even authentication, and therefore every remote write.
  if (apply) {
    const options = {
      checkpoint, scriptDir: path.join(root, "deployment"), target: await readJSON(option("--target-identity")), base,
      manifestHash: sha(manifestBytes), maxAgeHours: Number(option("--checkpoint-max-age-hours") || 24)
    };
    const validate = dependencies.validateCheckpoint || validateCatalogCheckpoint;
    await validate({ ...options, previous: checkpointBindingForJournal(journal) });
    if (!hasMutationIntent(journal)) delete journal.checkpointReceipt;
    bindFirstMutation = () => validate(options);
  }
  const values = (dependencies.readValues || parseLocalValuesFile)(valuesPath);
  token = await request("/api-internal/v1/make_auth_token_for_email", "POST", { email: adminEmail },
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
  const only = option("--only")?.split(",");
  if (only?.some(stem => !entries.some(e => e.stem === stem))) throw new Error("Unknown --only entry");
  // Refuse old servers before uploading anything. Unknown request properties
  // are ignored by old Reticulum, so merely sending expected_updated_at is unsafe.
  for (const e of entries.filter(e => e.existing_listing && (!only || only.includes(e.stem)))) {
    const view = await request(`/api/v1/avatars/${journal.entries[e.stem].avatarSid}`);
    if (view.capabilities?.conditional_update !== true || view.capabilities?.conditional_update_fields !== true) throw new Error("Reticulum conditional avatar update capability required");
  }
  journal.checkpoint = checkpoint; await save();
  for (const [index, e] of entries.entries()) {
    if (only && !only.includes(e.stem)) continue;
    const item = journal.entries[e.stem];
    const a = assets.get(e.stem);
    if (item.stage === "done") { console.log(`SKIP ${e.stem}: already verified`); continue; }
    if (item.before && !item.operations?.avatar) {
      const currentListing = await exact("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`);
      const currentAvatar = await exact("avatars", `avatar_sid=eq.${item.avatarSid}`);
      assertRow(currentListing, item.before.listing);
      assertRow(currentAvatar, item.before.avatar);
    }
    const files = item.operations?.avatar?.intent.files || (item.before ? {
      thumbnail: await upload(item, "thumbnail", a.thumbnail, `${e.stem}.png`, "image/png")
    } : {
      gltf: await upload(item, "gltf", a.gltf, `${e.stem}.gltf`, "model/gltf"),
      bin: await upload(item, "bin", a.binary, `${e.stem}.bin`, "application/octet-stream"),
      thumbnail: await upload(item, "thumbnail", a.thumbnail, `${e.stem}.png`, "image/png")
    });
    const intent = { name: e.name, description: `Avatar · ${e.category}`, files,
      ...(item.before ? { expected_updated_at: item.before.avatar.updated_at,
        expected_fields: Object.fromEntries(["name", "description", "thumbnail_owned_file_id", "gltf_owned_file_id", "bin_owned_file_id"].map(k => [k, item.before.avatar[k]]))
      } : { parent_avatar_listing_id: "", allow_promotion: true }) };
    let avatar;
    if (item.savedAvatar) {
      avatar = await exact("avatars", `avatar_sid=eq.${item.avatarSid}`);
      // Promotion below has its own immutable intent and is the only permitted delta.
      const promoted = item.operations?.promote?.intent;
      assertRow(avatar, promoted && Object.entries(promoted.body).every(([k, v]) => fieldEqual(k, avatar[k], v)) ? { ...item.savedAvatar, ...promoted.body } : item.savedAvatar);
      await checkUploaded(avatar, files, a);
    } else {
      avatar = await mutation({ item, key: "avatar", intent, save,
        send: async body => {
          if (!item.before && ((await rows("avatars", `name=eq.${encodeURIComponent(e.name)}`)).length ||
              (await rows("avatar_listings", `name=eq.${encodeURIComponent(e.name)}`)).length)) throw new Error("New avatar name collision; reconcile before proceeding");
          await request(item.before ? `/api/v1/avatars/${item.avatarSid}` : "/api/v1/avatars", item.before ? "PUT" : "POST", { avatar: body });
        },
        inspect: async body => {
          const found = await rows("avatars", item.before ? `avatar_sid=eq.${item.avatarSid}` : `name=eq.${encodeURIComponent(e.name)}`);
          if (found.length !== 1) return null;
          const current = found[0];
          if (current.name !== body.name || current.description !== body.description || !current.updated_at) return null;
          const expectedSlug = catalogAvatarSlug(current.avatar_sid, body.name);
          if (current.slug !== expectedSlug) throw new Error("Generated avatar slug readback mismatch");
          if (item.before) assertRow(current, { ...item.before.avatar, name: body.name, description: body.description, slug: expectedSlug }, ["thumbnail_owned_file_id", "updated_at"]);
          else if (current.allow_promotion !== true || current.state !== "active" || current.parent_avatar_listing_id != null) return null;
          await checkUploaded(current, body.files, a);
          return current;
        }
      });
      item.avatarSid = avatar.avatar_sid; item.savedAvatar = avatar; item.stage = "avatar-saved"; await save();
      if (!item.before) await (dependencies.pause || (ms => new Promise(resolve => setTimeout(resolve, ms))))(1100);
    }
    const common = { name: e.name, description: `Avatar · ${e.category}`, tags: desiredTags(e, item.before?.listing),
      thumbnail_owned_file_id: avatar.thumbnail_owned_file_id, order: 10000 - index,
      updated_at: item.operations?.listing?.intent.body.updated_at || new Date().toISOString() };
    if (item.before) {
      if (avatar.gltf_owned_file_id !== item.before.avatar.gltf_owned_file_id || avatar.bin_owned_file_id !== item.before.avatar.bin_owned_file_id) throw new Error("Existing model changed unexpectedly");
      await mutation({ item, key: "listing", intent: { body: common }, save,
        send: async ({ body }) => {
          assertRow(await exact("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`), item.before.listing);
          await patch("avatar_listings", item.before.listing, body);
        },
        inspect: async ({ body }) => {
          const current = await exact("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`);
          assertRow(current, { ...item.before.listing, ...body }); return current;
        }
      });
    } else {
      const payload = { ...common, avatar_listing_sid: item.listingSid, avatar_id: avatar.id,
          slug: avatar.slug, account_id: avatar.account_id, attributions: avatar.attributions,
          parent_avatar_listing_id: avatar.parent_avatar_listing_id, state: "active", inserted_at: common.updated_at };
      for (const key of ["gltf", "bin", "base_map", "emissive_map", "normal_map", "orm_map"]) payload[`${key}_owned_file_id`] = avatar[`${key}_owned_file_id`];
      await mutation({ item, key: "listing", intent: { body: payload }, save,
        send: async ({ body }) => {
          if ((await rows("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`)).length) throw new Error("Listing SID collision");
          await request("/api/postgrest/avatar_listings", "POST", body);
        },
        inspect: async ({ body }) => {
          const current = await exact("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`);
          if (Object.entries(body).some(([k, v]) => !fieldEqual(k, current[k], v))) throw new Error("Listing ownership/content collision");
          return current;
        }
      });
      const promote = item.operations?.promote?.intent || { body: { reviewed_at: common.updated_at, allow_promotion: true, updated_at: new Date().toISOString() } };
      await mutation({ item, key: "promote", intent: promote, save,
        send: ({ body }) => patch("avatars", item.savedAvatar, body),
        inspect: async ({ body }) => {
          const current = await exact("avatars", `avatar_sid=eq.${item.avatarSid}`);
          assertRow(current, { ...item.savedAvatar, ...body }); return current;
        }
      });
    }
    const listing = await exact("avatar_listings", `avatar_listing_sid=eq.${item.listingSid}`);
    if (listing.name !== e.name || listing.thumbnail_owned_file_id !== avatar.thumbnail_owned_file_id) throw new Error("Write readback mismatch");
    await checkModel(item.listingSid, a);
    item.stage = "done"; item.avatarId = avatar.id; item.listingId = listing.id;
    item.thumbnailOwnedFileId = avatar.thumbnail_owned_file_id; item.completedAt = new Date().toISOString(); await save();
    console.log(`PUBLISHED ${e.name} (${item.listingSid})`);
  }
}
await main();
}
finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCatalog().catch(error => { console.error(error.message); process.exitCode = 1; });
}

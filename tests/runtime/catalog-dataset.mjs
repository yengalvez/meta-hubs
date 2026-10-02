// Preparation only for the existing owned native Reticulum runner. No API,
// production values, database connection, importer apply or runtime authority.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { splitGlb } from "../../deployment/import-local-avatars.mjs";

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export const approvedCatalogHash = "b516e6edb68ef484d6a4547eb3b52a90e5bceed00d83a0185f0df1a2b6dfdbab";
export const approvedAssetBinding = "0c20c58c231996f43fe30a19ee9b8fac67ba583d710cb0dfa4ea7183c3641443";
export const preservedListings = ["84PKFaQ", "y_GoczU", "x0h-wd0", "f8zTm-g", "mKOnfC8", "t_zomhE", "3LVfOJj"];

export function validateCatalogEntries(entries) {
  assert.ok(Array.isArray(entries) && entries.length === 33, "exact_catalog_count_required");
  for (const entry of entries) {
    assert.ok(entry && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(entry.stem) &&
      typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 120 &&
      typeof entry.category === "string" &&
      (entry.existing_listing === null || preservedListings.includes(entry.existing_listing)), "catalog_entry_invalid");
  }
  for (const key of ["stem", "name"]) assert.equal(new Set(entries.map(entry => entry[key])).size, 33, "catalog_duplicate");
  assert.deepEqual(entries.filter(entry => entry.existing_listing).map(entry => entry.existing_listing).sort(),
    [...preservedListings].sort(), "preserved_catalog_ids_required");
}

export function assertEmbeddedModel(gltf) {
  for (const resource of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
    assert.ok(resource.uri === undefined || (typeof resource.uri === "string" && resource.uri.startsWith("data:")),
      "catalog_external_resource_forbidden");
  }
}

function directFile(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), "direct_owned_catalog_file_required");
  return fs.readFileSync(file);
}

export function prepareCatalogDataset({ root, work, receiptsPath }) {
  assert.ok(/^\/private\/tmp\/ynret-local-[A-Za-z0-9]+$/.test(work), "owned_catalog_scratch_required");
  const workStat = fs.lstatSync(work);
  assert.ok(workStat.isDirectory() && !workStat.isSymbolicLink() && workStat.uid === process.getuid() &&
    (workStat.mode & 0o777) === 0o700, "private_catalog_scratch_required");
  const manifestPath = path.join(root, "features/avatar-creator/rpm-catalog.json");
  const manifestBytes = directFile(manifestPath), receiptBytes = directFile(receiptsPath);
  assert.equal(sha(manifestBytes), approvedCatalogHash, "approved_catalog_bytes_required");
  const { entries } = JSON.parse(manifestBytes), receipts = JSON.parse(receiptBytes);
  validateCatalogEntries(entries);
  assert.ok(Array.isArray(receipts) && receipts.length === 33, "exact_catalog_receipts_required");
  const prepared = [], originals = [], binding = [];
  for (const entry of entries) {
    const matches = receipts.filter(receipt => path.basename(receipt.file, ".glb") === entry.stem);
    assert.equal(matches.length, 1, "catalog_source_ambiguous");
    const receipt = matches[0], glb = directFile(receipt.file), png = directFile(receipt.thumbnail);
    assert.ok(glb.length <= 64 * 1024 * 1024 && png.length <= 5 * 1024 * 1024, "catalog_size_limit");
    assert.equal(sha(glb), receipt.sha256, "catalog_glb_changed");
    assert.ok(png.length >= 24 && png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      png.readUInt32BE(16) === 720 && png.readUInt32BE(20) === 1280, "approved_thumbnail_shape_required");
    const pngHash = sha(png), split = splitGlb(glb);
    assertEmbeddedModel(JSON.parse(split.gltf));
    assert.ok(split.tags.includes("fullbody"), "fullbody_catalog_required");
    const bindingRow = { stem: entry.stem, glb_sha256: receipt.sha256, png_sha256: pngHash,
      existing_listing: entry.existing_listing };
    binding.push(bindingRow);
    originals.push({ file: receipt.file, sha256: receipt.sha256 }, { file: receipt.thumbnail, sha256: pngHash });
    prepared.push({ entry, split, png, bindingRow });
  }
  assert.equal(new Set(binding.map(row => row.glb_sha256)).size, 33, "catalog_glb_duplicate");
  assert.equal(sha(Buffer.from(JSON.stringify(binding))), approvedAssetBinding, "approved_asset_binding_required");
  // Validate all inputs before writing any derived material. Reuse the normal
  // importer split/normalization; never overwrite the approved source GLBs.
  const directory = path.join(work, "catalog-input"); fs.mkdirSync(directory, { mode: 0o700 });
  const output = prepared.map(({ entry, split, png, bindingRow }) => {
    const files = {};
    for (const [kind, bytes, contentType] of [["gltf", split.gltf, "model/gltf"],
      ["bin", split.binary, "application/octet-stream"], ["thumbnail", png, "image/png"]]) {
      const file = path.join(directory, `${entry.stem}.${kind}`);
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      files[kind] = { path: file, sha256: sha(bytes), size: bytes.length, content_type: contentType };
    }
    return { ...bindingRow, name: entry.name, category: entry.category,
      listing_sid: entry.existing_listing ?? crypto.createHash("sha256")
        .update(`yenhubs-rpm-catalog-v1:${bindingRow.glb_sha256}`).digest("base64url").slice(0, 7),
      tags: [...new Set([...split.tags, "featured"])], files };
  });
  // New listing IDs use precisely the existing catalog importer's hash rule.
  assert.equal(new Set(output.map(row => row.listing_sid)).size, 33, "catalog_listing_collision");
  const input = path.join(directory, "input.json");
  fs.writeFileSync(input, JSON.stringify({ schema: 1, scope: "owned-synthetic-catalog-not-production-or-cycles",
    binding: approvedAssetBinding, entries: output }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const assertUnchanged = () => {
    assert.equal(sha(directFile(manifestPath)), approvedCatalogHash, "catalog_manifest_changed_during_sample");
    assert.equal(sha(directFile(receiptsPath)), sha(receiptBytes), "catalog_receipts_changed_during_sample");
    for (const original of originals) assert.equal(sha(directFile(original.file)), original.sha256, "catalog_original_changed_during_sample");
  };
  assertUnchanged();
  return { input, assertUnchanged, originals: 66, listings: 33, preserved: 7,
    source_bytes: prepared.reduce((sum, item) => sum + item.split.binary.length + item.split.gltf.length + item.png.length, 0) };
}

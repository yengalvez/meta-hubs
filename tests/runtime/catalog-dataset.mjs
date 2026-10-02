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

export function validateGraphFixtures(project, model) {
  assert.ok(project.version === 3 && project.entities?.[project.root], "spoke_fixture_root_required");
  assert.ok(Object.values(project.entities).some(entity => entity.components?.some(component => component.name === "floor-plan")),
    "spoke_floor_plan_required");
  assert.ok(model.nodes?.some(node => node.extensions?.MOZ_hubs_components?.["nav-mesh"]), "scene_navmesh_required");
  assertEmbeddedModel(model);
  const visit = value => {
    if (typeof value === "string") assert.ok(!/^(?:https?:|file:|ftp:|\/\/)/i.test(value), "graph_remote_resource_forbidden");
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(project); visit(model);
}

export function localizeGraphModel(source, png) {
  assert.equal(source.readUInt32LE(0), 0x46546c67, "scene_glb_header_required");
  assert.equal(source.readUInt32LE(4), 2, "scene_glb_v2_required");
  assert.equal(source.readUInt32LE(8), source.length, "scene_glb_length_required");
  const jsonLength = source.readUInt32LE(12), binaryOffset = 20 + jsonLength;
  assert.equal(source.readUInt32LE(16), 0x4e4f534a, "scene_glb_json_required");
  assert.equal(source.readUInt32LE(binaryOffset + 4), 0x004e4942, "scene_glb_bin_required");
  const binaryLength = source.readUInt32LE(binaryOffset);
  assert.equal(binaryOffset + 8 + binaryLength, source.length, "scene_glb_closed_chunks_required");
  const model = JSON.parse(source.subarray(20, binaryOffset).toString().replace(/\u0000+$/g, "").trimEnd());
  const old = "https://hubs.local:4000/files/34a46e72-56f9-46b1-9219-bc6b890fe233.png";
  const images = model.nodes.filter(node => node.extensions?.MOZ_hubs_components?.image?.src === old);
  assert.equal(images.length, 1, "exact_scene_fixture_image_required");
  // Derive privately: replace precisely this fixture's missing external image
  // with approved PNG bytes, preserving geometry/BIN, source GLB and all IDs.
  images[0].extensions.MOZ_hubs_components.image.src = `data:image/png;base64,${png.toString("base64")}`;
  const json = Buffer.from(JSON.stringify(model)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const out = Buffer.alloc(12 + 8 + padded.length + 8 + binaryLength);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  out.writeUInt32LE(binaryLength, 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length);
  source.subarray(binaryOffset + 8).copy(out, 28 + padded.length);
  return { bytes: out, model };
}

function directFile(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), "direct_owned_catalog_file_required");
  return fs.readFileSync(file);
}

export function prepareCatalogDataset({ root, work, receiptsPath, includeGraph = false }) {
  assert.equal(typeof includeGraph, "boolean", "closed_catalog_graph_selector_required");
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
  let graphPrepared;
  if (includeGraph) {
    const fixture = path.join(root, "hubs-cloud/community-edition/services/reticulum/test/fixtures");
    const modelPath = path.join(fixture, "test.glb"), projectPath = path.join(fixture, "spoke-project.json");
    const originalModel = directFile(modelPath), project = directFile(projectPath);
    const modelHash = "06f157f1c11e3f03b465e976f27e691dca25461964d660ee1bf3cb186d832385";
    const projectHash = "c17c76f2fa2231e28551e4b509f0d3fe77efdf35e697772b77a1b3187e18529c";
    assert.equal(sha(originalModel), modelHash, "approved_scene_fixture_changed");
    assert.equal(sha(project), projectHash, "approved_project_fixture_changed");
    const localized = localizeGraphModel(originalModel, prepared[0].png);
    validateGraphFixtures(JSON.parse(project), localized.model);
    originals.push({ file: modelPath, sha256: modelHash }, { file: projectPath, sha256: projectHash });
    graphPrepared = { model: localized.bytes, project };
  }
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
  let graph;
  if (graphPrepared) {
    const files = {};
    for (const [kind, bytes, contentType] of [["model", graphPrepared.model, "model/gltf-binary"],
      ["scene", graphPrepared.project, "application/json"], ["project", graphPrepared.project, "application/json"]]) {
      const file = path.join(directory, `graph-${kind}`);
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      files[kind] = { path: file, sha256: sha(bytes), size: bytes.length, content_type: contentType };
    }
    // New encryption/OwnedFile belongs to the distinct project owner, not
    // reuse of the catalog account's row. Only the approved PNG bytes repeat.
    files.thumbnail = output[0].files.thumbnail;
    graph = { scope: "native-synthetic-room-project-graph-not-current-metaverse", files };
  }
  const input = path.join(directory, "input.json");
  fs.writeFileSync(input, JSON.stringify({ schema: 1, scope: "owned-synthetic-catalog-not-production-or-cycles",
    binding: approvedAssetBinding, entries: output, ...(graph ? { graph } : {}) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const assertUnchanged = () => {
    assert.equal(sha(directFile(manifestPath)), approvedCatalogHash, "catalog_manifest_changed_during_sample");
    assert.equal(sha(directFile(receiptsPath)), sha(receiptBytes), "catalog_receipts_changed_during_sample");
    for (const original of originals) assert.equal(sha(directFile(original.file)), original.sha256, "catalog_original_changed_during_sample");
  };
  assertUnchanged();
  return { input, assertUnchanged, originals: originals.length, listings: 33, preserved: 7,
    graph: Boolean(graph),
    source_bytes: prepared.reduce((sum, item) => sum + item.split.binary.length + item.split.gltf.length + item.png.length, 0) +
      (graph ? Object.values(graph.files).reduce((sum, file) => sum + file.size, 0) : 0) };
}

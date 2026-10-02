import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { runtimeCases } from "./reticulum-local.mjs";
import { assertEmbeddedModel, approvedCatalogHash, preservedListings, validateCatalogEntries, validateGraphFixtures, localizeGraphModel } from "./catalog-dataset.mjs";

test("catalog target is exactly one new native case, never replaying profile/chat matrices", () => {
  assert.deepEqual(runtimeCases("--catalog-dataset"), [{ profile: "catalog-dataset", count: 1 }]);
  assert.throws(() => runtimeCases("--catalog-dataset-all"), /explicit_native_target_required/);
});

test("catalog route retains private PG/port/cache confinement and exact opt-in asset input", () => {
  const driver = readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
  assert.match(driver, /args\[5\] !== "--catalog-receipts"/);
  assert.match(driver, /prepareCatalogDataset\(/);
  assert.ok(driver.includes('step("capture-owned-catalog-sql-and-source-identity", captureOwnedCatalogDump)'), "fixed identity-bound capture invoked");
  assert.match(driver, /assertPostmaster\(work, data, port, epoch\)/);
  assert.match(driver, /networkProfile\(port\)/);
  assert.match(driver, /"pg_dump"/);
  assert.match(driver, /catalog_source_before/);
  assert.match(driver, /catalog_source_after/);
});

test("exact public catalog controls retain seven IDs and reject missing or duplicate entries", () => {
  const entries = JSON.parse(readFileSync(new URL("../../features/avatar-creator/rpm-catalog.json", import.meta.url))).entries;
  assert.doesNotThrow(() => validateCatalogEntries(entries));
  assert.equal(preservedListings.length, 7);
  assert.match(approvedCatalogHash, /^[a-f0-9]{64}$/);
  for (const change of [rows => rows.pop(), rows => { rows[32].stem = rows[0].stem; },
    rows => { rows[32].name = rows[0].name; }, rows => { rows[0].existing_listing = null; },
    rows => { rows[7].existing_listing = rows[0].existing_listing; }, rows => { rows[7].stem = "../outside"; }]) {
    const changed = structuredClone(entries); change(changed);
    assert.throws(() => validateCatalogEntries(changed));
  }
});

test("catalog-derived GLTF permits embedded data only, never remote or relative resources", () => {
  assert.doesNotThrow(() => assertEmbeddedModel({ buffers: [{ byteLength: 16 }], images: [{ uri: "data:image/png;base64,aA==" }] }));
  for (const uri of ["https://meta-hubs.org/owned/file", "http://localhost:5432", "../texture.png", "/texture.png", "file:///private/key", 13]) {
    assert.throws(() => assertEmbeddedModel({ images: [{ uri }] }), /catalog_external_resource_forbidden/);
  }
});

test("missing catalog receipts cannot start source materialization or a database", () => {
  for (const args of [["--catalog-dataset"], ["--catalog-dataset", "--pg-bin", "/missing", "--cache-reticulum", "/missing"],
    ["--catalog-dataset", "--pg-bin", "/missing", "--cache-reticulum", "/missing", "--cache-bot-orchestrator", "/missing"]]) {
    const result = spawnSync(process.execPath, [new URL("./reticulum-local.mjs", import.meta.url).pathname, ...args], {
      env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.match(result.stderr, /RET_LOCAL_FAIL:arguments:explicit_native_target_required/);
  }
});

test("normal short guards are registered exactly once locally and in security CI", () => {
  for (const [file, invocation] of [["../../scripts/verify-project.sh", 'node --test "$ROOT_DIR/tests/runtime/catalog-dataset.test.mjs"'],
    ["../../.github/workflows/project-security.yml", "node --test tests/runtime/catalog-dataset.test.mjs"]]) {
    const content = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(content.split(invocation).length - 1, 1);
  }
});

test("catalog graph target adds exactly one case and requires native floor-plan sources", () => {
  assert.deepEqual(runtimeCases("--catalog-graph-dataset"), [{ profile: "catalog-graph-dataset", count: 1 }]);
  const base = new URL("../../hubs-cloud/community-edition/services/reticulum/test/fixtures/", import.meta.url);
  const project = JSON.parse(readFileSync(new URL("spoke-project.json", base)));
  const glb = readFileSync(new URL("test.glb", base));
  const original = Buffer.from(glb);
  const unlocalized = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString().replace(/\u0000+$/g, "").trimEnd());
  assert.throws(() => validateGraphFixtures(project, unlocalized), /graph_remote_resource_forbidden/);
  const { bytes, model } = localizeGraphModel(glb, Buffer.from("owned-png-control"));
  assert.deepEqual(glb, original, "original fixture remains byte-identical");
  const oldBin = 28 + glb.readUInt32LE(12), newBin = 28 + bytes.readUInt32LE(12);
  assert.deepEqual(bytes.subarray(newBin), glb.subarray(oldBin), "geometry binary unchanged");
  assert.doesNotThrow(() => validateGraphFixtures(project, model));
  const noFloor = structuredClone(project);
  for (const entity of Object.values(noFloor.entities)) entity.components = entity.components?.filter(c => c.name !== "floor-plan");
  assert.throws(() => validateGraphFixtures(noFloor, model), /spoke_floor_plan_required/);
  assert.throws(() => validateGraphFixtures(project, { ...model, nodes: [] }), /scene_navmesh_required/);
  for (const uri of ["https://meta-hubs.org/data", "file:///private/values", "//external.invalid/model"]) {
    assert.throws(() => validateGraphFixtures({ ...project, metadata: { uri } }, model), /graph_remote_resource_forbidden/);
  }
});

test("catalog graph retains separate SQL ownership and all additional encrypted file guards", () => {
  const native = readFileSync(new URL("./reticulum-catalog-graph.exs", import.meta.url), "utf8");
  const driver = readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
  assert.match(native, /Project\.project_by_sid_for_account\(project\.project_sid, room_owner\) == nil/);
  assert.match(native, /refute Hub\.is_owner\?\(fresh_hub, project_owner\.account_id\)/);
  assert.match(native, /Postgrex\.start_link/);
  assert.match(native, /Storage\.fetch\(current\)/);
  assert.match(native, /current\.state == :active/);
  assert.match(driver, /const ownedPairs = catalog\.graph \? 103 : 99/);
});

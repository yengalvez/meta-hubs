import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildCapacityModel, loadModelManifest, validateEnvironmentSnapshot } from "../lib/model.mjs";
import { writeCompletedBundle } from "../lib/driver.mjs";
import { buildReport } from "../lib/report.mjs";
import { canonicalJson, loadCatalogue, loadCosts, loadThresholds } from "../lib/io.mjs";
import { validateCatalogue, validateThresholds } from "../lib/schema.mjs";
import {
  buildTestPlan,
  makePhysicalGeneratorInventory,
  makePassingEvidence,
  makeTestEnvironment,
  promoteFixtureEvidenceToPhysical
} from "../test-support/fixtures.mjs";
import { TEST_SIGNER } from "../test-support/trust.mjs";
import { signAndVerifyDocument } from "../lib/trust.mjs";

const scenarios = validateCatalogue(await loadCatalogue());
const thresholds = validateThresholds(await loadThresholds());
const costs = await loadCosts();
const scenario = scenarios.get("total-10000-model");

const completeSpecs = [
  { scenarioId: "room-30", runId: "11111111-1111-4111-8111-111111111111", modelOffset: -20 },
  { scenarioId: "room-30", runId: "22222222-2222-4222-8222-222222222222", modelOffset: 20 },
  { scenarioId: "room-100-experimental", runId: "33333333-3333-4333-8333-333333333333", modelOffset: -20 },
  { scenarioId: "room-100-experimental", runId: "44444444-4444-4444-8444-444444444444", modelOffset: 20 },
  { scenarioId: "total-300", runId: "55555555-5555-4555-8555-555555555555", modelOffset: -20 },
  { scenarioId: "total-300", runId: "66666666-6666-4666-8666-666666666666", modelOffset: 20 }
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value, pretty = false) {
  return Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, "utf8");
}

async function writeBundle(root, spec, environment) {
  const directory = join(root, `bundle-${spec.runId.slice(0, 8)}`);
  await mkdir(directory);
  const physicalScenario = scenarios.get(spec.scenarioId);
  const target = physicalScenario.roomCount > 1
    ? "https://capacity-staging.example.org/{room}"
    : "https://capacity-staging.example.org/room";
  const plan = buildTestPlan({
    scenarios,
    scenarioId: spec.scenarioId,
    target,
    runId: spec.runId,
    executionEnabled: true,
    environment
  });
  const promoted = promoteFixtureEvidenceToPhysical(
    plan,
    makePassingEvidence(plan, thresholds, { modelOffset: spec.modelOffset })
  );
  const rawSamples = promoted.raw.samples;
  delete promoted.raw.samples;
  const report = buildReport({ plan, evidence: promoted, thresholds, rawSamples, allowTestTrust: true });
  const manifest = await writeCompletedBundle({
    outputDirectory: directory,
    plan,
    rawSamples,
    evidence: promoted,
    report,
    environment,
    collectorEndpoint: plan.security.collectorEndpoints[0],
    driverSha256: promoted.run.driver.sha256,
    generatorInventory: makePhysicalGeneratorInventory(plan, promoted.run),
    signer: TEST_SIGNER
  });
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  assert.equal(manifest.schemaVersion, 4);
  return {
    runId: spec.runId,
    path: `${relative(root, directory)}/manifest.json`,
    sha256: sha256(manifestBytes)
  };
}

async function makeModelTree(specs = completeSpecs, environment = makeTestEnvironment()) {
  const root = await mkdtemp(join(tmpdir(), "yenhubs-capacity-model-"));
  const bundles = [];
  for (const spec of specs) bundles.push(await writeBundle(root, spec, environment));
  const manifest = {
    schemaVersion: 3,
    modelObservedAt: "2026-07-18T10:00:00.000Z",
    assumptions: { operationalRoomsPerNodeCap: 8, headroomRatios: [0.2, 0.3, 0.4] },
    bundles
  };
  const path = join(root, "model-manifest.json");
  await writeFile(path, jsonBytes(manifest, true));
  return { root, path, manifest };
}

let sharedTree;
test.before(async () => {
  sharedTree = await makeModelTree();
});
test.after(async () => {
  if (sharedTree) await rm(sharedTree.root, { recursive: true, force: true });
});

test("10,000 model emits no projection without factorial evidence, bounded extrapolation and DB fencing", async () => {
  const input = await loadModelManifest(sharedTree.path, { allowTestTrust: true });
  assert.ok(input.bundles.every(bundle => !Object.hasOwn(bundle, "rawSamples")));
  const model = buildCapacityModel({
    scenario,
    input,
    botsPerRoom: 0,
    costs,
    thresholds,
    allowTestTrust: true
  });
  assert.equal(model.state, "INSUFFICIENT");
  assert.deepEqual(Object.keys(model).sort(), [
    "schemaVersion", "state", "certified", "physicalExecutionAllowed", "reasons", "evidencePolicy", "note"
  ].sort());
  assert.equal(model.certified, false);
  assert.equal(model.physicalExecutionAllowed, false);
  assert.equal(model.evidencePolicy.acceptedBundles, 6);
  assert.equal(model.evidencePolicy.minimumDistinctLoads, 3);
  assert.deepEqual(model.evidencePolicy.requiredScenarioIds, [
    "room-30", "room-100-experimental", "total-300"
  ]);
  assert.equal(Object.hasOwn(model, "fits"), false);
  assert.equal(Object.hasOwn(model, "costs"), false);
  assert.ok(model.reasons.includes("factorial-participant-room-design-required"));
  assert.ok(model.reasons.includes("participant-extrapolation-ratio-exceeds-3"));
  assert.ok(model.reasons.includes("room-extrapolation-ratio-exceeds-3"));
  assert.ok(model.reasons.includes("reticulum-horizontal-scaling-requires-database-fenced-bot-runner-lease"));
  assert.ok(model.reasons.includes("physical-evidence-readiness-blocked"));
  assert.ok(model.reasons.includes("server-observability-contract-unavailable"));
  assert.ok(model.reasons.includes("base-owned-physical-readiness-authorization-required"));
  assert.equal(model.evidencePolicy.maximumExtrapolationRatio, 3);
  assert.deepEqual(model.evidencePolicy.observedMaximums, { participants: 300, rooms: 12 });

  const reorderedCosts = { ...costs, workerSkus: [...costs.workerSkus].reverse() };
  const reorderedModel = buildCapacityModel({
    scenario,
    input,
    botsPerRoom: 0,
    costs: reorderedCosts,
    thresholds,
    allowTestTrust: true
  });
  assert.equal(reorderedModel.state, "INSUFFICIENT");
  assert.equal(Object.hasOwn(reorderedModel, "costs"), false);
  assert.deepEqual(reorderedModel.reasons, model.reasons);
});

test("Reticulum remains exactly one replica until BotRunnerLease has database arbitration and fencing", () => {
  assert.equal(validateEnvironmentSnapshot(makeTestEnvironment(), undefined, undefined, {
    productionOnly: false
  }).replicas.reticulum, 1);
  const unsafe = makeTestEnvironment(undefined, {
    replicas: { reticulum: 2, dialog: 2, coturn: 2 }
  });
  assert.throws(
    () => validateEnvironmentSnapshot(unsafe, undefined, undefined, { productionOnly: false }),
    error => error.code === "MODEL_ENVIRONMENT_INVALID"
  );
});

test("production loader rejects the separate test trust anchor", async () => {
  await assert.rejects(
    () => loadModelManifest(sharedTree.path),
    error => error.code === "SIGNATURE_UNTRUSTED"
  );
});

test("loader rejects traversal, ancestor symlinks and artifact hash drift", async () => {
  const originalModelManifest = await readFile(sharedTree.path);
  const firstManifest = join(sharedTree.root, sharedTree.manifest.bundles[0].path);
  const rawPath = firstManifest.replace("manifest.json", "raw.ndjson");
  const originalRaw = await readFile(rawPath);
  const linkedDirectory = join(sharedTree.root, "linked-bundle");
  try {
    const traversal = structuredClone(sharedTree.manifest);
    traversal.bundles[0].path = "../manifest.json";
    await writeFile(sharedTree.path, jsonBytes(traversal, true));
    await assert.rejects(() => loadModelManifest(sharedTree.path, { allowTestTrust: true }), error => error.code === "MODEL_BUNDLE_INVALID");

    await writeFile(sharedTree.path, originalModelManifest);
    const originalDirectory = dirname(firstManifest);
    await symlink(originalDirectory, linkedDirectory, "dir");
    const linked = structuredClone(sharedTree.manifest);
    linked.bundles[0].path = "linked-bundle/manifest.json";
    await writeFile(sharedTree.path, jsonBytes(linked, true));
    await assert.rejects(() => loadModelManifest(sharedTree.path, { allowTestTrust: true }), error => error.code === "MODEL_BUNDLE_INVALID");

    await writeFile(sharedTree.path, originalModelManifest);
    await writeFile(rawPath, Buffer.from("{}\n"));
    await assert.rejects(() => loadModelManifest(sharedTree.path, { allowTestTrust: true }), error => error.code === "MODEL_BUNDLE_HASH_INVALID");
  } finally {
    await writeFile(sharedTree.path, originalModelManifest);
    await writeFile(rawPath, originalRaw);
    await rm(linkedDirectory, { recursive: true, force: true });
  }
});

test("signed manifest and raw claims cannot be resealed with hashes alone", async () => {
  const originalModelManifest = await readFile(sharedTree.path);
  const reference = sharedTree.manifest.bundles[0];
  const manifestPath = join(sharedTree.root, reference.path);
  const originalManifest = await readFile(manifestPath);
  try {
    const manifest = JSON.parse(originalManifest);
    manifest.execution.driverSha256 = "f".repeat(64);
    const bytes = jsonBytes(manifest, true);
    await writeFile(manifestPath, bytes);
    const modelManifest = structuredClone(sharedTree.manifest);
    modelManifest.bundles[0].sha256 = sha256(bytes);
    await writeFile(sharedTree.path, jsonBytes(modelManifest, true));
    await assert.rejects(
      () => loadModelManifest(sharedTree.path, { allowTestTrust: true }),
      error => error.code === "SIGNATURE_INVALID"
    );
  } finally {
    await writeFile(manifestPath, originalManifest);
    await writeFile(sharedTree.path, originalModelManifest);
  }
});

test("even a signed manifest cannot detach raw bytes from canonical NDJSON provenance", async () => {
  const originalModelManifest = await readFile(sharedTree.path);
  const reference = sharedTree.manifest.bundles[0];
  const manifestPath = join(sharedTree.root, reference.path);
  const rawPath = manifestPath.replace("manifest.json", "raw.ndjson");
  const originalManifest = await readFile(manifestPath);
  const originalRaw = await readFile(rawPath);
  try {
    const nonCanonicalRaw = Buffer.concat([originalRaw.subarray(0, -1), Buffer.from(" \n")]);
    await writeFile(rawPath, nonCanonicalRaw);
    const unsignedManifest = JSON.parse(originalManifest);
    delete unsignedManifest.signature;
    unsignedManifest.artifacts.raw = {
      ...unsignedManifest.artifacts.raw,
      sha256: sha256(nonCanonicalRaw),
      bytes: nonCanonicalRaw.length
    };
    unsignedManifest.rawIntegrity = signAndVerifyDocument({
      schemaVersion: 1,
      runId: unsignedManifest.runId,
      planId: unsignedManifest.planId,
      artifact: unsignedManifest.artifacts.raw
    }, { purpose: "raw-artifact", signer: TEST_SIGNER, productionOnly: false });
    const signedManifest = signAndVerifyDocument(unsignedManifest, {
      purpose: "bundle-manifest",
      signer: TEST_SIGNER,
      productionOnly: false
    });
    const manifestBytes = jsonBytes(signedManifest, true);
    await writeFile(manifestPath, manifestBytes);
    const modelManifest = structuredClone(sharedTree.manifest);
    modelManifest.bundles[0].sha256 = sha256(manifestBytes);
    await writeFile(sharedTree.path, jsonBytes(modelManifest, true));
    await assert.rejects(
      () => loadModelManifest(sharedTree.path, { allowTestTrust: true }),
      error => error.code === "MODEL_BUNDLE_HASH_INVALID"
    );
  } finally {
    await writeFile(rawPath, originalRaw);
    await writeFile(manifestPath, originalManifest);
    await writeFile(sharedTree.path, originalModelManifest);
  }
});

test("signed bundle loading rejects a generator inventory with post-STOP orphans", async () => {
  const originalModelManifest = await readFile(sharedTree.path);
  const reference = sharedTree.manifest.bundles[0];
  const manifestPath = join(sharedTree.root, reference.path);
  const originalManifest = await readFile(manifestPath);
  const parsedManifest = JSON.parse(originalManifest);
  const inventoryPath = join(dirname(manifestPath), parsedManifest.artifacts.generatorInventory.path);
  const originalInventory = await readFile(inventoryPath);
  try {
    const inventory = JSON.parse(originalInventory);
    inventory.hosts[0].liveDescendantCountAfterStop = 1;
    const inventoryBytes = jsonBytes(inventory, true);
    await writeFile(inventoryPath, inventoryBytes);

    const unsignedManifest = JSON.parse(originalManifest);
    delete unsignedManifest.signature;
    unsignedManifest.artifacts.generatorInventory = {
      ...unsignedManifest.artifacts.generatorInventory,
      sha256: sha256(inventoryBytes),
      bytes: inventoryBytes.length
    };
    unsignedManifest.execution.generatorInventorySha256 = sha256(inventoryBytes);
    const signedManifest = signAndVerifyDocument(unsignedManifest, {
      purpose: "bundle-manifest",
      signer: TEST_SIGNER,
      productionOnly: false
    });
    const manifestBytes = jsonBytes(signedManifest, true);
    await writeFile(manifestPath, manifestBytes);

    const modelManifest = structuredClone(sharedTree.manifest);
    modelManifest.bundles[0].sha256 = sha256(manifestBytes);
    await writeFile(sharedTree.path, jsonBytes(modelManifest, true));
    await assert.rejects(
      () => loadModelManifest(sharedTree.path, { allowTestTrust: true }),
      error => error.code === "PHYSICAL_HOST_IDENTITY_INVALID"
    );
  } finally {
    await writeFile(inventoryPath, originalInventory);
    await writeFile(manifestPath, originalManifest);
    await writeFile(sharedTree.path, originalModelManifest);
  }
});

test("insufficient repetitions or topology coherence emit no cost projection", async () => {
  const input = await loadModelManifest(sharedTree.path, { allowTestTrust: true });
  const insufficient = buildCapacityModel({
    scenario,
    input: { ...input, bundles: input.bundles.slice(0, 5) },
    botsPerRoom: 0,
    costs,
    thresholds,
    allowTestTrust: true
  });
  assert.equal(insufficient.state, "INSUFFICIENT");
  assert.equal(Object.hasOwn(insufficient, "costs"), false);
  assert.ok(insufficient.reasons.some(reason => reason.includes("total-300")));

  const mismatchedCosts = structuredClone(costs);
  mismatchedCosts.workerSkus.find(item => item.id === "s-4vcpu-8gb").id = "s-4vcpu-8gb-renamed";
  const mismatch = buildCapacityModel({
    scenario,
    input,
    botsPerRoom: 0,
    costs: mismatchedCosts,
    thresholds,
    allowTestTrust: true
  });
  assert.equal(mismatch.state, "INSUFFICIENT");
  assert.equal(Object.hasOwn(mismatch, "costs"), false);
  assert.ok(mismatch.reasons.includes("observed-resources-do-not-match-topology-sku-and-node-count"));
});

test("physical scenario cannot be presented as a model-only result", () => {
  assert.throws(
    () => buildCapacityModel({
      scenario: scenarios.get("room-30"), input: {}, botsPerRoom: 0, costs, thresholds
    }),
    error => error.code === "MODEL_SCENARIO_REQUIRED"
  );
});

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { invalid } from "./errors.mjs";
import {
  canonicalJson,
  loadThresholds,
  readJsonFile,
  readNdjsonFile,
  stableId
} from "./io.mjs";
import { validatePlan } from "./plan-contract.mjs";
import { buildReport } from "./report.mjs";
import { validateThresholds } from "./schema.mjs";
import { signedDocumentBinding, verifySignedDocument } from "./trust.mjs";
import { computeTrackedTreeIdentity } from "./integrity.mjs";
import { rawArtifact } from "./provenance.mjs";
import {
  assertPhysicalExecutionReady,
  trackedPhysicalReadinessSummary,
  validatePhysicalGeneratorInventory
} from "./physical-readiness.mjs";

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_RAW_BYTES = 192 * 1024 * 1024;
const MAX_REPORT_AGE_DAYS = 30;
const MAX_COST_CATALOGUE_AGE_DAYS = 90;
const MINIMUM_DISTINCT_LOADS = 3;
const MINIMUM_REPETITIONS_PER_LOAD = 2;
const MINIMUM_R_SQUARED = 0.8;
const MAX_EXTRAPOLATION_RATIO = 3;
const REQUIRED_PHYSICAL_SCENARIOS = new Set(["room-30", "room-100-experimental", "total-300"]);
const HEADROOM_RATIOS = [0.2, 0.3, 0.4];
const ARTIFACT_NAMES = [
  "plan", "raw", "evidence", "report", "environment", "executionConfig", "lockfile",
  "collectorConfig", "generatorInventory", "harnessTree"
];
const VERIFIED_BUNDLE = Symbol("verified-capacity-bundle");

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function validSampleLink(item, rawSha256) {
  return Boolean(item && item.rawSha256 === rawSha256 && Number.isInteger(item.sampleCount) && item.sampleCount > 0 &&
    /^[0-9a-f]{64}$/.test(item.sampleIdsSha256) && typeof item.firstSampleId === "string" &&
    typeof item.lastSampleId === "string" && canonicalIso(item.firstObservedAt) !== null && canonicalIso(item.lastObservedAt) !== null);
}

async function readArtifact(path, label, maximumBytes = MAX_REPORT_BYTES, { loadBytes = true } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw invalid(`${label} could not be inspected`, "MODEL_BUNDLE_READ_FAILED", { reason: error.code ?? "unknown" });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > maximumBytes) {
    throw invalid(`${label} must be a non-empty bounded regular file`, "MODEL_BUNDLE_READ_FAILED");
  }
  if (!loadBytes) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
    return { bytes: null, size: metadata.size, sha256: hash.digest("hex") };
  }
  const bytes = await readFile(path);
  return {
    bytes,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function safeChildPath(parent, path, label) {
  if (typeof path !== "string" || path.length === 0 || path.length > 256 || path.includes("\0") ||
      isAbsolute(path) || path.split(/[\\/]+/).some(segment => segment === ".." || segment === "" || segment === ".")) {
    throw invalid(`${label} path is invalid`, "MODEL_BUNDLE_INVALID");
  }
  const root = resolve(parent);
  const candidate = resolve(root, path);
  const local = relative(root, candidate);
  if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw invalid(`${label} must remain inside its manifest directory`, "MODEL_BUNDLE_INVALID");
  }
  let current = root;
  for (const segment of local.split(sep)) {
    current = resolve(current, segment);
    const metadata = await lstat(current).catch(error => {
      throw invalid(`${label} could not be inspected`, "MODEL_BUNDLE_READ_FAILED", { reason: error.code ?? "unknown" });
    });
    if (metadata.isSymbolicLink()) {
      throw invalid(`${label} cannot traverse a symbolic link`, "MODEL_BUNDLE_INVALID");
    }
  }
  const [rootReal, candidateReal] = await Promise.all([realpath(root), realpath(candidate)]);
  const realLocal = relative(rootReal, candidateReal);
  if (realLocal === "" || realLocal === ".." || realLocal.startsWith(`..${sep}`) || isAbsolute(realLocal)) {
    throw invalid(`${label} real path escaped its manifest directory`, "MODEL_BUNDLE_INVALID");
  }
  return candidate;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid(`${label} is not strict JSON`, "MODEL_BUNDLE_INVALID");
  }
}

export function validateEnvironmentSnapshot(
  environment,
  collectorMappingSha256 = undefined,
  runStartedAt = undefined,
  { productionOnly = false } = {}
) {
  verifySignedDocument(environment, { purpose: "environment-snapshot", productionOnly });
  const capturedAtMs = canonicalIso(environment?.capturedAt);
  const runStartedAtMs = runStartedAt === undefined ? null : canonicalIso(runStartedAt);
  if (!exactKeys(environment, ["schemaVersion", "capturedAt", "region", "nodePool", "replicas", "deployment", "signature"]) ||
      environment.schemaVersion !== 1 || capturedAtMs === null ||
      (runStartedAt !== undefined && (runStartedAtMs === null || capturedAtMs > runStartedAtMs ||
        runStartedAtMs - capturedAtMs > 24 * 60 * 60 * 1000)) ||
      typeof environment.region !== "string" || !/^[a-z0-9-]{2,32}$/.test(environment.region) ||
      !exactKeys(environment.nodePool, ["sku", "nodeCount"]) ||
      typeof environment.nodePool.sku !== "string" || environment.nodePool.sku.length < 2 ||
      !Number.isInteger(environment.nodePool.nodeCount) || environment.nodePool.nodeCount < 1 ||
      !exactKeys(environment.replicas, ["reticulum", "dialog", "coturn"]) ||
      Object.values(environment.replicas).some(value => !Number.isInteger(value) || value < 1) ||
      environment.replicas.reticulum !== 1 ||
      !exactKeys(environment.deployment, [
        "hubsCommit", "hubsImageDigest", "hubsCloudCommit", "reticulumImageDigest",
        "dialogImageDigest", "coturnImageDigest", "sceneId", "collectorMappingSha256"
      ]) ||
      !/^[0-9a-f]{40}$/.test(environment.deployment.hubsCommit) ||
      !/^[0-9a-f]{40}$/.test(environment.deployment.hubsCloudCommit) ||
      ["hubsImageDigest", "reticulumImageDigest", "dialogImageDigest", "coturnImageDigest"]
        .some(key => !/^sha256:[0-9a-f]{64}$/.test(environment.deployment[key])) ||
      typeof environment.deployment.sceneId !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(environment.deployment.sceneId) ||
      !/^[0-9a-f]{64}$/.test(environment.deployment.collectorMappingSha256) ||
      (collectorMappingSha256 !== undefined &&
        environment.deployment.collectorMappingSha256 !== collectorMappingSha256)) {
    throw invalid("Bundle environment metadata is incomplete or unbound", "MODEL_ENVIRONMENT_INVALID");
  }
  return environment;
}

function validateExecutionConfig(config, plan, collectorEndpoint) {
  if (!exactKeys(config, ["schemaVersion", "planId", "driverProtocol", "collectorEndpoint", "workerHosts"]) ||
      config.schemaVersion !== 1 || config.planId !== plan.planId ||
      config.driverProtocol !== plan.runtime.driverProtocol || config.collectorEndpoint !== collectorEndpoint ||
      !plan.security.collectorEndpoints.includes(config.collectorEndpoint) ||
      !Array.isArray(config.workerHosts) ||
      canonicalJson(config.workerHosts) !== canonicalJson(plan.executionTopology.hosts.map(host => host.id))) {
    throw invalid("Bundle execution config is not bound to the complete plan", "MODEL_EXECUTION_CONFIG_INVALID");
  }
  return config;
}

function validateBundleManifest(manifest, reference, { productionOnly = true } = {}) {
  verifySignedDocument(manifest, { purpose: "bundle-manifest", productionOnly });
  verifySignedDocument(manifest.rawIntegrity, { purpose: "raw-artifact", productionOnly });
  if (!exactKeys(manifest, ["schemaVersion", "runId", "planId", "artifacts", "rawIntegrity", "execution", "signature"]) ||
      manifest.schemaVersion !== 4 || manifest.runId !== reference.runId ||
      !/^[a-z0-9-]{5,80}$/.test(manifest.planId) ||
      !exactKeys(manifest.artifacts, ARTIFACT_NAMES) ||
      !exactKeys(manifest.execution, [
        "driverSha256", "lockfileSha256", "configSha256", "attestationSha256",
        "environmentSha256", "collectorMappingSha256", "collectorConfigSha256",
        "generatorInventorySha256", "harnessTreeSha256", "collectorEndpoint"
      ]) ||
      ["driverSha256", "lockfileSha256", "configSha256", "attestationSha256", "environmentSha256",
        "collectorMappingSha256", "collectorConfigSha256", "generatorInventorySha256", "harnessTreeSha256"]
        .some(key => !/^[0-9a-f]{64}$/.test(manifest.execution[key])) ||
      manifest.rawIntegrity.runId !== manifest.runId || manifest.rawIntegrity.planId !== manifest.planId ||
      canonicalJson(manifest.rawIntegrity.artifact) !== canonicalJson(manifest.artifacts.raw)) {
    throw invalid("Physical bundle manifest schema or execution identity is invalid", "MODEL_BUNDLE_INVALID");
  }
  for (const name of ARTIFACT_NAMES) {
    const artifact = manifest.artifacts[name];
    if (!exactKeys(artifact, ["path", "sha256", "bytes"]) || typeof artifact.path !== "string" ||
        !/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isInteger(artifact.bytes) || artifact.bytes < 1) {
      throw invalid("Physical bundle artifact identity is invalid", "MODEL_BUNDLE_INVALID", { artifact: name });
    }
  }
  return manifest;
}

async function loadPhysicalBundle(reference, modelDirectory, thresholds, { allowTestTrust = false } = {}) {
  if (!exactKeys(reference, ["runId", "sha256", "path"]) || !/^[0-9a-f-]{36}$/i.test(reference.runId) ||
      !/^[0-9a-f]{64}$/.test(reference.sha256)) {
    throw invalid("Model bundle reference schema is closed", "MODEL_INPUT_INVALID");
  }
  const manifestPath = await safeChildPath(modelDirectory, reference.path, "bundle manifest");
  const manifestArtifact = await readArtifact(manifestPath, "bundle manifest");
  if (manifestArtifact.sha256 !== reference.sha256) {
    throw invalid("Bundle manifest file hash does not match its reference", "MODEL_BUNDLE_HASH_INVALID");
  }
  const manifest = validateBundleManifest(parseJsonBytes(manifestArtifact.bytes, "bundle manifest"), reference, {
    productionOnly: !allowTestTrust
  });
  const bundleDirectory = dirname(manifestPath);
  const loaded = {};
  for (const name of ARTIFACT_NAMES) {
    const expected = manifest.artifacts[name];
    const maximum = name === "raw" ? MAX_MODEL_RAW_BYTES : name === "lockfile" ? 4 * 1024 * 1024 : MAX_REPORT_BYTES;
    const artifact = await readArtifact(
      await safeChildPath(bundleDirectory, expected.path, `${name} artifact`),
      `${name} artifact`,
      maximum,
      { loadBytes: name !== "raw" }
    );
    if (artifact.sha256 !== expected.sha256 || artifact.size !== expected.bytes) {
      throw invalid("Bundle artifact hash or byte count does not match its manifest", "MODEL_BUNDLE_HASH_INVALID", { artifact: name });
    }
    loaded[name] = artifact;
  }
  const plan = parseJsonBytes(loaded.plan.bytes, "plan artifact");
  const evidence = parseJsonBytes(loaded.evidence.bytes, "evidence artifact");
  const report = parseJsonBytes(loaded.report.bytes, "report artifact");
  const environment = parseJsonBytes(loaded.environment.bytes, "environment artifact");
  const executionConfig = parseJsonBytes(loaded.executionConfig.bytes, "execution config artifact");
  const collectorConfig = parseJsonBytes(loaded.collectorConfig.bytes, "collector config artifact");
  const generatorInventory = parseJsonBytes(loaded.generatorInventory.bytes, "generator inventory artifact");
  const harnessTree = parseJsonBytes(loaded.harnessTree.bytes, "harness tree artifact");
  const rawSamples = await readNdjsonFile(
    await safeChildPath(bundleDirectory, manifest.artifacts.raw.path, "raw artifact"),
    "capacity bundle raw evidence",
    { maximumBytes: MAX_MODEL_RAW_BYTES, maximumLines: 500_000 }
  );
  if (canonicalJson(rawArtifact(rawSamples)) !== canonicalJson({
    name: "raw.ndjson",
    sha256: manifest.artifacts.raw.sha256,
    bytes: manifest.artifacts.raw.bytes,
    sampleCount: rawSamples.length
  })) {
    throw invalid("Model raw NDJSON is not canonically bound to its signed manifest", "MODEL_BUNDLE_HASH_INVALID");
  }
  validatePlan(plan, { requireExecutionEnabled: true, productionOnly: !allowTestTrust });
  if (plan.run.id !== reference.runId || plan.planId !== manifest.planId ||
      plan.security.mode !== "attested-remote" || plan.security.attestationSha256 !== manifest.execution.attestationSha256 ||
      evidence.run?.driver?.name !== "yenhubs-playwright-capacity" ||
      evidence.run.driver.sha256 !== manifest.execution.driverSha256 ||
      loaded.lockfile.sha256 !== manifest.execution.lockfileSha256 ||
      loaded.executionConfig.sha256 !== manifest.execution.configSha256 ||
      loaded.environment.sha256 !== manifest.execution.environmentSha256 ||
      evidence.collectorMapping?.sha256 !== manifest.execution.collectorMappingSha256 ||
      loaded.collectorConfig.sha256 !== manifest.execution.collectorConfigSha256 ||
      loaded.generatorInventory.sha256 !== manifest.execution.generatorInventorySha256 ||
      loaded.harnessTree.sha256 !== manifest.artifacts.harnessTree.sha256 ||
      harnessTree.sha256 !== manifest.execution.harnessTreeSha256 ||
      canonicalJson(collectorConfig) !== canonicalJson(evidence.collectorMapping)) {
    throw invalid("Bundle execution identities do not bind one real staging run", "MODEL_BUNDLE_IDENTITY_INVALID");
  }
  validateEnvironmentSnapshot(environment, manifest.execution.collectorMappingSha256, evidence.run?.startedAt, {
    productionOnly: !allowTestTrust
  });
  if (canonicalJson(signedDocumentBinding(environment, "environment-snapshot", { productionOnly: !allowTestTrust })) !==
      canonicalJson(plan.environment)) {
    throw invalid("Bundle environment does not match the signed plan", "MODEL_ENVIRONMENT_INVALID");
  }
  const currentHarnessTree = await computeTrackedTreeIdentity();
  if (canonicalJson(harnessTree) !== canonicalJson(currentHarnessTree)) {
    throw invalid("Bundle harness tree differs from the checked-in production tree", "MODEL_BUNDLE_IDENTITY_INVALID");
  }
  validateExecutionConfig(executionConfig, plan, manifest.execution.collectorEndpoint);
  validatePhysicalGeneratorInventory(generatorInventory, { plan, run: evidence.run });
  const rebuilt = buildReport({ plan, evidence, thresholds, rawSamples, allowTestTrust });
  if (canonicalJson(rebuilt) !== canonicalJson(report)) {
    throw invalid("Bundle report cannot be reconstructed from plan, raw evidence and claims", "MODEL_REPORT_RECONSTRUCTION_FAILED");
  }
  const result = {
    runId: reference.runId,
    manifestSha256: manifestArtifact.sha256,
    artifactSha256: Object.fromEntries(ARTIFACT_NAMES.map(name => [name, loaded[name].sha256])),
    plan,
    report,
    environment,
    executionConfig,
    manifestSignerKeyId: manifest.signature.keyId,
    rawSignerKeyId: manifest.rawIntegrity.signature.keyId
  };
  Object.defineProperty(result, VERIFIED_BUNDLE, { value: true });
  return result;
}

export async function loadModelManifest(path, { allowTestTrust = false } = {}) {
  const manifestPath = resolve(path);
  const manifest = await readJsonFile(manifestPath, "capacity model manifest");
  if (!exactKeys(manifest, ["schemaVersion", "modelObservedAt", "assumptions", "bundles"]) ||
      manifest.schemaVersion !== 3 || !Array.isArray(manifest.bundles) ||
      manifest.bundles.length < 1 || manifest.bundles.length > 24) {
    throw invalid("Model manifest must reference a bounded set of complete physical bundles", "MODEL_INPUT_INVALID");
  }
  const thresholds = validateThresholds(await loadThresholds());
  const bundles = [];
  for (const reference of manifest.bundles) {
    bundles.push(await loadPhysicalBundle(reference, dirname(manifestPath), thresholds, { allowTestTrust }));
  }
  return { ...manifest, bundles };
}

function validateReportIntegrity(report) {
  if (!exactKeys(report, [
    "schemaVersion", "state", "planId", "run", "scenarioId", "certified", "provisionalThresholds",
    "totals", "profiles", "collectorMapping", "collectors", "participantPhases", "rooms", "metrics", "provenance",
    "modelObservations", "breaches", "note", "integrity"
  ]) || report.schemaVersion !== 1 || report.state !== "PASSED" || report.certified !== false ||
      report.provisionalThresholds !== true || !Array.isArray(report.breaches) || report.breaches.length !== 0 ||
      !exactKeys(report.integrity, ["algorithm", "sha256"]) || report.integrity.algorithm !== "sha256" ||
      !/^[0-9a-f]{64}$/.test(report.integrity.sha256)) {
    throw invalid("Model sources must be closed PASSED capacity reports", "MODEL_REPORT_INVALID");
  }
  const core = { ...report };
  delete core.integrity;
  const expected = createHash("sha256").update(canonicalJson(core)).digest("hex");
  if (expected !== report.integrity.sha256) throw invalid("Capacity report internal integrity hash is invalid", "MODEL_REPORT_INVALID");
  if (!exactKeys(report.provenance, ["rawArtifact", "collectorMapping", "aggregates", "population", "profiles", "modelObservations", "bots"]) ||
      !report.provenance.rawArtifact || !/^[0-9a-f]{64}$/.test(report.provenance.rawArtifact.sha256) ||
      canonicalJson(report.collectorMapping) !== canonicalJson(report.provenance.collectorMapping) ||
      Object.keys(report.provenance.profiles ?? {}).length !== 4 ||
      Object.keys(report.provenance.modelObservations ?? {}).length !== 4 ||
      !Array.isArray(report.provenance.population?.phases?.lobby) ||
      !Array.isArray(report.provenance.population?.phases?.room) ||
      report.provenance.population.phases.lobby.length === 0 || report.provenance.population.phases.room.length === 0 ||
      report.provenance.bots?.state !== "observed" ||
      !report.provenance.aggregates || Object.values(report.provenance.aggregates).some(item =>
        !validSampleLink(item, report.provenance.rawArtifact.sha256)
      ) || Object.values(report.provenance.profiles ?? {}).some(item =>
        !validSampleLink(item, report.provenance.rawArtifact.sha256)
      ) || Object.values(report.provenance.modelObservations ?? {}).some(item =>
        !validSampleLink(item, report.provenance.rawArtifact.sha256)
      )) {
    throw invalid("Capacity report lacks linked raw aggregate provenance", "MODEL_REPORT_INVALID");
  }
}

function finite(value, key, { positive = false, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (positive && value <= 0) ||
      (integer && !Number.isInteger(value))) {
    throw invalid(`Model report value ${key} is invalid`, "MODEL_REPORT_INVALID", { key });
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function studentTCritical95(degreesOfFreedom) {
  const table = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074];
  return table[degreesOfFreedom] ?? 2.069;
}

function invertMatrix(matrix) {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => [
    ...row,
    ...Array.from({ length: size }, (_, columnIndex) => rowIndex === columnIndex ? 1 : 0)
  ]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) {
      throw invalid("Participant and room observations require a full-rank factorial design", "MODEL_REPETITION_INVALID");
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    augmented[column] = augmented[column].map(value => value / divisor);
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      augmented[row] = augmented[row].map((value, index) => value - factor * augmented[column][index]);
    }
  }
  return augmented.map(row => row.slice(size));
}

function matrixVector(matrix, vector) {
  return matrix.map(row => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

function multivariableRegression(points, target) {
  const predictorCount = 3;
  const n = points.length;
  if (n <= predictorCount) {
    throw invalid("Model reports require repeated observations beyond the fitted parameters", "MODEL_REPETITION_INVALID");
  }
  const rows = points.map(point => [1, point.participants, point.rooms]);
  const xtx = Array.from({ length: predictorCount }, (_, row) =>
    Array.from({ length: predictorCount }, (_, column) =>
      rows.reduce((sum, values) => sum + values[row] * values[column], 0)));
  const inverse = invertMatrix(xtx);
  const xty = Array.from({ length: predictorCount }, (_, column) =>
    rows.reduce((sum, values, index) => sum + values[column] * points[index].y, 0));
  const coefficients = matrixVector(inverse, xty);
  if (coefficients[0] < -1e-8 || coefficients[1] <= 0 || coefficients[2] < -1e-8) {
    throw invalid("Observed resource trend must have non-negative fixed and room effects plus a positive participant effect", "MODEL_TREND_INVALID");
  }
  coefficients[0] = Math.max(0, coefficients[0]);
  coefficients[2] = Math.max(0, coefficients[2]);
  const fitted = rows.map(values => values.reduce((sum, value, index) => sum + value * coefficients[index], 0));
  const residuals = points.map((point, index) => point.y - fitted[index]);
  const degreesOfFreedom = n - predictorCount;
  const residualVariance = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const residualStandardError = Math.sqrt(residualVariance / degreesOfFreedom);
  if (!Number.isFinite(residualStandardError) || residualStandardError <= 0) {
    throw invalid("Repeated factorial cells require non-zero observed variance", "MODEL_VARIANCE_INSUFFICIENT");
  }
  const targetRow = [1, target.participants, target.rooms];
  const estimate = targetRow.reduce((sum, value, index) => sum + value * coefficients[index], 0);
  const leverage = targetRow.reduce((sum, value, row) =>
    sum + value * inverse[row].reduce((inner, coefficient, column) =>
      inner + coefficient * targetRow[column], 0), 0);
  const predictionStandardError = residualStandardError * Math.sqrt(1 + leverage);
  const margin = studentTCritical95(degreesOfFreedom) * predictionStandardError;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  const totalVariance = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  return {
    intercept: coefficients[0],
    slopePerParticipant: coefficients[1],
    slopePerRoom: coefficients[2],
    residualStandardError,
    rSquared: totalVariance > 0 ? Math.max(0, 1 - residualVariance / totalVariance) : 1,
    forecast: {
      low: Math.max(0, estimate - margin),
      base: estimate,
      high: estimate + margin
    }
  };
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeRegression(result) {
  return {
    intercept: round(result.intercept),
    slopePerParticipant: round(result.slopePerParticipant, 6),
    slopePerRoom: round(result.slopePerRoom, 6),
    residualStandardError: round(result.residualStandardError),
    rSquared: round(result.rSquared, 4),
    predictionInterval95: {
      low: round(result.forecast.low),
      base: round(result.forecast.base),
      high: round(result.forecast.high)
    }
  };
}

function validateCosts(costs, modelAtMs) {
  const observedAtMs = canonicalIso(costs?.observedAt);
  if (!exactKeys(costs, ["schemaVersion", "observedAt", "currency", "sources", "workerSkus", "loadBalancerMonthly", "blockStorageGiBMonthly", "haControlPlaneMonthly", "postgresMonthly", "excluded"]) ||
      costs.schemaVersion !== 1 || observedAtMs === null || observedAtMs > modelAtMs ||
      modelAtMs - observedAtMs > MAX_COST_CATALOGUE_AGE_DAYS * 24 * 60 * 60 * 1000 || costs.currency !== "USD" ||
      !Array.isArray(costs.sources) || costs.sources.length < 4 || !Array.isArray(costs.workerSkus) || costs.workerSkus.length !== 3 ||
      costs.sources.some(source => {
        try {
          const url = new URL(source);
          return url.protocol !== "https:" || !(url.hostname === "digitalocean.com" || url.hostname.endsWith(".digitalocean.com"));
        } catch {
          return true;
        }
      }) || !exactKeys(costs.postgresMonthly, ["oneGiB", "twoGiB", "fourGiB"]) ||
      [costs.loadBalancerMonthly, costs.blockStorageGiBMonthly, costs.haControlPlaneMonthly,
        costs.postgresMonthly?.oneGiB, costs.postgresMonthly?.twoGiB, costs.postgresMonthly?.fourGiB]
        .some(value => !Number.isFinite(value) || value <= 0) ||
      !Array.isArray(costs.excluded) || costs.excluded.some(item => typeof item !== "string" || item.length === 0)) {
    throw invalid("Cost catalogue schema is invalid", "COST_CATALOGUE_INVALID");
  }
  for (const sku of costs.workerSkus) {
    if (!exactKeys(sku, ["id", "cpuMillicores", "memoryMiB", "monthly"]) ||
        !/^[a-z0-9-]+$/.test(sku.id) || !Number.isFinite(sku.cpuMillicores) || !Number.isFinite(sku.memoryMiB) ||
        !Number.isFinite(sku.monthly) || sku.monthly <= 0) throw invalid("Worker SKU is invalid", "COST_CATALOGUE_INVALID");
  }
  return costs;
}

function topologyCosts({ costs, sku, sensitivity }) {
  const storageBase = 20 * costs.blockStorageGiBMonthly;
  const price = nodes => nodes * sku.monthly;
  const lowNodes = sensitivity[0.3].nodes.low;
  const baseNodes = sensitivity[0.3].nodes.base;
  const highNodes = sensitivity[0.3].nodes.high;
  const range = (low, base, high) => ({ low: round(low, 2), base: round(base, 2), high: round(high, 2) });
  return {
    currency: costs.currency,
    cadence: "monthly",
    catalogueObservedAt: costs.observedAt,
    catalogueMaximumAgeDays: MAX_COST_CATALOGUE_AGE_DAYS,
    workerSku: sku.id,
    topologies: {
      selfManagedSingleRegion: range(
        price(lowNodes) + costs.loadBalancerMonthly + storageBase,
        price(baseNodes) + costs.loadBalancerMonthly + storageBase,
        price(highNodes) + costs.loadBalancerMonthly + storageBase
      ),
      managedDatabaseSingleRegion: range(
        price(lowNodes) + costs.loadBalancerMonthly + storageBase + costs.postgresMonthly.oneGiB,
        price(baseNodes) + costs.loadBalancerMonthly + storageBase + costs.postgresMonthly.twoGiB,
        price(highNodes) + costs.loadBalancerMonthly + storageBase + costs.postgresMonthly.fourGiB
      ),
      haControlPlaneAndDatabase: range(
        price(Math.max(3, lowNodes)) + costs.loadBalancerMonthly + storageBase + costs.haControlPlaneMonthly + costs.postgresMonthly.twoGiB * 2,
        price(Math.max(3, baseNodes)) + costs.loadBalancerMonthly + storageBase + costs.haControlPlaneMonthly + costs.postgresMonthly.fourGiB * 2,
        price(Math.max(3, highNodes)) + costs.loadBalancerMonthly * 2 + storageBase * 5 + costs.haControlPlaneMonthly + costs.postgresMonthly.fourGiB * 3
      )
    },
    excluded: costs.excluded,
    sources: costs.sources
  };
}

export function buildCapacityModel({ scenario, input, botsPerRoom, costs, thresholds, allowTestTrust = false }) {
  if (!scenario || scenario.mode !== "model-only") {
    throw invalid("Capacity modelling requires the model-only scenario", "MODEL_SCENARIO_REQUIRED");
  }
  if (!input || !exactKeys(input, ["schemaVersion", "modelObservedAt", "assumptions", "bundles"]) || input.schemaVersion !== 3 ||
      canonicalIso(input.modelObservedAt) === null || !exactKeys(input.assumptions, ["operationalRoomsPerNodeCap", "headroomRatios"]) ||
      !Number.isInteger(input.assumptions.operationalRoomsPerNodeCap) || input.assumptions.operationalRoomsPerNodeCap < 1 ||
      input.assumptions.operationalRoomsPerNodeCap > 100 || canonicalJson(input.assumptions.headroomRatios) !== canonicalJson(HEADROOM_RATIOS) ||
      !Array.isArray(input.bundles) || input.bundles.length < 1 ||
      input.bundles.length > 24 || !thresholds) {
    throw invalid("Model input schema, sensitivity or repetition bounds are invalid", "MODEL_INPUT_INVALID");
  }
  if (!scenario.botVariants.includes(botsPerRoom)) throw invalid("Model bot variant is unsupported", "MODEL_INPUT_INVALID");
  const modelAtMs = Date.parse(input.modelObservedAt);
  const runIds = new Set();
  const loadGroups = new Map();
  const observations = [];
  let profiles = null;
  let environmentIdentity = null;
  const observedScenarioIds = new Map();

  for (const source of input.bundles) {
    if (!exactKeys(source, [
      "runId", "manifestSha256", "artifactSha256", "plan", "report", "environment",
      "executionConfig", "manifestSignerKeyId", "rawSignerKeyId"
    ]) || !/^[0-9a-f-]{36}$/i.test(source.runId) || !/^[0-9a-f]{64}$/.test(source.manifestSha256) ||
        !exactKeys(source.artifactSha256, ARTIFACT_NAMES) ||
        Object.values(source.artifactSha256).some(value => !/^[0-9a-f]{64}$/.test(value)) ||
        source[VERIFIED_BUNDLE] !== true || runIds.has(source.runId) ||
        typeof source.manifestSignerKeyId !== "string" || typeof source.rawSignerKeyId !== "string" ||
        (!allowTestTrust && (source.manifestSignerKeyId.startsWith("test-") || source.rawSignerKeyId.startsWith("test-")))) {
      throw invalid("Every model source must be one unique complete physical bundle", "MODEL_BUNDLE_INVALID");
    }
    validatePlan(source.plan, { productionOnly: !allowTestTrust });
    if (source.plan.run.id !== source.runId || source.plan.security.mode !== "attested-remote" ||
        source.report?.run?.driver?.name !== "yenhubs-playwright-capacity") {
      throw invalid("Model bundles must come from the checked-in staging Playwright driver", "MODEL_BUNDLE_IDENTITY_INVALID");
    }
    validateEnvironmentSnapshot(
      source.environment,
      source.report.collectorMapping?.sha256,
      source.report.run?.startedAt,
      { productionOnly: !allowTestTrust }
    );
    const sourceEnvironmentIdentity = {
      region: source.environment.region,
      nodePool: source.environment.nodePool,
      replicas: source.environment.replicas,
      deployment: source.environment.deployment
    };
    if (environmentIdentity && canonicalJson(environmentIdentity) !== canonicalJson(sourceEnvironmentIdentity)) {
      throw invalid("All model bundles must use one exact deployment and node topology", "MODEL_ENVIRONMENT_MISMATCH");
    }
    environmentIdentity ??= sourceEnvironmentIdentity;
    validateExecutionConfig(source.executionConfig, source.plan, source.executionConfig?.collectorEndpoint);
    validateReportIntegrity(source.report);
    const report = source.report;
    const endedAtMs = canonicalIso(report.run?.endedAt);
    if (source.runId !== report.run?.id || endedAtMs === null || endedAtMs > modelAtMs ||
        modelAtMs - endedAtMs > MAX_REPORT_AGE_DAYS * 24 * 60 * 60 * 1000 ||
        report.totals?.botsPerRoom !== botsPerRoom) {
      throw invalid("Model report is stale, rebound or for a different bot variant", "MODEL_REPORT_INVALID");
    }
    if (!profiles) profiles = { ...report.profiles };
    if (canonicalJson(profiles) !== canonicalJson(report.profiles)) {
      throw invalid("All repetitions must use the same client, audio and transport profile", "MODEL_PROFILE_MISMATCH");
    }
    const participants = finite(report.totals.participants, "participants", { positive: true, integer: true });
    const rooms = finite(report.totals.rooms, "rooms", { positive: true, integer: true });
    const observation = {
      runId: source.runId,
      sha256: source.manifestSha256,
      endedAt: report.run.endedAt,
      participants,
      rooms,
      nodeCpu: finite(report.modelObservations["model.nodeCpuMillicores"], "nodeCpu", { positive: true }),
      nodeMemory: finite(report.modelObservations["model.nodeMemoryMiB"], "nodeMemory", { positive: true }),
      usedCpu: finite(report.modelObservations["model.usedCpuMillicores"], "usedCpu", { positive: true }),
      usedMemory: finite(report.modelObservations["model.usedMemoryMiB"], "usedMemory", { positive: true })
    };
    const loadKey = `${participants}/${rooms}`;
    if (!loadGroups.has(loadKey)) loadGroups.set(loadKey, []);
    loadGroups.get(loadKey).push(observation);
    observations.push(observation);
    observedScenarioIds.set(source.plan.scenario.id, (observedScenarioIds.get(source.plan.scenario.id) ?? 0) + 1);
    runIds.add(source.runId);
  }
  const insufficiencyReasons = [];
  if (loadGroups.size < MINIMUM_DISTINCT_LOADS || [...loadGroups.values()].some(group => group.length < MINIMUM_REPETITIONS_PER_LOAD)) {
    insufficiencyReasons.push("three-distinct-loads-with-two-repetitions-required");
  }
  for (const scenarioId of REQUIRED_PHYSICAL_SCENARIOS) {
    if ((observedScenarioIds.get(scenarioId) ?? 0) < MINIMUM_REPETITIONS_PER_LOAD) {
      insufficiencyReasons.push(`missing-two-repetitions-${scenarioId}`);
    }
  }

  const participantLevelsByRoom = new Map();
  for (const observation of observations) {
    if (!participantLevelsByRoom.has(observation.rooms)) participantLevelsByRoom.set(observation.rooms, new Set());
    participantLevelsByRoom.get(observation.rooms).add(observation.participants);
  }
  const roomLevels = [...participantLevelsByRoom.keys()];
  const hasCrossedFactorialDesign = roomLevels.some((left, leftIndex) => roomLevels.slice(leftIndex + 1).some(right => {
    const rightParticipants = participantLevelsByRoom.get(right);
    return [...participantLevelsByRoom.get(left)].filter(value => rightParticipants.has(value)).length >= 2;
  }));
  if (!hasCrossedFactorialDesign) insufficiencyReasons.push("factorial-participant-room-design-required");

  const targetRooms = Math.ceil(scenario.totalParticipants / scenario.participantsPerRoom);
  const maximumObservedParticipants = Math.max(...observations.map(item => item.participants));
  const maximumObservedRooms = Math.max(...observations.map(item => item.rooms));
  const participantExtrapolationRatio = scenario.totalParticipants / maximumObservedParticipants;
  const roomExtrapolationRatio = targetRooms / maximumObservedRooms;
  if (participantExtrapolationRatio > MAX_EXTRAPOLATION_RATIO) {
    insufficiencyReasons.push(`participant-extrapolation-ratio-exceeds-${MAX_EXTRAPOLATION_RATIO}`);
  }
  if (roomExtrapolationRatio > MAX_EXTRAPOLATION_RATIO) {
    insufficiencyReasons.push(`room-extrapolation-ratio-exceeds-${MAX_EXTRAPOLATION_RATIO}`);
  }
  const physicalReadiness = trackedPhysicalReadinessSummary();
  if (physicalReadiness.state !== "READY") insufficiencyReasons.push("physical-evidence-readiness-blocked");
  if (physicalReadiness.observabilityContract.state !== "READY") {
    insufficiencyReasons.push("server-observability-contract-unavailable");
  }
  if (!physicalReadiness.coordination.databaseFencingPolicySha256) {
    insufficiencyReasons.push("reticulum-horizontal-scaling-requires-database-fenced-bot-runner-lease");
  }
  try {
    assertPhysicalExecutionReady();
  } catch (error) {
    if (["PHYSICAL_READINESS_BLOCKED", "PHYSICAL_READINESS_AUTHORIZATION_INVALID"].includes(error?.code)) {
      insufficiencyReasons.push("base-owned-physical-readiness-authorization-required");
    } else throw error;
  }

  let cpuFit;
  let memoryFit;
  try {
    cpuFit = multivariableRegression(
      observations.map(item => ({ participants: item.participants, rooms: item.rooms, y: item.usedCpu })),
      { participants: scenario.totalParticipants, rooms: targetRooms }
    );
    memoryFit = multivariableRegression(
      observations.map(item => ({ participants: item.participants, rooms: item.rooms, y: item.usedMemory })),
      { participants: scenario.totalParticipants, rooms: targetRooms }
    );
  } catch (error) {
    if (["MODEL_REPETITION_INVALID", "MODEL_TREND_INVALID", "MODEL_VARIANCE_INSUFFICIENT"].includes(error?.code)) {
      insufficiencyReasons.push(error.code.toLowerCase());
    } else throw error;
  }
  if (cpuFit && cpuFit.rSquared < MINIMUM_R_SQUARED) insufficiencyReasons.push("cpu-r-squared-below-0.8");
  if (memoryFit && memoryFit.rSquared < MINIMUM_R_SQUARED) insufficiencyReasons.push("memory-r-squared-below-0.8");
  const nodeCpu = median(observations.map(item => item.nodeCpu));
  const nodeMemory = median(observations.map(item => item.nodeMemory));
  const safeCosts = validateCosts(costs, modelAtMs);
  const observedSku = safeCosts.workerSkus.find(item => item.id === environmentIdentity?.nodePool?.sku);
  if (!observedSku || observations.some(item => item.nodeCpu !== observedSku.cpuMillicores ||
      item.nodeMemory !== observedSku.memoryMiB ||
      item.usedCpu > observedSku.cpuMillicores * environmentIdentity.nodePool.nodeCount ||
      item.usedMemory > observedSku.memoryMiB * environmentIdentity.nodePool.nodeCount)) {
    insufficiencyReasons.push("observed-resources-do-not-match-topology-sku-and-node-count");
  }
  if (insufficiencyReasons.length > 0 || !cpuFit || !memoryFit) {
    return {
      schemaVersion: 2,
      state: "INSUFFICIENT",
      certified: false,
      physicalExecutionAllowed: false,
      reasons: [...new Set(insufficiencyReasons)].sort(),
      evidencePolicy: {
        maximumAgeDays: MAX_REPORT_AGE_DAYS,
        minimumDistinctLoads: MINIMUM_DISTINCT_LOADS,
        minimumRepetitionsPerLoad: MINIMUM_REPETITIONS_PER_LOAD,
        requiredScenarioIds: [...REQUIRED_PHYSICAL_SCENARIOS],
        minimumRSquared: MINIMUM_R_SQUARED,
        requiredDesign: "crossed participants-by-rooms factorial",
        maximumExtrapolationRatio: MAX_EXTRAPOLATION_RATIO,
        observedMaximums: { participants: maximumObservedParticipants, rooms: maximumObservedRooms },
        targetRatios: {
          participants: round(participantExtrapolationRatio, 4),
          rooms: round(roomExtrapolationRatio, 4)
        },
        physicalReadinessState: physicalReadiness.state,
        observabilityReadinessState: physicalReadiness.observabilityContract.state,
        acceptedBundles: observations.length
      },
      note: "No capacity or cost projection is emitted until factorial evidence, bounded extrapolation and database-fenced Reticulum coordination all pass."
    };
  }
  const roomCount = targetRooms;
  const operationalCap = input.assumptions.operationalRoomsPerNodeCap;
  const sensitivity = {};
  for (const headroom of HEADROOM_RATIOS) {
    const cpuBudget = nodeCpu * (1 - headroom);
    const memoryBudget = nodeMemory * (1 - headroom);
    const nodes = level => Math.max(
      Math.ceil(cpuFit.forecast[level] / cpuBudget),
      Math.ceil(memoryFit.forecast[level] / memoryBudget),
      Math.ceil(roomCount / operationalCap)
    );
    sensitivity[headroom] = {
      headroomRatio: headroom,
      usableCpuMillicoresPerNode: round(cpuBudget),
      usableMemoryMiBPerNode: round(memoryBudget),
      nodes: { low: nodes("low"), base: nodes("base"), high: nodes("high") }
    };
  }
  // Pricing must use the exact SKU named by the signed environment. Choosing
  // the first shape large enough would make array order able to reprice an
  // otherwise identical topology.
  const sku = observedSku;
  const modelCore = {
    scenarioId: scenario.id,
    modelObservedAt: input.modelObservedAt,
    sourceBundles: observations.map(({ runId, sha256 }) => ({ runId, manifestSha256: sha256 })),
    botsPerRoom,
    profiles,
    operationalCap,
    environmentIdentity,
    cpuFit: safeRegression(cpuFit),
    memoryFit: safeRegression(memoryFit),
    sensitivity
  };

  return {
    schemaVersion: 2,
    state: "MODELLED",
    modelId: stableId("model", modelCore),
    certified: false,
    physicalExecutionAllowed: false,
    evidencePolicy: {
      maximumAgeDays: MAX_REPORT_AGE_DAYS,
      minimumDistinctLoads: MINIMUM_DISTINCT_LOADS,
      minimumRepetitionsPerLoad: MINIMUM_REPETITIONS_PER_LOAD,
      requiredScenarioIds: [...REQUIRED_PHYSICAL_SCENARIOS],
      minimumRSquared: MINIMUM_R_SQUARED,
      requiredDesign: "crossed participants-by-rooms factorial",
      maximumExtrapolationRatio: MAX_EXTRAPOLATION_RATIO,
      observedMaximums: { participants: maximumObservedParticipants, rooms: maximumObservedRooms },
      targetRatios: {
        participants: round(participantExtrapolationRatio, 4),
        rooms: round(roomExtrapolationRatio, 4)
      },
      physicalReadinessState: physicalReadiness.state,
      observabilityReadinessState: physicalReadiness.observabilityContract.state,
      acceptedBundles: observations.length,
      sourceBundles: observations.map(({ runId, sha256, endedAt, participants, rooms }) => ({
        runId,
        manifestSha256: sha256,
        endedAt,
        participants,
        rooms
      }))
    },
    profiles,
    environment: environmentIdentity,
    demand: {
      totalParticipants: scenario.totalParticipants,
      participantsPerRoom: scenario.participantsPerRoom,
      rooms: roomCount,
      botsPerRoom,
      totalBots: roomCount * botsPerRoom
    },
    fits: {
      cpuMillicores: safeRegression(cpuFit),
      memoryMiB: safeRegression(memoryFit),
      interval: "approximate analytical 95% prediction interval"
    },
    nodeBaseline: {
      medianCpuMillicores: round(nodeCpu),
      medianMemoryMiB: round(nodeMemory),
      operationalRoomsPerNodeCap: operationalCap
    },
    sensitivity,
    costs: topologyCosts({ costs: safeCosts, sku, sensitivity }),
    topologyUncertainty: [
      "Projection extrapolates beyond the measured range and is not a capacity promise.",
      "The regression models total CPU and memory only; database, TURN, Dialog, Reticulum, load-balancer and failure-domain limits remain separate gates.",
      "Direct and forced-TURN results, desktop and mobile results, and muted and active-audio results are not interchangeable.",
      "Operational rooms-per-node is an explicit sensitivity assumption, not an observed scheduler guarantee.",
      "Monthly costs exclude taxes, egress overages, snapshots, registry, observability, LLM usage and unlisted managed-service replicas.",
      "This command never creates or purchases infrastructure."
    ]
  };
}

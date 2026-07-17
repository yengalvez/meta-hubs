import { readFileSync } from "node:fs";
import { invalid } from "./errors.mjs";
import { canonicalJson } from "./io.mjs";
import { observabilityReadinessSummary } from "./observability-contract.mjs";

const TRACKED_READINESS = JSON.parse(readFileSync(new URL("../physical-readiness.json", import.meta.url), "utf8"));
const SHA_KEYS = /^[0-9a-f]{64}$/;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function checkedReadiness(value) {
  if (!exactKeys(value, [
    "schemaVersion", "state", "physicalExecutionAllowed", "certified", "observability",
    "collectorBoundary", "network", "generator", "coordination", "baseReview", "blockers"
  ]) || value.schemaVersion !== 1 || !["BLOCKED", "READY"].includes(value.state) ||
      value.certified !== false || !exactKeys(value.observability, [
        "producerManifestSha256", "ruleManifestSha256", "scrapeManifestSha256", "inventoryManifestSha256",
        "sourceTimestampProof", "counterResetPolicy", "runScopePolicy"
      ]) || !exactKeys(value.collectorBoundary, [
        "httpsDeploymentSha256", "tlsPolicySha256", "authenticationPolicySha256"
      ]) || !exactKeys(value.network, ["egressPolicySha256"]) || !exactKeys(value.generator, [
        "physicalHostIdentityPolicySha256", "processIsolationPolicySha256", "terminationVerificationPolicySha256"
      ]) || !exactKeys(value.coordination, [
        "reticulumReplicaLimit", "botRunnerLeaseScope", "databaseFencingPolicySha256"
      ]) || value.coordination.reticulumReplicaLimit !== 1 ||
      value.coordination.botRunnerLeaseScope !== "process-local" ||
      (value.coordination.databaseFencingPolicySha256 !== null &&
        !SHA_KEYS.test(value.coordination.databaseFencingPolicySha256)) ||
      !exactKeys(value.baseReview, ["baseOwnedPolicySha256", "reviewAttestationSha256"]) ||
      Object.values(value.baseReview).some(item => item !== null && !SHA_KEYS.test(item)) ||
      !Array.isArray(value.blockers) || new Set(value.blockers).size !== value.blockers.length ||
      canonicalJson(value.blockers) !== canonicalJson([...value.blockers].sort())) {
    throw invalid("Tracked physical readiness schema is invalid", "PHYSICAL_READINESS_INVALID");
  }
  const shaValues = [
    value.observability.producerManifestSha256,
    value.observability.ruleManifestSha256,
    value.observability.scrapeManifestSha256,
    value.observability.inventoryManifestSha256,
    value.collectorBoundary.httpsDeploymentSha256,
    value.collectorBoundary.tlsPolicySha256,
    value.collectorBoundary.authenticationPolicySha256,
    value.network.egressPolicySha256,
    value.generator.physicalHostIdentityPolicySha256,
    value.generator.processIsolationPolicySha256,
    value.generator.terminationVerificationPolicySha256,
    value.coordination.databaseFencingPolicySha256,
    value.baseReview.baseOwnedPolicySha256,
    value.baseReview.reviewAttestationSha256
  ];
  const policies = [
    value.observability.sourceTimestampProof,
    value.observability.counterResetPolicy,
    value.observability.runScopePolicy
  ];
  const ready = value.state === "READY";
  if (value.physicalExecutionAllowed !== ready ||
      (ready && (value.blockers.length !== 0 || shaValues.some(item => !SHA_KEYS.test(item)) ||
        policies.some(item => typeof item !== "string" || item.length < 8))) ||
      (!ready && (value.physicalExecutionAllowed !== false || value.blockers.length === 0))) {
    throw invalid("Tracked readiness cannot authorize incomplete physical execution", "PHYSICAL_READINESS_INVALID");
  }
  return structuredClone(value);
}

export function trackedPhysicalReadinessSummary() {
  const readiness = checkedReadiness(TRACKED_READINESS);
  const observability = observabilityReadinessSummary();
  return {
    ...readiness,
    observabilityContract: observability,
    missingPrerequisites: [
      ...readiness.blockers,
      ...observability.unavailableMetrics.map(metric => `metric-unavailable:${metric}`)
    ]
  };
}

export function assertPhysicalExecutionReady({
  allowTestReadiness = false,
  baseOwnedPolicySha256 = process.env.YENHUBS_CAPACITY_BASE_OWNED_POLICY_SHA256,
  reviewAttestationSha256 = process.env.YENHUBS_CAPACITY_REVIEW_ATTESTATION_SHA256
} = {}) {
  if (allowTestReadiness) return { ...trackedPhysicalReadinessSummary(), testBypass: true };
  const readiness = trackedPhysicalReadinessSummary();
  if (readiness.state !== "READY" || readiness.observabilityContract.state !== "READY") {
    throw invalid("Physical execution remains blocked until every reviewed readiness artifact exists", "PHYSICAL_READINESS_BLOCKED", {
      blockers: readiness.missingPrerequisites
    });
  }
  if (baseOwnedPolicySha256 !== readiness.baseReview.baseOwnedPolicySha256 ||
      reviewAttestationSha256 !== readiness.baseReview.reviewAttestationSha256) {
    throw invalid(
      "Candidate-controlled files cannot authorize execution without matching base-owned policy and review attestation identities",
      "PHYSICAL_READINESS_AUTHORIZATION_INVALID"
    );
  }
  return readiness;
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

export function validatePhysicalGeneratorInventory(inventory, {
  plan,
  run,
  expectedHostIds = plan?.executionTopology?.hosts?.map(host => host.id)
} = {}) {
  const observedAtMs = canonicalIso(inventory?.observedAt);
  const runEndedAtMs = canonicalIso(run?.endedAt);
  const plannedHostIds = plan?.executionTopology?.hosts?.map(host => host.id);
  if (!exactKeys(inventory, ["schemaVersion", "planId", "runId", "observedAt", "hosts"]) ||
      inventory.schemaVersion !== 1 || inventory.planId !== plan?.planId || inventory.runId !== plan?.run?.id ||
      run?.id !== plan?.run?.id || observedAtMs === null || runEndedAtMs === null ||
      observedAtMs < runEndedAtMs || observedAtMs > runEndedAtMs + 5 * 60 * 1000 ||
      !Array.isArray(plannedHostIds) || plannedHostIds.length === 0 ||
      !Array.isArray(expectedHostIds) || expectedHostIds.length === 0 ||
      new Set(expectedHostIds).size !== expectedHostIds.length ||
      canonicalJson(expectedHostIds) !== canonicalJson(plannedHostIds.filter(hostId => expectedHostIds.includes(hostId))) ||
      !Array.isArray(inventory.hosts) || inventory.hosts.length !== expectedHostIds.length) {
    throw invalid(
      "Physical generator inventory must be complete and bound to the signed plan/run",
      "PHYSICAL_HOST_IDENTITY_INVALID"
    );
  }
  const hosts = inventory.hosts;
  const machineIds = new Set();
  const bootIds = new Set();
  const hostIds = new Set();
  for (const host of hosts) {
    if (!exactKeys(host, [
      "hostId", "machineId", "bootId", "cgroupPath", "rootPid", "liveDescendantCountAfterStop",
      "liveBrowserCountAfterStop"
    ]) || !/^host-\d{3}$/.test(host.hostId) || !/^[a-z0-9][a-z0-9-]{7,127}$/.test(host.machineId) ||
        !/^[a-z0-9][a-z0-9-]{7,127}$/.test(host.bootId) || typeof host.cgroupPath !== "string" ||
        host.cgroupPath.length < 2 || host.cgroupPath.length > 512 || !host.cgroupPath.startsWith("/") ||
        host.cgroupPath.split("/").includes("..") || !host.cgroupPath.split("/").includes(inventory.runId) ||
        !Number.isInteger(host.rootPid) || host.rootPid < 1 ||
        host.liveDescendantCountAfterStop !== 0 || host.liveBrowserCountAfterStop !== 0 ||
        hostIds.has(host.hostId) || machineIds.has(host.machineId) || bootIds.has(host.bootId)) {
      throw invalid("Generator hosts must be unique physical machines with a zero-process termination proof", "PHYSICAL_HOST_IDENTITY_INVALID");
    }
    hostIds.add(host.hostId);
    machineIds.add(host.machineId);
    bootIds.add(host.bootId);
  }
  if (canonicalJson(hosts.map(host => host.hostId)) !== canonicalJson(expectedHostIds)) {
    throw invalid(
      "Physical generator inventory must cover every planned host in canonical order",
      "PHYSICAL_HOST_IDENTITY_INVALID"
    );
  }
  return structuredClone(inventory);
}

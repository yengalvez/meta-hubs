import { invalid } from "./errors.mjs";
import { validatePlan } from "./plan-contract.mjs";
import {
  validateCollectorEndpoint as validateBoundCollector,
  validateTarget
} from "./security.mjs";
import { assertPhysicalExecutionReady } from "./physical-readiness.mjs";

export { validateTarget };

function displayOrigin(origin) {
  return origin.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "");
}

export function executionAcknowledgement(plan, { productionOnly = false } = {}) {
  validatePlan(plan, { productionOnly });
  const targetHost = new URL(plan.targetTemplate.replaceAll("{room}", "room-001")).host;
  const origins = plan.security.allowedBrowserOrigins.map(displayOrigin).join(",");
  const binding = plan.security.mode === "loopback"
    ? "loopback"
    : `attestation=${plan.security.attestationSha256}`;
  return [
    "I ACKNOWLEDGE NON-PRODUCTION CAPACITY LOAD:",
    `plan=${plan.planId}`,
    `run=${plan.run.id}`,
    `issuedAt=${plan.run.issuedAt}`,
    `executionEnabled=${plan.run.executionEnabled}`,
    `scenario=${plan.scenario.id}`,
    `environment=${plan.environment?.sha256 ?? "none"}`,
    `target=${targetHost}`,
    `origins=${origins}`,
    binding,
    `participants=${plan.totals.participants}`,
    `bots=${plan.totals.bots}`
  ].join(" ");
}

export function validateCollectorEndpoint(endpoint, planOrBinding) {
  const binding = planOrBinding?.security ?? planOrBinding;
  if (!binding) throw invalid("Collector validation requires the plan security binding", "COLLECTOR_ENDPOINT_REQUIRED");
  return {
    canonical: validateBoundCollector(endpoint, binding),
    classification: binding.mode === "loopback" ? "local" : "attested-staging"
  };
}

export function assertExecutionSafety({ plan, acknowledgement, collectorEndpoint, allowTestTrust = false }) {
  const productionOnly = !allowTestTrust;
  validatePlan(plan, { requireExecutionEnabled: true, productionOnly });
  if (acknowledgement !== executionAcknowledgement(plan, { productionOnly })) {
    throw invalid("Execution requires the exact plan, host, origin and attestation acknowledgement", "EXECUTION_ACK_INVALID");
  }
  if (!collectorEndpoint) throw invalid("Execution requires a bounded server collector endpoint", "COLLECTOR_ENDPOINT_REQUIRED");
  const collector = validateCollectorEndpoint(collectorEndpoint, plan);
  const readiness = assertPhysicalExecutionReady({ allowTestReadiness: allowTestTrust });
  return {
    targetClassification: plan.targetClassification,
    collectorEndpoint: collector.canonical,
    acknowledgement: executionAcknowledgement(plan, { productionOnly }),
    planId: plan.planId,
    attestationSha256: plan.security.attestationSha256,
    physicalReadinessState: readiness.state,
    physicalExecutionAllowed: allowTestTrust ? false : readiness.physicalExecutionAllowed,
    certified: false
  };
}

#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  verifyBotOrchestratorDeployment
} from "../../deployment/verify-bot-orchestrator-deployment.mjs";
import {
  deploymentConfiguration,
  fixtureDeployment,
  omitKubernetesDefaults
} from "./bot-orchestrator-deployment-fixture.mjs";

const base = fixtureDeployment();
assert.equal(verifyBotOrchestratorDeployment(base, deploymentConfiguration).name, "bot-orchestrator");
assert.equal(
  verifyBotOrchestratorDeployment(omitKubernetesDefaults(base), deploymentConfiguration).name,
  "bot-orchestrator"
);

function fixtureForPhase(activationPhase, recoveryPhase) {
  const deployment = fixtureDeployment();
  deployment.metadata.annotations["yenhubs.org/runner-activation-phase"] = activationPhase;
  deployment.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] = recoveryPhase;
  deployment.spec.replicas = recoveryPhase === "restore-fence" || activationPhase === "bootstrap" ? 0 : 1;
  return {
    deployment,
    configuration: { ...deploymentConfiguration, activationPhase, recoveryPhase }
  };
}

for (const [activationPhase, recoveryPhase] of [
  ["bootstrap", "active"],
  ["admission", "active"],
  ["active", "restore-fence"]
]) {
  const fixture = fixtureForPhase(activationPhase, recoveryPhase);
  assert.equal(
    verifyBotOrchestratorDeployment(fixture.deployment, fixture.configuration).name,
    "bot-orchestrator"
  );
}

function rejected(mutator) {
  const candidate = structuredClone(base);
  mutator(candidate);
  assert.throws(() => verifyBotOrchestratorDeployment(candidate, deploymentConfiguration));
}

rejected(value => { value.spec.template.spec.containers[0].securityContext.privileged = true; });
rejected(value => { value.spec.template.spec.containers[0].securityContext.capabilities.add = ["SYS_ADMIN"]; });
rejected(value => { value.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: "configs" } }]; });
rejected(value => { value.spec.template.spec.containers[0].env.push({ name: "NODE_OPTIONS", value: "--require=/tmp/x" }); });
rejected(value => { value.spec.template.spec.hostPID = true; });
rejected(value => {
  const entry = value.spec.template.spec.containers[0].env.find(item => item.name === "OPENAI_API_KEY");
  delete entry.valueFrom;
  entry.value = "literal-must-be-rejected";
});
rejected(value => { value.spec.template.spec.containers[0].args = ["--unsafe"]; });
rejected(value => { value.metadata.annotations["yenhubs.org/runner-activation-phase"] = "admission"; });
rejected(value => { value.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] = "restore-fence"; });
rejected(value => { value.metadata.annotations["yenhubs.org/bot-runner-recovery-epoch"] = "55555555-5555-4555-8555-555555555555"; });
rejected(value => { value.spec.template.metadata.annotations["yenhubs.org/bot-runner-recovery-epoch"] = "55555555-5555-4555-8555-555555555555"; });
rejected(value => {
  value.spec.template.spec.containers[0].env.find(
    entry => entry.name === "RUNNER_CONTROL_URL"
  ).value = "http://bot-orchestrator:5001";
});
rejected(value => { value.spec.replicas = 0; });

process.stdout.write("Bot orchestrator Deployment verifier: 18/18 passed\n");

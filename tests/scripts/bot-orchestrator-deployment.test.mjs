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
const rawDeployment = structuredClone(base);
delete rawDeployment.apiVersion;
delete rawDeployment.kind;
const rawList = { apiVersion: "apps/v1", kind: "DeploymentList", items: [rawDeployment] };
assert.equal(verifyBotOrchestratorDeployment(rawList, deploymentConfiguration).name, "bot-orchestrator");
assert.throws(() => verifyBotOrchestratorDeployment(rawDeployment, deploymentConfiguration));
assert.throws(() => verifyBotOrchestratorDeployment({ ...rawList, items: [rawDeployment, rawDeployment] }, deploymentConfiguration));
assert.throws(() => verifyBotOrchestratorDeployment({ ...rawList, items: [rawDeployment, { ...rawDeployment, kind: "Pod" }] }, deploymentConfiguration));
assert.throws(() => verifyBotOrchestratorDeployment({ ...rawList, items: [{ ...rawDeployment, kind: "Pod" }] }, deploymentConfiguration));
assert.throws(() => verifyBotOrchestratorDeployment({ ...rawList, apiVersion: "v1", kind: "List" }, deploymentConfiguration));
const omittedEmptyEnv = structuredClone(base);
delete omittedEmptyEnv.spec.template.spec.containers[0].env.find(e => e.name === "RUNNER_BACKEND_CANARY_HUBS").value;
assert.equal(verifyBotOrchestratorDeployment(omittedEmptyEnv, deploymentConfiguration).name, "bot-orchestrator");
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
rejected(value => { delete value.spec.template.spec.containers[0].env.find(e => e.name === "OPENAI_MODEL").value; });
rejected(value => { delete value.metadata.annotations["yenhubs.org/runner-fence-protocol"]; });
rejected(value => { value.metadata.annotations["yenhubs.org/runner-fence-protocol"] = "other"; });
rejected(value => { delete value.spec.template.metadata.annotations["yenhubs.org/runner-fence-protocol"]; });
rejected(value => { value.spec.template.metadata.annotations["yenhubs.org/runner-fence-protocol"] = "other"; });

process.stdout.write("Bot orchestrator Deployment verifier: checks passed\n");

const baseOff = fixtureDeployment();
const offConfiguration = {...deploymentConfiguration,modules:{schema_version:1,bots:false,ai:false,avaturn:false}};
baseOff.spec.replicas=0;
for (const metadata of [baseOff.metadata,baseOff.spec.template.metadata]) {
  metadata.annotations["yenhubs.com/product-bots"]="false";
  metadata.annotations["yenhubs.com/product-ai"]="false";
}
baseOff.spec.template.spec.containers[0].env=baseOff.spec.template.spec.containers[0].env
  .filter(e=>e.name!=="OPENAI_API_KEY").map(e=>["YENHUBS_BOTS_ENABLED","YENHUBS_AI_ENABLED"].includes(e.name)?{name:e.name,value:"false"}:e);
assert.equal(verifyBotOrchestratorDeployment(baseOff,offConfiguration).name,"bot-orchestrator");
for(const mutate of [
  d=>d.spec.replicas=1,
  d=>d.spec.template.spec.containers[0].env.push({name:"OPENAI_API_KEY",valueFrom:{secretKeyRef:{name:"configs",key:"OPENAI_API_KEY"}}}),
  d=>d.spec.template.spec.containers[0].env.find(e=>e.name==="YENHUBS_BOTS_ENABLED").value=false,
  d=>delete d.metadata.annotations["yenhubs.com/product-bots"]
]) {const d=structuredClone(baseOff);mutate(d);assert.throws(()=>verifyBotOrchestratorDeployment(d,offConfiguration));}
const historical=fixtureDeployment();
for(const metadata of [historical.metadata,historical.spec.template.metadata])
  for(const key of Object.keys(metadata.annotations)) if(key.startsWith("yenhubs.com/product-")) delete metadata.annotations[key];
historical.spec.template.spec.containers[0].env=historical.spec.template.spec.containers[0].env.filter(e=>!e.name.startsWith("YENHUBS_"));
historical.spec.template.spec.containers[0].env.find(e=>e.name==="OPENAI_MODEL").value="gpt-5-nano";
assert.equal(verifyBotOrchestratorDeployment(historical,{...deploymentConfiguration,modulesExplicit:false}).name,"bot-orchestrator");
assert.throws(()=>verifyBotOrchestratorDeployment(historical,{...deploymentConfiguration,modulesExplicit:true}));
historical.spec.replicas=0;
assert.throws(()=>verifyBotOrchestratorDeployment(historical,{...deploymentConfiguration,modulesExplicit:false}));

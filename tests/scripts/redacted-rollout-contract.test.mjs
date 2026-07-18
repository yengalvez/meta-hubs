#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RedactedRolloutError,
  internals,
  parseDialogPublicKeySource,
  parseRsaJwkSource,
  parseStrictJsonSource,
  verifyReadyProcessLocalDeployments,
  verifyReleasedProcessLocalBaseline,
  verifyRedactedRollout
} from "../../deployment/redacted-rollout-contract.mjs";
import {
  applyProcessLocalRotationAnnotations,
  canonicalJson,
  createProcessLocalRotationBundle,
  loadProcessLocalRotationProfile,
  redactProcessLocalRotationBundle
} from "../../deployment/process-local-rotation.mjs";
import {
  canonicalOperationJson,
  initProcessLocalRotationOperation,
  loadVerifiedProcessLocalRotationIntent,
  sealProcessLocalRotationOperation
} from "../../deployment/process-local-rotation-operation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "deployment/verify-redacted-rollout.mjs");
const profile = loadProcessLocalRotationProfile();
const namespace = "hcce";
const revision = "aud065-redacted001";
const fingerprintKey = Buffer.alloc(32, 0x5a);
const operationToken = "aa".repeat(16);
const operationId = "bb".repeat(16);
const lockUid = "fixture-operation-lock-uid";
const oldValuesSourceFixture = Buffer.from("FIXTURE: old-source\n", "utf8");
const newValuesSourceFixture = Buffer.from("FIXTURE: new-source\n", "utf8");
const checkpoint = Object.freeze({
  stamp: "20260718-170405",
  dumpSha256: "6".repeat(64),
  storageSha256: "7".repeat(64),
  inventorySha256: "8".repeat(64)
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function resourceList(resources) {
  return { apiVersion: "v1", kind: "List", items: resources };
}

function sourceHashes({ original, quiesced, oldValues, newValues }) {
  return {
    originalBaselineSha256: sha256(artifact(resourceList(original))),
    quiescedBaselineSha256: sha256(artifact(resourceList(quiesced))),
    oldSnapshotSha256: sha256(artifact(oldValues)),
    newSnapshotSha256: sha256(artifact(newValues)),
    revisionSha256: sha256(artifact({ rotationRevision: revision }))
  };
}

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const key = createPublicKey(createPrivateKey(privateKey));
  const jwk = key.export({ format: "jwk" });
  return {
    snapshotPrivate: privateKey.replace(/\n/gu, "\\n"),
    publicPem: publicKey,
    jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    jwt: JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e })
  };
}

function runtimePrivateKey(snapshotPrivate) {
  return snapshotPrivate
    .replace(/\\+n/gu, "\n")
    .trim()
    .replace(/\n/gu, "\\\\n");
}

const oldKey = keyMaterial();
const newKey = keyMaterial();

const imageValueKeys = [...new Set(profile.image_pairs.map(pair => pair.value_key))];
const imageByValueKey = Object.fromEntries(imageValueKeys.map(valueKey => {
  const pair = profile.image_pairs.find(candidate => candidate.value_key === valueKey);
  return [valueKey, `${pair.repositories[0]}@sha256:${sha256(valueKey)}`];
}));

function snapshotSecrets(prefix, key) {
  const password = `${prefix}-database-password-with-sufficient-entropy`;
  return {
    ADM_EMAIL: "admin@example.invalid",
    BOT_ACCESS_KEY: `${prefix}-bot-secret-material-000000000000000001`,
    DB_HOST: "pgbouncer",
    DB_HOST_T: "pgbouncer-t",
    DB_NAME: "retdb",
    DB_PASS: password,
    DB_USER: "postgres",
    GUARDIAN_KEY: `${prefix}-guardian-secret-material-00000000000002`,
    HUB_DOMAIN: "example.invalid",
    NODE_COOKIE: `${prefix}-node-cookie-secret-material-000000000003`,
    OPENAI_API_KEY: `${prefix}-openai-secret-material-000000000000004`,
    PERMS_KEY: key.snapshotPrivate,
    PGRST_DB_URI: `postgres://postgres:${password}@pgbouncer:5432/retdb`,
    PHX_KEY: `${prefix}-phoenix-secret-material-00000000000000005`,
    PSQL: `postgres://postgres:${password}@pgsql:5432/retdb`,
    SKETCHFAB_API_KEY: `${prefix}-sketchfab-secret-material-000000000006`,
    SMTP_PASS: `${prefix}-smtp-secret-material-000000000000000007`,
    SMTP_PORT: "2525",
    SMTP_SERVER: "smtp.example.invalid",
    SMTP_USER: "mailer@example.invalid",
    TENOR_API_KEY: `${prefix}-tenor-secret-material-00000000000000008`
  };
}

const oldSecrets = snapshotSecrets("before", oldKey);
const newSecrets = snapshotSecrets("after", newKey);

function values(secrets) {
  return {
    Namespace: namespace,
    ...structuredClone(secrets),
    ...structuredClone(imageByValueKey)
  };
}

function liveOldSecretValues() {
  return {
    ...structuredClone(oldSecrets),
    PERMS_KEY: runtimePrivateKey(oldSecrets.PERMS_KEY),
    PGRST_JWT_SECRET: oldKey.jwt
  };
}

function databaseChecksum(secretValues) {
  return sha256(JSON.stringify({
    DB_USER: secretValues.DB_USER,
    DB_PASS: secretValues.DB_PASS,
    DB_NAME: secretValues.DB_NAME,
    DB_HOST: secretValues.DB_HOST,
    DB_HOST_T: secretValues.DB_HOST_T,
    PGRST_DB_URI: secretValues.PGRST_DB_URI,
    PSQL: secretValues.PSQL
  }));
}

let resourceVersion = 100;

function metadata(kind, name, namespaceValue = namespace) {
  resourceVersion += 1;
  return {
    name,
    ...(namespaceValue ? { namespace: namespaceValue } : {}),
    uid: `uid-${kind.toLowerCase()}-${name}`,
    resourceVersion: String(resourceVersion)
  };
}

function deployment(name) {
  const pairs = profile.image_pairs.filter(pair => pair.deployment === name);
  const containers = pairs.map(pair => {
    const bindings = profile.secret_env_bindings.filter(binding =>
      binding.deployment === name && binding.container === pair.container
    );
    const env = bindings.map(binding => ({
      name: binding.env,
      valueFrom: { secretKeyRef: { name: "configs", key: binding.key } }
    }));
    if (name === "bot-orchestrator" && pair.container === "bot-orchestrator") {
      env.push(
        { name: "RUNNER_AUTOSTART", value: "true" },
        { name: "RUNNER_BACKEND", value: "ghost" }
      );
    }
    return {
      name: pair.container,
      image: imageByValueKey[pair.value_key],
      ...(env.length > 0 ? { env } : {})
    };
  });
  const annotations = { "fixture.invalid/stable": "true" };
  if (profile.db_checksum_deployments.includes(name)) {
    annotations[profile.annotations.database_checksum] = databaseChecksum(oldSecrets);
  }
  if (profile.bot_access_checksum_deployments.includes(name)) {
    annotations[profile.annotations.bot_access_key_checksum] = sha256(oldSecrets.BOT_ACCESS_KEY);
  }
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      ...metadata("deployment", name),
      labels: { "fixture.invalid/name": name }
    },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name }, annotations },
        spec: { automountServiceAccountToken: false, containers }
      }
    },
    status: { observedGeneration: 7 }
  };
}

function retConfigText() {
  return Object.entries(profile.ret_config_placeholder_counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, count]) => Array.from(
      { length: count },
      (_unused, index) => `${name.toLowerCase()}_${index}=<${name}>`
    ))
    .join("\n") + "\n";
}

function identityKey(resource) {
  return [
    resource.apiVersion,
    resource.kind,
    resource.metadata.namespace || "",
    resource.metadata.name
  ].join("\0");
}

function completeHistoricalInventory(resources) {
  const existing = new Set(resources.map(identityKey));
  for (const item of profile.baseline_resource_identities) {
    const namespaceValue = item.namespace === "$Namespace" ? namespace : null;
    const name = item.name === "$Namespace" ? namespace : item.name;
    const resource = {
      apiVersion: item.apiVersion,
      kind: item.kind,
      metadata: metadata(item.kind, name, namespaceValue)
    };
    if (!existing.has(identityKey(resource))) resources.push(resource);
  }
  return resources;
}

function pgsqlNormalSpec() {
  return {
    podSelector: { matchLabels: { app: "pgsql" } },
    policyTypes: ["Ingress"],
    ingress: [{
      from: [
        { podSelector: { matchLabels: { app: "pgbouncer" } } },
        { podSelector: { matchLabels: { app: "pgbouncer-t" } } }
      ],
      ports: [{ protocol: "TCP", port: 5432 }]
    }]
  };
}

function pgsqlClosedSpec() {
  return {
    podSelector: { matchLabels: { app: "pgsql" } },
    policyTypes: ["Ingress"],
    ingress: []
  };
}

function originalBaselineResources() {
  resourceVersion = 100;
  const resources = completeHistoricalInventory([
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: metadata("namespace", namespace, null)
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata("secret", "configs"),
      type: "Opaque",
      stringData: liveOldSecretValues()
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata("configmap", "ret-config"),
      data: { [profile.ret_config_data_key]: retConfigText() }
    },
    ...profile.required_deployments.map(deployment)
  ]);
  const pgsqlIngress = find(resources, "NetworkPolicy", "pgsql-ingress");
  pgsqlIngress.metadata.labels = { "fixture.invalid/policy": "pgsql-ingress" };
  pgsqlIngress.metadata.annotations = { "fixture.invalid/owner": "yenhubs" };
  pgsqlIngress.spec = pgsqlNormalSpec();
  return resources;
}

function quiescedBaselineResources(original, operationIntent) {
  const quiesced = structuredClone(original);
  profile.rotation_revision_deployments.forEach((name, index) => {
    const item = find(quiesced, "Deployment", name);
    item.spec.replicas = 0;
    item.metadata.resourceVersion = String(5000 + index);
    item.metadata.generation = 8;
    item.status = { observedGeneration: 8, replicas: 0 };
  });
  const policy = find(quiesced, "NetworkPolicy", "pgsql-ingress");
  policy.metadata.resourceVersion = "4990";
  policy.metadata.annotations = {
    ...policy.metadata.annotations,
    "yenhubs.org/aud065-pgsql-lock-uid": lockUid,
    "yenhubs.org/aud065-pgsql-operation-token": operationIntent.operationToken,
    "yenhubs.org/aud065-pgsql-operation-binding-sha256":
      operationIntent.operationBindingSha256,
    "yenhubs.org/aud065-pgsql-barrier-state": "closed",
    "yenhubs.org/aud065-pgsql-normal-spec-sha256": sha256(Buffer.from(
      canonicalJson(pgsqlNormalSpec()), "utf8"
    ))
  };
  policy.spec = pgsqlClosedSpec();
  return quiesced;
}

function find(resources, kind, name) {
  return resources.find(resource =>
    resource.kind === kind && resource.metadata.name === name
  );
}

function apiSecret(resource, resourceVersionValue) {
  const secretValues = resource.stringData || Object.fromEntries(
    Object.entries(resource.data).map(([name, value]) => [
      name,
      Buffer.from(value, "base64").toString("utf8")
    ])
  );
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { ...structuredClone(resource.metadata), resourceVersion: resourceVersionValue },
    type: "Opaque",
    data: Object.fromEntries(Object.entries(secretValues).map(([name, value]) => [
      name,
      Buffer.from(value, "utf8").toString("base64")
    ]))
  };
}

function restartContract(original, quiesced) {
  return {
    schemaVersion: 1,
    profileId: profile.profile_id,
    runnerMode: "process-local",
    namespace,
    restorationPhase: "verified-callbacks-only",
    bundleRestoresReplicas: false,
    deployments: profile.rotation_revision_deployments.map(name => {
      const originalDeployment = find(original, "Deployment", name);
      const quiescedDeployment = find(quiesced, "Deployment", name);
      return {
        name,
        uid: originalDeployment.metadata.uid,
        originalReplicas: originalDeployment.spec.replicas,
        originalResourceVersion: originalDeployment.metadata.resourceVersion,
        quiescedResourceVersion: quiescedDeployment.metadata.resourceVersion
      };
    })
  };
}

function buildOperationIntent({ original, oldValues, newValues }) {
  const body = {
    schemaVersion: 1,
    contractId: "yenhubs-aud065-process-local-operation-intent-v1",
    operationToken,
    operationId,
    rotationRevision: revision,
    expectedKubeContext: "fixture-context",
    namespaceName: namespace,
    namespaceUid: find(original, "Namespace", namespace).metadata.uid,
    retPvcName: "ret-pvc",
    retPvcUid: "fixture-ret-pvc-uid",
    checkpointStamp: checkpoint.stamp,
    checkpointDumpSha256: checkpoint.dumpSha256,
    checkpointStorageSha256: checkpoint.storageSha256,
    checkpointInventorySha256: checkpoint.inventorySha256,
    profileId: profile.profile_id,
    profileSha256: sha256(Buffer.from(canonicalJson(profile), "utf8")),
    originalBaselineSha256: sha256(artifact(resourceList(original))),
    oldSnapshotSha256: sha256(artifact(oldValues)),
    newSnapshotSha256: sha256(artifact(newValues)),
    oldValuesSourceSha256: sha256(oldValuesSourceFixture),
    newValuesSourceSha256: sha256(newValuesSourceFixture)
  };
  const operationBindingSha256 = sha256(Buffer.from(
    canonicalOperationJson(body), "utf8"
  ));
  const authenticated = { ...body, operationBindingSha256 };
  return {
    ...authenticated,
    hmacSha256: createHmac("sha256", fingerprintKey)
      .update(canonicalOperationJson(authenticated), "utf8")
      .digest("hex")
  };
}

function applyAttestation(baseline, bundle) {
  return {
    allConsumersQuiesced: true,
    bundleRestoresReplicas: false,
    deployments: profile.rotation_revision_deployments.map(name => {
      const projected = applyProcessLocalRotationAnnotations({
        deployment: find(baseline, "Deployment", name),
        bundle,
        profile
      });
      assert.equal(projected.spec.replicas, 0);
      return {
        name,
        uidBound: true,
        resourceVersionBound: true,
        replicas: 0,
        annotationKeys: Object.keys(
          bundle.contract.desiredDeploymentAnnotations[name]
        ).sort()
      };
    })
  };
}

function buildBundleBinding({
  original,
  baseline,
  oldValues,
  newValues,
  bundle,
  restart,
  operationIntent
}) {
  const applied = applyAttestation(baseline, bundle);
  const redacted = {
    ...redactProcessLocalRotationBundle({
      baselineResources: baseline,
      oldValues,
      newValues,
      rotationRevision: revision,
      bundle,
      fingerprintKey,
      profile
    }),
    applyAttestation: applied,
    restartCallbacks: {
      artifact: "restart-contract.json",
      restorationPhase: restart.restorationPhase,
      deploymentCount: restart.deployments.length
    }
  };
  const bundleBody = artifact(bundle);
  const redactedBody = artifact(redacted);
  const restartBody = artifact(restart);
  const body = {
    schemaVersion: 1,
    contractId: "yenhubs-aud065-offline-bundle-v1",
    profileId: profile.profile_id,
    rotationRevision: revision,
    namespace,
    operationBindingSha256: operationIntent.operationBindingSha256,
    inputs: sourceHashes({ original, quiesced: baseline, oldValues, newValues }),
    files: {
      bundle: { name: "bundle.json", size: bundleBody.length, sha256: sha256(bundleBody) },
      redacted: {
        name: "redacted.json",
        size: redactedBody.length,
        sha256: sha256(redactedBody)
      },
      restart: {
        name: "restart-contract.json",
        size: restartBody.length,
        sha256: sha256(restartBody)
      }
    },
    externalOperationKey: { size: fingerprintKey.length, hmacBound: true },
    profileSha256: sha256(Buffer.from(canonicalJson(profile), "utf8")),
    liveResourceBindingsSha256: sha256(Buffer.from(
      canonicalJson(bundle.contract.liveResourceBindings), "utf8"
    )),
    applyAttestationSha256: sha256(Buffer.from(canonicalJson(applied), "utf8")),
    retConfigDataSha256: bundle.contract.retConfigBinding.dataSha256
  };
  return {
    ...body,
    hmacSha256: createHmac("sha256", fingerprintKey)
      .update(canonicalJson(body), "utf8")
      .digest("hex")
  };
}

function finalResources(baseline, casResponses, bundle, operationIntent) {
  const final = structuredClone(baseline);
  const secretIndex = final.findIndex(resource =>
    resource.kind === "Secret" && resource.metadata.name === "configs"
  );
  final[secretIndex] = apiSecret(find(bundle.resources, "Secret", "configs"), "9001");
  profile.rotation_revision_deployments.forEach((name, index) => {
    const replacement = structuredClone(find(casResponses, "Deployment", name));
    replacement.spec.replicas = 1;
    replacement.metadata.resourceVersion = String(9950 + index);
    replacement.status = { observedGeneration: 8, readyReplicas: 1 };
    const target = final.findIndex(resource =>
      resource.kind === "Deployment" && resource.metadata.name === name
    );
    final[target] = replacement;
  });
  const pgsqlIngress = find(final, "NetworkPolicy", "pgsql-ingress");
  pgsqlIngress.metadata.resourceVersion = "9990";
  pgsqlIngress.metadata.annotations = {
    ...pgsqlIngress.metadata.annotations,
    "yenhubs.org/aud065-pgsql-lock-uid": lockUid,
    "yenhubs.org/aud065-pgsql-operation-token": operationIntent.operationToken,
    "yenhubs.org/aud065-pgsql-operation-binding-sha256":
      operationIntent.operationBindingSha256,
    "yenhubs.org/aud065-pgsql-barrier-state": "open-verified",
    "yenhubs.org/aud065-pgsql-normal-spec-sha256": sha256(Buffer.from(
      canonicalJson(pgsqlNormalSpec()), "utf8"
    ))
  };
  pgsqlIngress.spec = pgsqlNormalSpec();
  return final;
}

function releasedBaselineFrom(input) {
  const releasedResources = structuredClone(input.finalResources);
  const policy = find(releasedResources, "NetworkPolicy", "pgsql-ingress");
  for (const marker of [
    "yenhubs.org/aud065-pgsql-lock-uid",
    "yenhubs.org/aud065-pgsql-operation-token",
    "yenhubs.org/aud065-pgsql-operation-binding-sha256",
    "yenhubs.org/aud065-pgsql-barrier-state",
    "yenhubs.org/aud065-pgsql-normal-spec-sha256"
  ]) {
    delete policy.metadata.annotations[marker];
  }
  policy.metadata.resourceVersion = "10001";
  return {
    verifiedResources: input.finalResources,
    releasedResources,
    namespace,
    initialPolicyResourceVersion: find(
      input.originalBaselineResources,
      "NetworkPolicy",
      "pgsql-ingress"
    ).metadata.resourceVersion
  };
}

function readyLiveReleaseFrom(input) {
  const released = releasedBaselineFrom(input);
  released.releasedResources = structuredClone(released.releasedResources);
  profile.required_deployments.forEach((name, index) => {
    const item = find(released.releasedResources, "Deployment", name);
    item.metadata.generation = 50 + index;
    item.status = {
      observedGeneration: item.metadata.generation,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1
    };
  });
  return released;
}

function installLiveKubectlFixture(directory, resources) {
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin, { mode: 0o700 });
  const resourcesPath = privateFile(
    directory,
    "live-resources.json",
    `${JSON.stringify(resources)}\n`
  );
  const logPath = path.join(directory, "kubectl.log");
  const kubectl = path.join(bin, "kubectl");
  fs.writeFileSync(kubectl, `#!${process.execPath}
import fs from "node:fs";
const types = {
  "v1\\u0000Namespace": "namespace",
  "v1\\u0000Secret": "secret",
  "networking.k8s.io/v1\\u0000Ingress": "ingress.networking.k8s.io",
  "v1\\u0000ConfigMap": "configmap",
  "apps/v1\\u0000Deployment": "deployment.apps",
  "v1\\u0000Service": "service",
  "v1\\u0000ServiceAccount": "serviceaccount",
  "rbac.authorization.k8s.io/v1\\u0000ClusterRole": "clusterrole.rbac.authorization.k8s.io",
  "rbac.authorization.k8s.io/v1\\u0000ClusterRoleBinding": "clusterrolebinding.rbac.authorization.k8s.io",
  "networking.k8s.io/v1\\u0000NetworkPolicy": "networkpolicy.networking.k8s.io"
};
const args = process.argv.slice(2);
const get = args.indexOf("get");
if (get < 0 || args[0] !== "--context" || args[2] !== "--request-timeout=45s") process.exit(90);
const type = args[get + 1];
const name = args[get + 2];
const namespaceIndex = args.indexOf("-n");
const namespace = namespaceIndex < 0 ? null : args[namespaceIndex + 1];
const resources = JSON.parse(fs.readFileSync(process.env.AUD065_LIVE_FIXTURE, "utf8"));
const matches = resources.filter(resource =>
  types[resource.apiVersion + "\\u0000" + resource.kind] === type &&
  resource.metadata.name === name &&
  (resource.metadata.namespace ?? null) === namespace
);
fs.appendFileSync(process.env.AUD065_KUBECTL_LOG,
  ["get", type, name, namespace ?? "cluster"].join(":") + "\\n");
if (matches.length !== 1) process.exit(91);
process.stdout.write(JSON.stringify(matches[0]));
`, { mode: 0o700 });
  fs.chmodSync(kubectl, 0o700);
  return { bin, resourcesPath, logPath };
}

function operationalAttestation(bundleBinding, operationIntent) {
  return {
    schemaVersion: 1,
    expectedKubeContext: operationIntent.expectedKubeContext,
    namespaceName: operationIntent.namespaceName,
    namespaceUid: operationIntent.namespaceUid,
    retPvcName: operationIntent.retPvcName,
    retPvcUid: operationIntent.retPvcUid,
    checkpointStamp: operationIntent.checkpointStamp,
    checkpointDumpSha256: operationIntent.checkpointDumpSha256,
    checkpointStorageSha256: operationIntent.checkpointStorageSha256,
    checkpointInventorySha256: operationIntent.checkpointInventorySha256,
    lockName: "yenhubs-recovery-operation-lock",
    lockUid,
    operationId: operationIntent.operationId,
    authenticatedContractState: "bundle-and-barrier-authenticated",
    operationBindingSha256: operationIntent.operationBindingSha256,
    bundleBindingHmacSha256: bundleBinding.hmacSha256
  };
}

function buildFixture({ serverMetadataChurn = false } = {}) {
  const original = originalBaselineResources();
  const oldValues = values(oldSecrets);
  const newValues = values(newSecrets);
  const operationIntent = buildOperationIntent({ original, oldValues, newValues });
  const baseline = quiescedBaselineResources(original, operationIntent);
  if (serverMetadataChurn) {
    const policy = find(baseline, "NetworkPolicy", "pgsql-ingress");
    policy.metadata.generation = 17;
    policy.metadata.managedFields = [{ manager: "fixture-cni" }];
    policy.status = { observedGeneration: 17 };
    const service = find(baseline, "Service", "ret");
    service.metadata.resourceVersion = "server-churn-quiesced";
    service.metadata.generation = 19;
    service.metadata.managedFields = [{ manager: "fixture-controller" }];
    service.status = { loadBalancer: {} };
  }
  const bundle = createProcessLocalRotationBundle({
    baselineResources: baseline,
    oldValues,
    newValues,
    rotationRevision: revision,
    profile
  });
  const casResponses = [apiSecret(find(bundle.resources, "Secret", "configs"), "9001")];
  profile.rotation_revision_deployments.forEach((name, index) => {
    const projected = applyProcessLocalRotationAnnotations({
      deployment: find(baseline, "Deployment", name),
      bundle,
      profile
    });
    projected.metadata.resourceVersion = String(9100 + index);
    casResponses.push(projected);
  });
  const restart = restartContract(original, baseline);
  const binding = buildBundleBinding({
    original,
    baseline,
    oldValues,
    newValues,
    bundle,
    restart,
    operationIntent
  });
  const final = finalResources(baseline, casResponses, bundle, operationIntent);
  if (serverMetadataChurn) {
    const policy = find(final, "NetworkPolicy", "pgsql-ingress");
    policy.metadata.generation = 18;
    policy.metadata.managedFields = [{ manager: "fixture-cni-final" }];
    policy.status = { observedGeneration: 18 };
    const service = find(final, "Service", "ret");
    service.metadata.resourceVersion = "server-churn-final";
    service.metadata.generation = 20;
    service.metadata.managedFields = [{ manager: "fixture-controller-final" }];
    service.status = { loadBalancer: {} };
  }
  return {
    originalBaselineResources: original,
    baselineResources: baseline,
    oldValues,
    newValues,
    bundle,
    bundleBinding: binding,
    operationIntent,
    restartContract: restart,
    casResponseResources: casResponses,
    finalResources: final,
    operationalAttestation: operationalAttestation(binding, operationIntent),
    reticulumRuntimeJwkSource: JSON.stringify(newKey.jwk),
    dialogRuntimePublicKeySource: newKey.publicPem,
    fingerprintKey: Buffer.from(fingerprintKey)
  };
}

function expectCode(input, code) {
  assert.throws(
    () => verifyRedactedRollout(input),
    error => error instanceof RedactedRolloutError && error.code === code
  );
}

test("42 final resources, one Secret, twelve Deployments and seven CAS responses pass", () => {
  const report = verifyRedactedRollout(buildFixture());
  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.inventories, {
    original_baseline_resources: 42,
    baseline_resources: 42,
    intermediate_cas_resources: 7,
    final_resources: 42,
    final_secrets: 1,
    final_deployments: 12,
    exact: true
  });
  assert.equal(report.secret.keys.length, 22);
  assert.equal(report.secret.opaque, true);
  assert.equal(report.secret.mutable, true);
  assert.equal(report.intermediate_cas_deployments.length, 6);
  assert.equal(report.deployments.length, 12);
  assert.equal(report.deployments.every(item => item.replicas_restored), true);
  assert.equal(report.placeholder_config_map.bytes_invariant, true);
  assert.equal(report.operational_attestation.bundle_binding_bound, true);
  assert.equal(report.operation_intent.canonical_sources_bound, true);
  assert.equal(report.pgsql_barrier.state_open_verified, true);
  assert.equal(report.perms_key.four_way_spki_match, true);
});

test("server metadata and status may churn while desired resources stay exact", () => {
  const report = verifyRedactedRollout(buildFixture({ serverMetadataChurn: true }));
  assert.equal(report.verdict, "pass");
  assert.equal(report.pgsql_barrier.user_metadata_exact, true);
});

test("report is redacted and contains only operation-local HMACs", () => {
  const input = buildFixture();
  const report = verifyRedactedRollout(input);
  const serialized = JSON.stringify(report);
  const forbidden = [
    ...Object.values(oldSecrets),
    ...Object.values(newSecrets),
    ...Object.values(imageByValueKey),
    oldKey.publicPem,
    newKey.publicPem,
    oldKey.jwk.n,
    newKey.jwk.n,
    input.operationalAttestation.namespaceUid,
    input.operationalAttestation.retPvcUid,
    input.operationalAttestation.lockUid,
    input.operationalAttestation.operationId,
    input.operationalAttestation.operationBindingSha256,
    input.bundleBinding.hmacSha256,
    ...input.bundle.contract.liveResourceBindings.flatMap(binding => [
      binding.uid,
      binding.resourceVersion
    ])
  ];
  forbidden
    .filter(value => String(value).length >= 16)
    .forEach(value => assert.equal(serialized.includes(String(value)), false, String(value)));
  assert.doesNotMatch(serialized, /yenhubs\.org\//u);
  const hmacs = [
    report.canonical_profile.hmac,
    report.canonical_bundle.hmac,
    report.placeholder_config_map.hmac,
    report.perms_key.hmac,
    report.operational_attestation.hmac,
    ...report.secret.keys.map(item => item.hmac)
  ];
  assert.equal(hmacs.every(value => HEX_SHA256.test(value)), true);
});

const HEX_SHA256 = /^[a-f0-9]{64}$/u;

test("baseline and final inventories are exact, duplicate-free 42-resource sets", () => {
  const missingBaseline = buildFixture();
  missingBaseline.baselineResources.pop();
  expectCode(missingBaseline, "canonical_baseline_resource_inventory_invalid");

  const missingFinal = buildFixture();
  missingFinal.finalResources.pop();
  expectCode(missingFinal, "final_inventory_invalid_mismatch");

  const duplicateFinal = buildFixture();
  duplicateFinal.finalResources.push(structuredClone(duplicateFinal.finalResources[0]));
  expectCode(duplicateFinal, "final_inventory_invalid_duplicate");
});

test("intermediate CAS inventory remains exactly Secret plus six quiesced Deployments", () => {
  const missing = buildFixture();
  missing.casResponseResources = missing.casResponseResources.filter(resource =>
    resource.metadata.name !== "dialog"
  );
  expectCode(missing, "cas_response_inventory_mismatch");

  const running = buildFixture();
  find(running.casResponseResources, "Deployment", "dialog").spec.replicas = 1;
  expectCode(running, "cas_deployment_not_quiesced");

  const extra = buildFixture();
  extra.casResponseResources.push(structuredClone(extra.casResponseResources[0]));
  expectCode(extra, "cas_response_inventory_invalid_duplicate");
});

test("all intermediate identities retain UID and advance resourceVersion", () => {
  const changedUid = buildFixture();
  find(changedUid.casResponseResources, "Secret", "configs").metadata.uid = "replacement-uid";
  expectCode(changedUid, "cas_resource_uid_mismatch");

  const stale = buildFixture();
  const secret = find(stale.casResponseResources, "Secret", "configs");
  secret.metadata.resourceVersion = stale.bundle.contract.liveResourceBindings.find(binding =>
    binding.kind === "Secret" && binding.name === "configs"
  ).resourceVersion;
  expectCode(stale, "cas_resource_version_not_advanced");
});

test("final Secret is exact Opaque, mutable, data-only and metadata-clean", () => {
  const missing = buildFixture();
  delete find(missing.finalResources, "Secret", "configs").data.DB_PASS;
  expectCode(missing, "final_secret_keyset_invalid");

  const wrongType = buildFixture();
  find(wrongType.finalResources, "Secret", "configs").type = "kubernetes.io/basic-auth";
  expectCode(wrongType, "final_secret_mutability_invalid");

  const immutable = buildFixture();
  find(immutable.finalResources, "Secret", "configs").immutable = true;
  expectCode(immutable, "final_secret_mutability_invalid");

  const staleMetadata = buildFixture();
  find(staleMetadata.finalResources, "Secret", "configs").metadata.managedFields = [];
  expectCode(staleMetadata, "final_secret_metadata_invalid");

  const lastApplied = buildFixture();
  find(lastApplied.finalResources, "Secret", "configs").metadata.annotations = {
    "kubectl.kubernetes.io/last-applied-configuration": "{}"
  };
  expectCode(lastApplied, "final_secret_metadata_invalid");

  const replacedAfterCas = buildFixture();
  find(replacedAfterCas.finalResources, "Secret", "configs").metadata.resourceVersion = "9999";
  expectCode(replacedAfterCas, "final_secret_resource_version_mismatch");
});

test("all twelve final Deployments restore exact replicas, specs, images and annotations", () => {
  const stillQuiesced = buildFixture();
  find(stillQuiesced.finalResources, "Deployment", "dialog").spec.replicas = 0;
  expectCode(stillQuiesced, "final_deployment_replicas_invalid");

  const podDrift = buildFixture();
  find(podDrift.finalResources, "Deployment", "coturn")
    .spec.template.spec.hostNetwork = true;
  expectCode(podDrift, "final_deployment_spec_mismatch");

  const nonTargetImage = buildFixture();
  find(nonTargetImage.finalResources, "Deployment", "hubs")
    .spec.template.spec.containers[0].image =
      `ghcr.io/yengalvez/hubs@sha256:${"f".repeat(64)}`;
  expectCode(nonTargetImage, "final_deployment_spec_mismatch");

  const metadataDrift = buildFixture();
  find(metadataDrift.finalResources, "Deployment", "reticulum")
    .metadata.labels["fixture.invalid/drift"] = "true";
  expectCode(metadataDrift, "final_deployment_metadata_mismatch");
});

test("restart artifact binds the six exact UIDs, replicas and resourceVersions", () => {
  const extra = buildFixture();
  extra.restartContract.deployments.push(structuredClone(extra.restartContract.deployments[0]));
  expectCode(extra, "restart_contract_invalid");

  const wrongUid = buildFixture();
  wrongUid.restartContract.deployments[0].uid = "foreign-uid";
  expectCode(wrongUid, "restart_contract_deployment_invalid");

  const wrongReplicas = buildFixture();
  wrongReplicas.restartContract.deployments[0].originalReplicas = 2;
  expectCode(wrongReplicas, "restart_contract_deployment_invalid");

  const wrongOriginalRv = buildFixture();
  wrongOriginalRv.restartContract.deployments[0].originalResourceVersion = "foreign-rv";
  expectCode(wrongOriginalRv, "restart_contract_deployment_invalid");

  const wrongQuiescedRv = buildFixture();
  wrongQuiescedRv.restartContract.deployments[0].quiescedResourceVersion = "foreign-rv";
  expectCode(wrongQuiescedRv, "restart_contract_deployment_invalid");
});

test("all non-rotation resources remain desired-state invariant", () => {
  const config = buildFixture();
  find(config.finalResources, "ConfigMap", "ret-config")
    .data[profile.ret_config_data_key] += "drift";
  expectCode(config, "bound_config_map_bytes_changed");

  const service = buildFixture();
  find(service.finalResources, "Service", "ret").spec = { selector: { app: "wrong" } };
  expectCode(service, "final_invariant_resource_changed");

  const metadata = buildFixture();
  find(metadata.finalResources, "Service", "ret").metadata.labels = { owner: "foreign" };
  expectCode(metadata, "final_invariant_resource_changed");

  const deleting = buildFixture();
  find(deleting.finalResources, "Service", "ret").metadata.deletionTimestamp =
    "2026-07-18T20:00:00Z";
  expectCode(deleting, "final_resource_metadata_invalid");
});

test("bundle binding is exact, artifact-bound and HMAC-authenticated", () => {
  const badHmac = buildFixture();
  badHmac.bundleBinding.hmacSha256 = "0".repeat(64);
  expectCode(badHmac, "bundle_binding_hmac_mismatch");

  const wrongBundle = buildFixture();
  wrongBundle.bundleBinding.files.bundle.sha256 = "0".repeat(64);
  expectCode(wrongBundle, "bundle_binding_bundle_invalid");

  const wrongRestart = buildFixture();
  wrongRestart.bundleBinding.files.restart.size += 1;
  expectCode(wrongRestart, "bundle_binding_restart_invalid");

  const wrongProfile = buildFixture();
  wrongProfile.bundleBinding.profileSha256 = "0".repeat(64);
  expectCode(wrongProfile, "bundle_binding_contract_mismatch");

  const wrongSource = buildFixture();
  wrongSource.bundleBinding.inputs.quiescedBaselineSha256 = "0".repeat(64);
  expectCode(wrongSource, "bundle_binding_input_hash_mismatch");

  const wrongIntentBinding = buildFixture();
  wrongIntentBinding.bundleBinding.operationBindingSha256 = "0".repeat(64);
  expectCode(wrongIntentBinding, "bundle_binding_invalid");
});

test("operation intent binds its own key and canonical original/old/new sources", () => {
  const resign = intent => {
    const body = structuredClone(intent);
    delete body.operationBindingSha256;
    delete body.hmacSha256;
    const authenticated = {
      ...body,
      operationBindingSha256: sha256(Buffer.from(canonicalOperationJson(body), "utf8"))
    };
    return {
      ...authenticated,
      hmacSha256: createHmac("sha256", fingerprintKey)
        .update(canonicalOperationJson(authenticated), "utf8")
        .digest("hex")
    };
  };
  const control = buildFixture();
  assert.notEqual(control.operationIntent.hmacSha256, control.bundleBinding.hmacSha256);
  assert.notEqual(
    control.operationIntent.operationBindingSha256,
    sha256(artifact(control.bundleBinding))
  );

  const badIntentHmac = buildFixture();
  badIntentHmac.operationIntent.hmacSha256 = "0".repeat(64);
  expectCode(badIntentHmac, "operation_intent_hmac_mismatch");

  const wrongKey = buildFixture();
  wrongKey.fingerprintKey = Buffer.alloc(32, 0x6b);
  expectCode(wrongKey, "operation_intent_hmac_mismatch");

  const originalDrift = buildFixture();
  originalDrift.operationIntent.originalBaselineSha256 = "1".repeat(64);
  originalDrift.operationIntent = resign(originalDrift.operationIntent);
  expectCode(originalDrift, "operation_intent_invalid");

  const oldDrift = buildFixture();
  oldDrift.operationIntent.oldSnapshotSha256 = "2".repeat(64);
  oldDrift.operationIntent = resign(oldDrift.operationIntent);
  expectCode(oldDrift, "operation_intent_invalid");

  const newDrift = buildFixture();
  newDrift.operationIntent.newSnapshotSha256 = "3".repeat(64);
  newDrift.operationIntent = resign(newDrift.operationIntent);
  expectCode(newDrift, "operation_intent_invalid");
});

test("operational attestation binds context, namespace/PVC UIDs, checkpoint, lock and bundle", () => {
  const control = buildFixture();
  control.operationalAttestation.expectedKubeContext = "fixture\ncontext";
  expectCode(control, "operational_attestation_invalid");

  const namespaceUid = buildFixture();
  namespaceUid.operationalAttestation.namespaceUid = "foreign-namespace-uid";
  expectCode(namespaceUid, "operational_namespace_uid_mismatch");

  const badCheckpoint = buildFixture();
  badCheckpoint.operationalAttestation.checkpointDumpSha256 = "A".repeat(64);
  expectCode(badCheckpoint, "operational_attestation_invalid");

  const foreignCheckpoint = buildFixture();
  foreignCheckpoint.operationalAttestation.checkpointDumpSha256 = "5".repeat(64);
  expectCode(foreignCheckpoint, "operational_bundle_binding_mismatch");

  const badState = buildFixture();
  badState.operationalAttestation.authenticatedContractState = "bundle-applied";
  expectCode(badState, "operational_attestation_invalid");

  const wrongOperationBinding = buildFixture();
  wrongOperationBinding.operationalAttestation.operationBindingSha256 = "0".repeat(64);
  expectCode(wrongOperationBinding, "operational_bundle_binding_mismatch");

  const wrongBundleHmac = buildFixture();
  wrongBundleHmac.operationalAttestation.bundleBindingHmacSha256 = "0".repeat(64);
  expectCode(wrongBundleHmac, "operational_bundle_binding_mismatch");

  const wrongOperationId = buildFixture();
  wrongOperationId.operationalAttestation.operationId = "cc".repeat(16);
  expectCode(wrongOperationId, "operational_bundle_binding_mismatch");
});

test("original normal to quiesced closed pgsql barrier is an exact one-CAS transition", () => {
  for (const [mutate, code] of [
    [input => {
      find(input.baselineResources, "NetworkPolicy", "pgsql-ingress")
        .metadata.uid = "foreign-policy-uid";
    }, "original_baseline_pgsql_barrier_drift"],
    [input => {
      find(input.baselineResources, "NetworkPolicy", "pgsql-ingress")
        .metadata.resourceVersion = find(
          input.originalBaselineResources, "NetworkPolicy", "pgsql-ingress"
        ).metadata.resourceVersion;
    }, "original_baseline_pgsql_barrier_drift"],
    [input => {
      find(input.baselineResources, "NetworkPolicy", "pgsql-ingress")
        .metadata.annotations["yenhubs.org/aud065-pgsql-barrier-state"] = "open-verified";
    }, "original_baseline_pgsql_barrier_marker_mismatch"],
    [input => {
      find(input.baselineResources, "NetworkPolicy", "pgsql-ingress")
        .spec = pgsqlNormalSpec();
    }, "original_baseline_pgsql_barrier_drift"],
    [input => {
      find(input.baselineResources, "NetworkPolicy", "pgsql-ingress")
        .metadata.labels["fixture.invalid/policy"] = "mutated";
    }, "original_baseline_pgsql_barrier_drift"],
    [input => {
      const policy = find(input.baselineResources, "NetworkPolicy", "pgsql-ingress");
      policy.spec.ingress = [{ from: [], ports: [] }];
      policy.metadata.annotations["fixture.invalid/second-mutation"] = "true";
    }, "original_baseline_pgsql_barrier_drift"]
  ]) {
    const input = buildFixture();
    mutate(input);
    expectCode(input, code);
  }
});

test("final pgsql barrier is normal and open-verified for the exact operation", () => {
  const wrongUid = buildFixture();
  find(wrongUid.finalResources, "NetworkPolicy", "pgsql-ingress")
    .metadata.uid = "foreign-policy-uid";
  expectCode(wrongUid, "final_pgsql_barrier_drift");

  const staleRv = buildFixture();
  const stalePolicy = find(staleRv.finalResources, "NetworkPolicy", "pgsql-ingress");
  stalePolicy.metadata.resourceVersion = find(
    staleRv.baselineResources, "NetworkPolicy", "pgsql-ingress"
  ).metadata.resourceVersion;
  expectCode(staleRv, "final_pgsql_barrier_drift");

  const abaRv = buildFixture();
  find(abaRv.finalResources, "NetworkPolicy", "pgsql-ingress")
    .metadata.resourceVersion = find(
      abaRv.originalBaselineResources, "NetworkPolicy", "pgsql-ingress"
    ).metadata.resourceVersion;
  expectCode(abaRv, "final_pgsql_barrier_drift");

  const specDrift = buildFixture();
  find(specDrift.finalResources, "NetworkPolicy", "pgsql-ingress")
    .spec.ingress[0].ports[0].port = 6432;
  expectCode(specDrift, "final_pgsql_barrier_drift");

  const wrongToken = buildFixture();
  find(wrongToken.finalResources, "NetworkPolicy", "pgsql-ingress")
    .metadata.annotations["yenhubs.org/aud065-pgsql-operation-token"] = "cc".repeat(16);
  expectCode(wrongToken, "final_pgsql_barrier_marker_mismatch");

  const wrongLock = buildFixture();
  find(wrongLock.finalResources, "NetworkPolicy", "pgsql-ingress")
    .metadata.annotations["yenhubs.org/aud065-pgsql-lock-uid"] = "foreign-lock-uid";
  expectCode(wrongLock, "final_pgsql_barrier_marker_mismatch");

  for (const [marker, value] of [
    ["yenhubs.org/aud065-pgsql-operation-binding-sha256", "0".repeat(64)],
    ["yenhubs.org/aud065-pgsql-barrier-state", "open"],
    ["yenhubs.org/aud065-pgsql-normal-spec-sha256", "0".repeat(64)]
  ]) {
    const wrongMarker = buildFixture();
    find(wrongMarker.finalResources, "NetworkPolicy", "pgsql-ingress")
      .metadata.annotations[marker] = value;
    expectCode(wrongMarker, "final_pgsql_barrier_marker_mismatch");
  }

  const prematureNormal = buildFixture();
  const prematurePolicy = find(
    prematureNormal.finalResources, "NetworkPolicy", "pgsql-ingress"
  );
  prematurePolicy.metadata.annotations = structuredClone(
    find(prematureNormal.originalBaselineResources, "NetworkPolicy", "pgsql-ingress")
      .metadata.annotations
  );
  expectCode(prematureNormal, "final_pgsql_barrier_drift");

  const extraMarker = buildFixture();
  find(extraMarker.finalResources, "NetworkPolicy", "pgsql-ingress")
    .metadata.annotations["yenhubs.org/aud065-extra"] = "forbidden";
  expectCode(extraMarker, "final_pgsql_barrier_drift");
});

test("released baseline permits only server churn plus the exact pgsql marker cleanup", () => {
  const input = buildFixture();
  const released = releasedBaselineFrom(input);
  const reticulum = find(released.releasedResources, "Deployment", "reticulum");
  reticulum.metadata.resourceVersion = "controller-rv-after-cleanup";
  reticulum.metadata.generation = 91;
  reticulum.metadata.managedFields = [{ manager: "fixture-controller" }];
  reticulum.status = { observedGeneration: 91, readyReplicas: 1 };
  const verifiedPolicy = find(released.verifiedResources, "NetworkPolicy", "pgsql-ingress");
  verifiedPolicy.metadata.generation = 31;
  verifiedPolicy.metadata.managedFields = [{ manager: "fixture-cni-verified" }];
  verifiedPolicy.status = { observedGeneration: 31 };
  const releasedPolicy = find(released.releasedResources, "NetworkPolicy", "pgsql-ingress");
  releasedPolicy.metadata.generation = 32;
  releasedPolicy.metadata.managedFields = [{ manager: "fixture-cni-released" }];
  releasedPolicy.status = { observedGeneration: 32 };
  assert.equal(verifyReleasedProcessLocalBaseline(released), true);

  const secretDrift = releasedBaselineFrom(buildFixture());
  find(secretDrift.releasedResources, "Secret", "configs").data.DB_PASS =
    Buffer.from("reverted-secret", "utf8").toString("base64");
  assert.throws(
    () => verifyReleasedProcessLocalBaseline(secretDrift),
    error => error.code === "released_resource_desired_state_drift"
  );

  const uidDrift = releasedBaselineFrom(buildFixture());
  find(uidDrift.releasedResources, "Service", "ret").metadata.uid = "replacement-uid";
  assert.throws(
    () => verifyReleasedProcessLocalBaseline(uidDrift),
    error => error.code === "released_resource_identity_drift"
  );

  const verifiedAba = releasedBaselineFrom(buildFixture());
  find(verifiedAba.verifiedResources, "NetworkPolicy", "pgsql-ingress")
    .metadata.resourceVersion = verifiedAba.initialPolicyResourceVersion;
  assert.throws(
    () => verifyReleasedProcessLocalBaseline(verifiedAba),
    error => error.code === "released_pgsql_cleanup_drift"
  );

  for (const mutate of [
    value => {
      find(value.releasedResources, "NetworkPolicy", "pgsql-ingress")
        .metadata.annotations["yenhubs.org/aud065-pgsql-barrier-state"] = "open-verified";
    },
    value => {
      find(value.releasedResources, "NetworkPolicy", "pgsql-ingress")
        .spec.ingress[0].ports[0].port = 6432;
    },
    value => {
      const policy = find(value.releasedResources, "NetworkPolicy", "pgsql-ingress");
      policy.metadata.resourceVersion = find(
        value.verifiedResources,
        "NetworkPolicy",
        "pgsql-ingress"
      ).metadata.resourceVersion;
    },
    value => {
      find(value.releasedResources, "NetworkPolicy", "pgsql-ingress")
        .metadata.resourceVersion = value.initialPolicyResourceVersion;
    },
    value => {
      find(value.releasedResources, "NetworkPolicy", "pgsql-ingress")
        .metadata.labels["fixture.invalid/policy"] = "second-mutation";
    },
    value => {
      find(value.verifiedResources, "NetworkPolicy", "pgsql-ingress")
        .metadata.annotations["yenhubs.org/aud065-pgsql-normal-spec-sha256"] =
          "0".repeat(64);
    }
  ]) {
    const drift = releasedBaselineFrom(buildFixture());
    mutate(drift);
    assert.throws(
      () => verifyReleasedProcessLocalBaseline(drift),
      error => error.code === "released_pgsql_cleanup_drift"
    );
  }
});

test("live audit requires all twelve exact Deployments fully observed and ready", () => {
  const accepted = readyLiveReleaseFrom(buildFixture());
  assert.equal(verifyReadyProcessLocalDeployments({
    resources: accepted.releasedResources,
    namespace
  }), true);
  const unavailableZero = readyLiveReleaseFrom(buildFixture());
  find(unavailableZero.releasedResources, "Deployment", "reticulum")
    .status.unavailableReplicas = 0;
  assert.equal(verifyReadyProcessLocalDeployments({
    resources: unavailableZero.releasedResources,
    namespace
  }), true);

  for (const mutate of [
    deployment => { deployment.spec.replicas = 0; },
    deployment => { deployment.metadata.generation += 1; },
    deployment => { deployment.status.replicas = 0; },
    deployment => { deployment.status.updatedReplicas = 0; },
    deployment => { deployment.status.readyReplicas = 0; },
    deployment => { deployment.status.availableReplicas = 0; },
    deployment => { deployment.status.unavailableReplicas = 1; },
    deployment => { deployment.status.terminatingReplicas = 1; },
    deployment => { deployment.metadata.deletionTimestamp = "2026-07-18T20:00:00Z"; }
  ]) {
    const drift = readyLiveReleaseFrom(buildFixture());
    mutate(find(drift.releasedResources, "Deployment", "spoke"));
    assert.throws(
      () => verifyReadyProcessLocalDeployments({
        resources: drift.releasedResources,
        namespace
      }),
      error => error instanceof RedactedRolloutError &&
        error.code === "live_deployment_readiness_invalid"
    );
  }

  const missing = readyLiveReleaseFrom(buildFixture());
  missing.releasedResources = missing.releasedResources.filter(resource =>
    resource.kind !== "Deployment" || resource.metadata.name !== "hubs"
  );
  assert.throws(
    () => verifyReadyProcessLocalDeployments({
      resources: missing.releasedResources,
      namespace
    }),
    error => error instanceof RedactedRolloutError &&
      error.code === "live_audit_inventory_invalid_mismatch"
  );
});

test("release CLI double-reads private baselines and emits only a safe verdict", () => {
  const directory = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "yenhubs-release-baseline-"
  ));
  fs.chmodSync(directory, 0o700);
  try {
    const released = releasedBaselineFrom(buildFixture());
    const verifiedPath = privateFile(
      directory,
      "verified.json",
      listSource(released.verifiedResources)
    );
    const releasedPath = privateFile(
      directory,
      "released.json",
      listSource(released.releasedResources)
    );
    const result = spawnSync(process.execPath, [
      CLI,
      "verify-release",
      "--verified-baseline", verifiedPath,
      "--released-baseline", releasedPath,
      "--namespace", namespace,
      "--initial-policy-resource-version", released.initialPolicyResourceVersion
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "process_local_release_verified\n");
    assert.equal(result.stderr, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("live release CLI keeps all 42 resources in memory and emits one safe token", () => {
  const directory = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "yenhubs-live-release-"
  ));
  fs.chmodSync(directory, 0o700);
  try {
    const fixture = buildFixture();
    const live = readyLiveReleaseFrom(fixture);
    const verifiedPath = privateFile(
      directory,
      "verified.json",
      listSource(live.verifiedResources)
    );
    const releasedPath = privateFile(
      directory,
      "released.json",
      listSource(releasedBaselineFrom(fixture).releasedResources)
    );
    const kubectl = installLiveKubectlFixture(directory, live.releasedResources);
    const before = new Set(fs.readdirSync(directory));
    const result = spawnSync(process.execPath, [
      CLI,
      "verify-live-release",
      "--verified-baseline", verifiedPath,
      "--released-baseline", releasedPath,
      "--namespace", namespace,
      "--initial-policy-resource-version", live.initialPolicyResourceVersion,
      "--context", "fixture-context"
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${kubectl.bin}${path.delimiter}${process.env.PATH || ""}`,
        AUD065_LIVE_FIXTURE: kubectl.resourcesPath,
        AUD065_KUBECTL_LOG: kubectl.logPath
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "process_local_live_audit_verified\n");
    assert.equal(result.stderr, "");
    const additions = fs.readdirSync(directory).filter(name => !before.has(name));
    assert.deepEqual(additions, ["kubectl.log"]);
    const log = fs.readFileSync(kubectl.logPath, "utf8");
    assert.equal(log.trim().split("\n").length, 42);
    assert.doesNotMatch(log, /\b(?:apply|create|delete|exec|patch|replace|scale)\b/u);
    const secretSentinels = [
      newSecrets.OPENAI_API_KEY,
      Buffer.from(newSecrets.OPENAI_API_KEY, "utf8").toString("base64")
    ];
    for (const sentinel of secretSentinels) {
      assert.equal(`${result.stdout}${result.stderr}${log}`.includes(sentinel), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Dialog accepts exactly one canonical RSA PUBLIC KEY PEM", () => {
  assert.doesNotThrow(() => parseDialogPublicKeySource(newKey.publicPem));
  assert.throws(
    () => parseDialogPublicKeySource(`${newKey.publicPem}${oldKey.publicPem}`),
    error => error.code === "dialog_public_key_invalid"
  );
  assert.throws(
    () => parseDialogPublicKeySource(`prefix\n${newKey.publicPem}`),
    error => error.code === "dialog_public_key_invalid"
  );
  assert.throws(
    () => parseDialogPublicKeySource(newKey.snapshotPrivate),
    error => error.code === "dialog_public_key_invalid"
  );

  const stale = buildFixture();
  stale.dialogRuntimePublicKeySource = oldKey.publicPem;
  expectCode(stale, "perms_dialog_runtime_mismatch");
});

test("Reticulum JWK and all four PERMS surfaces use real matching RSA material", () => {
  const fakeJwk = buildFixture();
  fakeJwk.reticulumRuntimeJwkSource = JSON.stringify({ kty: "RSA", n: "fake", e: "AQAB" });
  expectCode(fakeJwk, "runtime_jwk_invalid");

  const staleReticulum = buildFixture();
  staleReticulum.reticulumRuntimeJwkSource = JSON.stringify(oldKey.jwk);
  expectCode(staleReticulum, "perms_reticulum_runtime_mismatch");

  assert.throws(
    () => parseRsaJwkSource('{"kty":"RSA","n":"x","n":"y","e":"AQAB"}'),
    error => error.code === "runtime_jwk_invalid"
  );
});

test("strict JSON and the complete canonical profile fail closed", () => {
  assert.throws(
    () => parseStrictJsonSource('{"value":1,"value":2}'),
    error => error instanceof RedactedRolloutError && error.code === "json_source_invalid"
  );
  const changed = structuredClone(profile);
  changed.baseline_resource_identities.pop();
  assert.throws(
    () => internals.assertPinnedProfile(changed),
    error => error instanceof RedactedRolloutError &&
      error.code === "canonical_profile_digest_mismatch"
  );
});

function privateFile(directory, name, bytes) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function listSource(items) {
  return artifact(resourceList(items));
}

function cliFixture() {
  const directory = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "yenhubs-redacted-"
  ));
  fs.chmodSync(directory, 0o700);
  const input = buildFixture();
  const operationDirectory = path.join(directory, "operation");
  let randomCall = 0;
  initProcessLocalRotationOperation({
    parentDirectory: directory,
    operationDirectory,
    rotationRevision: revision,
    randomBytes(size) {
      randomCall += 1;
      if (randomCall === 1) return Buffer.alloc(size, 0x5a);
      if (randomCall === 2) return Buffer.alloc(size, 0xaa);
      return Buffer.alloc(size, 0xbb);
    }
  });
  privateFile(
    operationDirectory,
    "original-baseline.json",
    listSource(input.originalBaselineResources)
  );
  privateFile(operationDirectory, "old-snapshot.json", artifact(input.oldValues));
  privateFile(operationDirectory, "new-snapshot.json", artifact(input.newValues));
  privateFile(operationDirectory, "old-values-source.yaml", oldValuesSourceFixture);
  privateFile(operationDirectory, "new-values-source.yaml", newValuesSourceFixture);
  sealProcessLocalRotationOperation({
    operationDirectory,
    metadata: {
      expectedKubeContext: input.operationIntent.expectedKubeContext,
      namespaceName: input.operationIntent.namespaceName,
      namespaceUid: input.operationIntent.namespaceUid,
      retPvcName: input.operationIntent.retPvcName,
      retPvcUid: input.operationIntent.retPvcUid,
      checkpointStamp: input.operationIntent.checkpointStamp,
      checkpointDumpSha256: input.operationIntent.checkpointDumpSha256,
      checkpointStorageSha256: input.operationIntent.checkpointStorageSha256,
      checkpointInventorySha256: input.operationIntent.checkpointInventorySha256,
      profileId: input.operationIntent.profileId,
      profileSha256: input.operationIntent.profileSha256
    }
  });
  assert.deepEqual(
    loadVerifiedProcessLocalRotationIntent({ operationDirectory }),
    input.operationIntent
  );
  privateFile(
    operationDirectory,
    "quiesced-baseline.json",
    listSource(input.baselineResources)
  );
  const bundleDirectory = path.join(operationDirectory, "bundle");
  fs.mkdirSync(bundleDirectory, { mode: 0o700 });
  fs.chmodSync(bundleDirectory, 0o700);
  const paths = {
    operationDirectory,
    original: path.join(operationDirectory, "original-baseline.json"),
    baseline: path.join(operationDirectory, "quiesced-baseline.json"),
    oldValues: path.join(operationDirectory, "old-snapshot.json"),
    newValues: path.join(operationDirectory, "new-snapshot.json"),
    bundle: privateFile(bundleDirectory, "bundle.json", artifact(input.bundle)),
    binding: privateFile(bundleDirectory, "binding.json", artifact(input.bundleBinding)),
    restart: privateFile(
      bundleDirectory,
      "restart-contract.json",
      artifact(input.restartContract)
    ),
    cas: privateFile(directory, "cas.json", listSource(input.casResponseResources)),
    final: privateFile(directory, "final.json", listSource(input.finalResources)),
    operation: privateFile(
      directory,
      "operation.json",
      JSON.stringify(input.operationalAttestation)
    ),
    reticulum: privateFile(directory, "reticulum.jwk", input.reticulumRuntimeJwkSource),
    dialog: privateFile(directory, "dialog.pem", input.dialogRuntimePublicKeySource),
    hmac: path.join(operationDirectory, "operation.key")
  };
  const args = [
    CLI,
    "--operation-directory", paths.operationDirectory,
    "--original-baseline", paths.original,
    "--baseline-resources", paths.baseline,
    "--old-values", paths.oldValues,
    "--new-values", paths.newValues,
    "--bundle", paths.bundle,
    "--bundle-binding", paths.binding,
    "--restart-contract", paths.restart,
    "--cas-responses", paths.cas,
    "--final-resources", paths.final,
    "--operational-attestation", paths.operation,
    "--reticulum-jwk", paths.reticulum,
    "--dialog-public-key", paths.dialog,
    "--fingerprint-key", paths.hmac
  ];
  return { directory, input, paths, args };
}

function replacePathPrefix(args, from, to) {
  return args.map(value =>
    typeof value === "string" && value.startsWith(`${from}${path.sep}`)
      ? `${to}${value.slice(from.length)}`
      : value
  );
}

function runCli(fixture, reportPath, args = fixture.args) {
  return spawnSync(process.execPath, [...args, "--report", reportPath], {
    cwd: ROOT,
    encoding: "utf8"
  });
}

test("CLI consumes stable owner-only bytes and atomically adopts an exact report retry", () => {
  const fixture = cliFixture();
  try {
    const reportPath = path.join(fixture.directory, "report.json");
    const result = runCli(fixture, reportPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "redacted_rollout_verified\n");
    assert.equal(result.stderr, "");
    const stat = fs.statSync(reportPath);
    assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(stat.nlink, 1);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).verdict, "pass");

    const overwrite = runCli(fixture, reportPath);
    assert.equal(overwrite.status, 0, overwrite.stderr);
    assert.equal(overwrite.stdout, "redacted_rollout_verified\n");
    assert.equal(overwrite.stderr, "");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("CLI rejects noncanonical quiesced and bundle artifact bytes", () => {
  for (const [pathName, expectedCode] of [
    ["baseline", "private_baseline_invalid"],
    ["bundle", "private_bundle_invalid"]
  ]) {
    const fixture = cliFixture();
    try {
      const target = fixture.paths[pathName];
      fs.writeFileSync(target, JSON.stringify(JSON.parse(fs.readFileSync(target, "utf8"))), {
        mode: 0o600
      });
      fs.chmodSync(target, 0o600);
      const result = runCli(
        fixture,
        path.join(fixture.directory, `noncanonical-${pathName}-report.json`)
      );
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr,
        `redacted_rollout_verification_failed:${expectedCode}\n`
      );
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("CLI rejects loose modes, hard links and leaf symlinks", () => {
  const loose = cliFixture();
  try {
    fs.chmodSync(loose.paths.bundle, 0o640);
    const result = runCli(loose, path.join(loose.directory, "loose-report.json"));
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "redacted_rollout_verification_failed:private_bundle_invalid\n");
  } finally {
    fs.rmSync(loose.directory, { recursive: true, force: true });
  }

  const looseDirectory = cliFixture();
  try {
    fs.chmodSync(path.dirname(looseDirectory.paths.bundle), 0o755);
    const result = runCli(
      looseDirectory,
      path.join(looseDirectory.directory, "loose-directory-report.json")
    );
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "redacted_rollout_verification_failed:operation_layout_invalid\n"
    );
  } finally {
    fs.rmSync(looseDirectory.directory, { recursive: true, force: true });
  }

  const linked = cliFixture();
  try {
    fs.linkSync(linked.paths.bundle, path.join(linked.directory, "bundle-hardlink.json"));
    const result = runCli(linked, path.join(linked.directory, "hardlink-report.json"));
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "redacted_rollout_verification_failed:private_bundle_invalid\n");
  } finally {
    fs.rmSync(linked.directory, { recursive: true, force: true });
  }

  const symlink = cliFixture();
  try {
    const target = path.join(symlink.directory, "bundle-target.json");
    fs.renameSync(symlink.paths.bundle, target);
    fs.symlinkSync(target, symlink.paths.bundle);
    const result = runCli(symlink, path.join(symlink.directory, "symlink-report.json"));
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "redacted_rollout_verification_failed:private_path_invalid\n");
  } finally {
    fs.rmSync(symlink.directory, { recursive: true, force: true });
  }
});

test("CLI rejects setuid, setgid and sticky bits on private inputs", () => {
  for (const mode of [0o4600, 0o2600]) {
    const fixture = cliFixture();
    try {
      fs.chmodSync(fixture.paths.bundle, mode);
      assert.equal(fs.lstatSync(fixture.paths.bundle).mode & 0o7777, mode);
      const result = runCli(
        fixture,
        path.join(fixture.directory, `special-${mode.toString(8)}-report.json`)
      );
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr,
        "redacted_rollout_verification_failed:private_bundle_invalid\n"
      );
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  }

  const sticky = cliFixture();
  try {
    const bundleDirectory = path.dirname(sticky.paths.bundle);
    fs.chmodSync(bundleDirectory, 0o1700);
    assert.equal(fs.lstatSync(bundleDirectory).mode & 0o7777, 0o1700);
    const result = runCli(
      sticky,
      path.join(sticky.directory, "sticky-directory-report.json")
    );
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "redacted_rollout_verification_failed:operation_layout_invalid\n"
    );
  } finally {
    fs.chmodSync(path.dirname(sticky.paths.bundle), 0o700);
    fs.rmSync(sticky.directory, { recursive: true, force: true });
  }
});

test("CLI rejects every symlinked intermediate directory for input and output", () => {
  const inputFixture = cliFixture();
  const inputAlias = `${inputFixture.directory}-alias`;
  try {
    fs.symlinkSync(inputFixture.directory, inputAlias);
    const args = replacePathPrefix(inputFixture.args, inputFixture.directory, inputAlias);
    const result = runCli(
      inputFixture,
      path.join(inputFixture.directory, "input-ancestor-report.json"),
      args
    );
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "redacted_rollout_verification_failed:private_operation_intent_invalid\n"
    );
  } finally {
    fs.rmSync(inputAlias, { force: true });
    fs.rmSync(inputFixture.directory, { recursive: true, force: true });
  }

  const outputFixture = cliFixture();
  const outputAlias = `${outputFixture.directory}-alias`;
  try {
    fs.symlinkSync(outputFixture.directory, outputAlias);
    const result = runCli(outputFixture, path.join(outputAlias, "report.json"));
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "redacted_rollout_verification_failed:private_path_invalid\n");
  } finally {
    fs.rmSync(outputAlias, { force: true });
    fs.rmSync(outputFixture.directory, { recursive: true, force: true });
  }
});

test("CLI requires an owner-only 0700 report parent", () => {
  const fixture = cliFixture();
  const looseOutput = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "yenhubs-redacted-loose-output-"
  ));
  try {
    fs.chmodSync(looseOutput, 0o755);
    const result = runCli(fixture, path.join(looseOutput, "report.json"));
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "redacted_rollout_verification_failed:private_report_parent_invalid\n"
    );
  } finally {
    fs.rmSync(looseOutput, { recursive: true, force: true });
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

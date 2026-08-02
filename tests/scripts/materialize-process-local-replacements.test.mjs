import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  MaterializeProcessLocalRotationError,
  classifyProcessLocalRotationFiles,
  emitVerifiedProcessLocalRotationReplacement,
  emitVerifiedProcessLocalDeploymentContract,
  extractAppliedProcessLocalRotationResources,
  loadVerifiedProcessLocalOperationalAttestationInputs,
  materializeProcessLocalRotationReplacements,
  verifyProcessLocalRotationReplacements
} from "../../deployment/materialize-process-local-replacements.mjs";
import {
  canonicalJson,
  loadProcessLocalRotationProfile,
  projectProcessLocalRotationReplacement
} from "../../deployment/process-local-rotation.mjs";
import {
  initProcessLocalRotationOperation,
  loadVerifiedProcessLocalRotationIntent,
  sealProcessLocalRotationOperation,
  writeProcessLocalBarrierBinding
} from "../../deployment/process-local-rotation-operation.mjs";
import {
  writeProcessLocalOperationalAttestation
} from "../../deployment/write-process-local-operational-attestation.mjs";
import {
  prepareOfflineProcessLocalRotation
} from "../../deployment/prepare-process-local-rotation.mjs";

const profile = loadProcessLocalRotationProfile();
const namespace = "hcce";
const revision = "aud065-materializefixture";
const cliPath = path.resolve("deployment/materialize-process-local-replacements.mjs");
const attestationCliPath = path.resolve(
  "deployment/write-process-local-operational-attestation.mjs"
);
const replacementNames = [
  "00-secret-configs.json",
  `01-secret-${profile.legacy_image_pull.secret.name}.json`,
  ...profile.rotation_revision_deployments.map((name, index) =>
    `${String(index + 2).padStart(2, "0")}-deployment-${name}.json`)
];
const pgsqlBarrierMarkers = Object.freeze({
  lockUid: "yenhubs.org/aud065-pgsql-lock-uid",
  operationToken: "yenhubs.org/aud065-pgsql-operation-token",
  operationBinding: "yenhubs.org/aud065-pgsql-operation-binding-sha256",
  state: "yenhubs.org/aud065-pgsql-barrier-state",
  normalSpec: "yenhubs.org/aud065-pgsql-normal-spec-sha256"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encodedPrivateKey() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return privateKey.replace(/\n/gu, "\\n");
}

function runtimePrivateKey(encodedKey) {
  return encodedKey.replace(/\\+n/gu, "\n").trim().replace(/\n/gu, "\\\\n");
}

function permsMaterial(encodedKey) {
  const privateKey = createPrivateKey(encodedKey.replace(/\\+n/gu, "\n"));
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  return {
    jwt: JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e }),
    fingerprint: sha256(publicKey.export({ type: "spki", format: "der" }))
  };
}

function snapshotSecretValues(prefix, permsKey) {
  const dbPassword = `${prefix}-database-password-with-sufficient-entropy`;
  return {
    ADM_EMAIL: "admin@example.invalid",
    BOT_ACCESS_KEY: `${prefix}-bot-binding-secret-material-000000000001`,
    DB_HOST: "pgbouncer",
    DB_HOST_T: "pgbouncer-t",
    DB_NAME: "retdb",
    DB_PASS: dbPassword,
    DB_USER: "postgres",
    GUARDIAN_KEY: `${prefix}-guardian-secret-material-000000000000005`,
    HUB_DOMAIN: "example.invalid",
    NODE_COOKIE: `${prefix}-node-cookie-secret-material-000000000006`,
    OPENAI_API_KEY: `${prefix}-provider-secret-material-00000000000007`,
    PERMS_KEY: permsKey,
    PGRST_DB_URI: `postgres://postgres:${dbPassword}@pgbouncer:5432/retdb`,
    PHX_KEY: `${prefix}-phoenix-secret-material-0000000000000008`,
    PSQL: `postgres://postgres:${dbPassword}@pgsql:5432/retdb`,
    SKETCHFAB_API_KEY: `${prefix}-sketchfab-secret-material-00000000009`,
    SMTP_PASS: `${prefix}-smtp-secret-material-000000000000000010`,
    SMTP_PORT: "2525",
    SMTP_SERVER: "smtp.example.invalid",
    SMTP_USER: "mailer@example.invalid",
    TENOR_API_KEY: `${prefix}-tenor-secret-material-000000000000011`
  };
}

const oldPermsKey = encodedPrivateKey();
const newPermsKey = encodedPrivateKey();
const oldSecrets = snapshotSecretValues("materialize-before", oldPermsKey);
const newSecrets = snapshotSecretValues("materialize-after", newPermsKey);
const oldPerms = permsMaterial(oldPermsKey);
const imageValueKeys = [...new Set([
  ...profile.image_pairs.map(pair => pair.value_key),
  ...profile.legacy_image_pull.verified_image_value_keys
])];
const imageByValueKey = Object.fromEntries(imageValueKeys.map((valueKey, index) => [
  valueKey,
  `${valueKey === "OVERRIDE_BOT_RUNNER_IMAGE"
    ? "ghcr.io/yengalvez/bot-runner"
    : profile.image_pairs.find(pair => pair.value_key === valueKey).repositories[0]}` +
    `@sha256:${(index + 1).toString(16).repeat(64)}`
]));
const imageByPair = Object.fromEntries(profile.image_pairs.map(pair => [
  `${pair.deployment}/${pair.container}`,
  imageByValueKey[pair.value_key]
]));

function encodedPullConfig(username, token, spacing = 0) {
  return Buffer.from(JSON.stringify({
    auths: {
      "ghcr.io": {
        auth: Buffer.from(`${username}:${token}`, "utf8").toString("base64")
      }
    }
  }, null, spacing), "utf8").toString("base64");
}

const oldPullConfig = encodedPullConfig(
  "materialize-fixture-user",
  "materialize-old-pull-token"
);
const oldLivePullConfig = encodedPullConfig(
  "materialize-fixture-user",
  "materialize-old-pull-token",
  2
);
const newPullConfig = encodedPullConfig(
  "materialize-fixture-user",
  "materialize-new-pull-token"
);

function databaseChecksum(values) {
  return sha256(JSON.stringify({
    DB_USER: values.DB_USER,
    DB_PASS: values.DB_PASS,
    DB_NAME: values.DB_NAME,
    DB_HOST: values.DB_HOST,
    DB_HOST_T: values.DB_HOST_T,
    PGRST_DB_URI: values.PGRST_DB_URI,
    PSQL: values.PSQL
  }));
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

function pgsqlPolicyMetadataSha256(resource) {
  const annotations = structuredClone(resource.metadata.annotations || {});
  for (const name of Object.values(pgsqlBarrierMarkers)) delete annotations[name];
  return sha256(Buffer.from(canonicalJson({
    labels: structuredClone(resource.metadata.labels || {}),
    annotations,
    ownerReferences: structuredClone(resource.metadata.ownerReferences || []),
    finalizers: structuredClone(resource.metadata.finalizers || [])
  }), "utf8"));
}

let resourceVersion = 100;

function liveMetadata(name) {
  resourceVersion += 1;
  return {
    name,
    namespace,
    uid: `materialize-fixture-uid-${name}`,
    resourceVersion: String(resourceVersion)
  };
}

function envSecret(name, key) {
  return { name, valueFrom: { secretKeyRef: { name: "configs", key } } };
}

function baselineAnnotations(name) {
  const annotations = { "fixture.invalid/stable": "true" };
  if (profile.db_checksum_deployments.includes(name)) {
    annotations[profile.annotations.database_checksum] = databaseChecksum(oldSecrets);
  }
  if (profile.bot_access_checksum_deployments.includes(name)) {
    annotations[profile.annotations.bot_access_key_checksum] =
      sha256(oldSecrets.BOT_ACCESS_KEY);
  }
  return annotations;
}

function deployment(name, containers) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      ...liveMetadata(name),
      generation: 7,
      annotations: { "fixture.invalid/deployment": "stable" }
    },
    spec: {
      replicas: profile.rotation_revision_deployments.includes(name) ? 0 : 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: name } },
      template: {
        metadata: {
          labels: { app: name },
          annotations: baselineAnnotations(name)
        },
        spec: {
          automountServiceAccountToken: false,
          containers: containers.map(container => {
            const env = profile.secret_env_bindings
              .filter(binding =>
                binding.deployment === name && binding.container === container.name)
              .map(binding => envSecret(binding.env, binding.key));
            if (name === "bot-orchestrator" && container.name === "bot-orchestrator") {
              env.push(
                { name: "RUNNER_AUTOSTART", value: "true" },
                { name: "RUNNER_BACKEND", value: "ghost" }
              );
            }
            return {
              name: container.name,
              image: container.image,
              ...(env.length > 0 ? { env } : {})
            };
          })
        }
      }
    },
    status: { observedGeneration: 7, replicas: 0 }
  };
}

function retConfigText() {
  return Object.entries(profile.ret_config_placeholder_counts)
    .flatMap(([name, count]) => Array.from({ length: count }, () => `<${name}>`))
    .join("\n");
}

function completeHistoricalInventory(resources) {
  const identity = resource => [
    resource.apiVersion,
    resource.kind,
    resource.metadata.namespace || "",
    resource.metadata.name
  ].join("\u0000");
  const existing = new Set(resources.map(identity));
  for (const expected of profile.baseline_resource_identities) {
    const namespaceValue = expected.namespace === "$Namespace" ? namespace : undefined;
    const name = expected.name === "$Namespace" ? namespace : expected.name;
    const resource = {
      apiVersion: expected.apiVersion,
      kind: expected.kind,
      metadata: {
        name,
        ...(namespaceValue ? { namespace: namespaceValue } : {}),
        uid: `materialize-fixture-uid-${expected.kind.toLowerCase()}-${name}`,
        resourceVersion: String(++resourceVersion)
      },
      ...(expected.apiVersion === "networking.k8s.io/v1" &&
          expected.kind === "NetworkPolicy" && expected.name === "pgsql-ingress"
        ? { spec: pgsqlNormalSpec() }
        : {})
    };
    if (!existing.has(identity(resource))) resources.push(resource);
  }
  return resources;
}

function completeOperationalInventory(resources) {
  const completed = completeHistoricalInventory(resources);
  completed.push(
    {
      apiVersion: profile.legacy_image_pull.secret.apiVersion,
      kind: profile.legacy_image_pull.secret.kind,
      metadata: liveMetadata(profile.legacy_image_pull.secret.name),
      type: profile.legacy_image_pull.secret.type,
      data: {
        [profile.legacy_image_pull.secret.data_key]: oldLivePullConfig
      }
    },
    {
      apiVersion: profile.legacy_image_pull.service_account.apiVersion,
      kind: profile.legacy_image_pull.service_account.kind,
      metadata: liveMetadata(profile.legacy_image_pull.service_account.name),
      imagePullSecrets: structuredClone(
        profile.legacy_image_pull.service_account.image_pull_secrets
      )
    }
  );
  assert.equal(completed.length, 44);
  return completed;
}

function quiescedBaseline() {
  resourceVersion = 100;
  const secretMetadata = liveMetadata("configs");
  return completeOperationalInventory([
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        uid: "materialize-fixture-namespace-uid",
        resourceVersion: "99"
      }
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: secretMetadata,
      type: "Opaque",
      stringData: {
        ...structuredClone(oldSecrets),
        PERMS_KEY: runtimePrivateKey(oldSecrets.PERMS_KEY),
        PGRST_JWT_SECRET: oldPerms.jwt
      }
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: liveMetadata("ret-config"),
      data: { "config.toml.template": retConfigText() }
    },
    deployment("bot-orchestrator", [{
      name: "bot-orchestrator",
      image: imageByPair["bot-orchestrator/bot-orchestrator"]
    }]),
    deployment("coturn", [{ name: "coturn", image: imageByPair["coturn/coturn"] }]),
    deployment("dialog", [{ name: "dialog", image: imageByPair["dialog/dialog"] }]),
    deployment("haproxy", [{ name: "haproxy", image: imageByPair["haproxy/haproxy"] }]),
    deployment("hubs", [{ name: "hubs", image: imageByPair["hubs/hubs"] }]),
    deployment("nearspark", [{
      name: "nearspark", image: imageByPair["nearspark/nearspark"]
    }]),
    deployment("pgbouncer", [{
      name: "pgbouncer", image: imageByPair["pgbouncer/pgbouncer"]
    }]),
    deployment("pgbouncer-t", [{
      name: "pgbouncer-t", image: imageByPair["pgbouncer-t/pgbouncer-t"]
    }]),
    deployment("photomnemonic", [{
      name: "photomnemonic", image: imageByPair["photomnemonic/photomnemonic"]
    }]),
    deployment("pgsql", [{
      name: "postgresql", image: imageByPair["pgsql/postgresql"]
    }]),
    deployment("reticulum", [
      { name: "reticulum", image: imageByPair["reticulum/reticulum"] },
      { name: "postgrest", image: imageByPair["reticulum/postgrest"] }
    ]),
    deployment("spoke", [{ name: "spoke", image: imageByPair["spoke/spoke"] }])
  ]);
}

function snapshotValues(snapshot, pullConfig) {
  return {
    Namespace: namespace,
    ...structuredClone(snapshot),
    ...structuredClone(imageByValueKey),
    [profile.legacy_image_pull.snapshot_value_key]: pullConfig
  };
}

function findResource(resources, kind, name) {
  return resources.find(resource =>
    resource.kind === kind && resource.metadata.name === name
  );
}

function targetResources(resources) {
  return [
    findResource(resources, "Secret", "configs"),
    findResource(resources, "Secret", profile.legacy_image_pull.secret.name),
    ...profile.rotation_revision_deployments.map(name =>
      findResource(resources, "Deployment", name))
  ];
}

function writePrivateText(filePath, text) {
  fs.writeFileSync(filePath, text, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}

function writePrivateJson(filePath, value) {
  writePrivateText(filePath, `${canonicalJson(value)}\n`);
}

function rewritePrivateText(filePath, text) {
  fs.writeFileSync(filePath, text, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function rewritePrivateJson(filePath, value) {
  rewritePrivateText(filePath, `${canonicalJson(value)}\n`);
}

function deterministicRandom() {
  let call = 0;
  return size => {
    call += 1;
    return Buffer.alloc(size, call === 1 ? 0xff : call);
  };
}

function originalBaselineFrom(quiesced) {
  const original = structuredClone(quiesced);
  for (const resource of original) {
    if (resource.kind === "Deployment" &&
        profile.rotation_revision_deployments.includes(resource.metadata.name)) {
      resource.spec.replicas = 1;
      resource.metadata.resourceVersion = `materialize-original-${resource.metadata.name}`;
    }
  }
  return original;
}

function closeQuiescedPgsqlPolicy(quiesced, original, intent, barrier) {
  const originalPolicy = findResource(original, "NetworkPolicy", "pgsql-ingress");
  const quiescedPolicy = findResource(quiesced, "NetworkPolicy", "pgsql-ingress");
  quiescedPolicy.metadata.uid = originalPolicy.metadata.uid;
  quiescedPolicy.metadata.resourceVersion = "materialize-quiesced-pgsql-ingress";
  quiescedPolicy.metadata.annotations = {
    ...(originalPolicy.metadata.annotations || {}),
    [pgsqlBarrierMarkers.lockUid]: barrier.lockUid,
    [pgsqlBarrierMarkers.operationToken]: intent.operationToken,
    [pgsqlBarrierMarkers.operationBinding]: intent.operationBindingSha256,
    [pgsqlBarrierMarkers.state]: "closed",
    [pgsqlBarrierMarkers.normalSpec]: barrier.normalSpecSha256
  };
  quiescedPolicy.spec = pgsqlClosedSpec();
}

function fixture(t, suffix = "fixture") {
  const root = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    `yenhubs-aud065-materialize-${suffix}-`
  ));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operationDirectory = path.join(root, "operation");
  initProcessLocalRotationOperation({
    parentDirectory: root,
    operationDirectory,
    rotationRevision: revision,
    randomBytes: deterministicRandom()
  });
  const quiesced = quiescedBaseline();
  const original = originalBaselineFrom(quiesced);
  const paths = {
    operationDirectory,
    originalBaselinePath: path.join(operationDirectory, "original-baseline.json"),
    quiescedBaselinePath: path.join(operationDirectory, "quiesced-baseline.json"),
    oldSnapshotPath: path.join(operationDirectory, "old-snapshot.json"),
    newSnapshotPath: path.join(operationDirectory, "new-snapshot.json"),
    oldValuesSourcePath: path.join(operationDirectory, "old-values-source.yaml"),
    newValuesSourcePath: path.join(operationDirectory, "new-values-source.yaml"),
    revisionPath: path.join(operationDirectory, "revision.json"),
    operationKeyPath: path.join(operationDirectory, "operation.key"),
    bundleDirectory: path.join(operationDirectory, "bundle"),
    bundlePath: path.join(operationDirectory, "bundle", "bundle.json"),
    bindingPath: path.join(operationDirectory, "bundle", "binding.json"),
    liveBaselinePath: path.join(operationDirectory, "live.json"),
    outputDirectory: path.join(operationDirectory, "replacements"),
    outputPath: path.join(operationDirectory, "applied-list.json")
  };
  writePrivateJson(paths.originalBaselinePath, {
    apiVersion: "v1",
    kind: "List",
    items: original
  });
  writePrivateJson(paths.oldSnapshotPath, snapshotValues(oldSecrets, oldPullConfig));
  writePrivateJson(paths.newSnapshotPath, snapshotValues(newSecrets, newPullConfig));
  writePrivateJson(paths.oldValuesSourcePath, { fixture: "old-source" });
  writePrivateJson(paths.newValuesSourcePath, { fixture: "new-source" });
  sealProcessLocalRotationOperation({
    operationDirectory,
    metadata: {
      expectedKubeContext: "materialize-fixture-context",
      namespaceName: namespace,
      namespaceUid: "materialize-fixture-namespace-uid",
      retPvcName: "ret-pvc",
      retPvcUid: "materialize-fixture-pvc-uid",
      checkpointStamp: "20260718-120000",
      checkpointDumpSha256: "1".repeat(64),
      checkpointStorageSha256: "2".repeat(64),
      checkpointInventorySha256: "3".repeat(64),
      checkpointRunnerEvidenceSha256: "4".repeat(64),
      checkpointRuntimeGeneration: "legacy-absent",
      profileId: profile.profile_id,
      profileSha256: sha256(Buffer.from(canonicalJson(profile), "utf8"))
    }
  });
  const intent = loadVerifiedProcessLocalRotationIntent({ operationDirectory });
  const originalPolicy = findResource(original, "NetworkPolicy", "pgsql-ingress");
  const barrier = {
    policyUid: originalPolicy.metadata.uid,
    policyResourceVersion: originalPolicy.metadata.resourceVersion,
    policyMetadataSha256: pgsqlPolicyMetadataSha256(originalPolicy),
    normalSpecSha256: sha256(Buffer.from(canonicalJson(pgsqlNormalSpec()), "utf8")),
    lockUid: "materialize-lock-uid"
  };
  writeProcessLocalBarrierBinding({ operationDirectory, barrier });
  closeQuiescedPgsqlPolicy(quiesced, original, intent, barrier);
  writePrivateJson(paths.quiescedBaselinePath, {
    apiVersion: "v1",
    kind: "List",
    items: quiesced
  });
  prepareOfflineProcessLocalRotation(paths);
  const bundle = JSON.parse(fs.readFileSync(paths.bundlePath, "utf8"));
  const authenticatedQuiesced = JSON.parse(
    fs.readFileSync(paths.quiescedBaselinePath, "utf8")
  ).items;
  const targets = targetResources(authenticatedQuiesced)
    .map(resource => structuredClone(resource));
  const candidates = targets.map(baselineResource =>
    projectProcessLocalRotationReplacement({ baselineResource, bundle, profile }));
  writePrivateJson(paths.liveBaselinePath, authenticatedQuiesced);
  return {
    root,
    paths,
    original,
    quiesced: authenticatedQuiesced,
    intent,
    barrier,
    bundle,
    targets,
    candidates
  };
}

function appliedCandidate(candidate, baseline, index) {
  const result = structuredClone(candidate);
  result.metadata.resourceVersion = `materialized-applied-rv-${index + 1}`;
  result.metadata.managedFields = [{ manager: "kubectl-replace", operation: "Update" }];
  if (result.kind === "Deployment") {
    result.metadata.generation = baseline.metadata.generation + 1;
    result.status = { observedGeneration: result.metadata.generation, replicas: 0 };
  } else if (result.stringData) {
    result.data = Object.fromEntries(Object.entries(result.stringData).map(([key, value]) => [
      key,
      Buffer.from(value, "utf8").toString("base64")
    ]));
    delete result.stringData;
  }
  return result;
}

function liveAfterAppliedCount(state, count) {
  const live = structuredClone(state.quiesced);
  const baselines = targetResources(state.quiesced);
  for (let index = 0; index < count; index += 1) {
    const target = baselines[index];
    const replacement = appliedCandidate(state.candidates[index], target, index);
    const targetIndex = live.findIndex(resource =>
      resource.apiVersion === target.apiVersion && resource.kind === target.kind &&
      resource.metadata.namespace === target.metadata.namespace &&
      resource.metadata.name === target.metadata.name
    );
    live[targetIndex] = replacement;
  }
  return live;
}

function materializeOptions(state, outputDirectory = state.paths.outputDirectory) {
  return {
    operationDirectory: state.paths.operationDirectory,
    quiescedBaselinePath: state.paths.quiescedBaselinePath,
    bundlePath: state.paths.bundlePath,
    bindingPath: state.paths.bindingPath,
    operationKeyPath: state.paths.operationKeyPath,
    outputDirectory
  };
}

function classifyOptions(state) {
  return {
    operationDirectory: state.paths.operationDirectory,
    quiescedBaselinePath: state.paths.quiescedBaselinePath,
    bundlePath: state.paths.bundlePath,
    bindingPath: state.paths.bindingPath,
    operationKeyPath: state.paths.operationKeyPath,
    liveBaselinePath: state.paths.liveBaselinePath
  };
}

function expectFailure(fn, code) {
  let captured;
  assert.throws(fn, error => {
    captured = error;
    return error instanceof MaterializeProcessLocalRotationError;
  });
  assert.equal(captured.code, code);
  assert.match(captured.causeCode || "", /^(?:[a-z0-9_]+)?$/u);
  return captured;
}

function commonCliArguments(command, state) {
  return [
    cliPath,
    command,
    "--operation-directory", state.paths.operationDirectory,
    "--quiesced-baseline", state.paths.quiescedBaselinePath,
    "--bundle", state.paths.bundlePath,
    "--binding", state.paths.bindingPath,
    "--operation-key", state.paths.operationKeyPath,
    "--expected-operation-id", state.intent.operationId,
    "--expected-operation-binding-sha256",
    state.intent.operationBindingSha256
  ];
}

test("materializes and verifies the eight canonical CAS replacements in profile order", t => {
  const state = fixture(t, "happy");
  assert.equal(materializeProcessLocalRotationReplacements(materializeOptions(state)), true);
  const directoryStat = fs.lstatSync(state.paths.outputDirectory);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(directoryStat.isSymbolicLink(), false);
  assert.deepEqual(fs.readdirSync(state.paths.outputDirectory).sort(), replacementNames);

  const actual = replacementNames.map((name, index) => {
    const artifactPath = path.join(state.paths.outputDirectory, name);
    const stat = fs.lstatSync(artifactPath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
    const bytes = fs.readFileSync(artifactPath);
    const parsed = JSON.parse(bytes);
    assert.equal(bytes.equals(Buffer.from(`${canonicalJson(parsed)}\n`, "utf8")), true);
    assert.deepEqual(parsed, state.candidates[index]);
    assert.equal(parsed.status, undefined);
    assert.equal(parsed.metadata.managedFields, undefined);
    assert.equal(parsed.metadata.generation, undefined);
    if (parsed.kind === "Deployment") assert.equal(parsed.spec.replicas, 0);
    return `${parsed.kind}/${parsed.metadata.name}`;
  });
  assert.deepEqual(actual, [
    "Secret/configs",
    `Secret/${profile.legacy_image_pull.secret.name}`,
    ...profile.rotation_revision_deployments.map(name => `Deployment/${name}`)
  ]);
  const secret = JSON.parse(fs.readFileSync(
    path.join(state.paths.outputDirectory, replacementNames[0]),
    "utf8"
  ));
  assert.equal(secret.type, "Opaque");
  assert.notEqual(secret.immutable, true);
  assert.equal(secret.metadata.annotations, undefined);
  const pullSecret = JSON.parse(fs.readFileSync(
    path.join(state.paths.outputDirectory, replacementNames[1]),
    "utf8"
  ));
  assert.equal(pullSecret.type, profile.legacy_image_pull.secret.type);
  assert.deepEqual(pullSecret.data, {
    [profile.legacy_image_pull.secret.data_key]: newPullConfig
  });
  assert.equal(pullSecret.metadata.annotations, undefined);
  assert.equal(
    state.quiesced.some(resource => resource.metadata.name === "bot-images-pull"),
    false
  );
  assert.equal(verifyProcessLocalRotationReplacements(materializeOptions(state)), true);
});

test("rejects truncated, noncanonical and baseline-drifted inputs before publication", t => {
  const truncated = fixture(t, "truncated");
  rewritePrivateText(truncated.paths.quiescedBaselinePath, "{\"kind\":\"List\",\"items\":[");
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(truncated)),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(fs.existsSync(truncated.paths.outputDirectory), false);

  const noncanonical = fixture(t, "noncanonical");
  rewritePrivateText(
    noncanonical.paths.bundlePath,
    `${canonicalJson(noncanonical.bundle)} \n`
  );
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(noncanonical)),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(fs.existsSync(noncanonical.paths.outputDirectory), false);

  const drifted = fixture(t, "bundle-drift");
  const changed = structuredClone(drifted.quiesced);
  findResource(changed, "Deployment", "dialog").metadata.resourceVersion = "drifted-rv";
  rewritePrivateJson(drifted.paths.quiescedBaselinePath, changed);
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(drifted)),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(fs.existsSync(drifted.paths.outputDirectory), false);
});

test("verify detects replacement tampering and later bundle drift", t => {
  const state = fixture(t, "verify-tamper");
  materializeProcessLocalRotationReplacements(materializeOptions(state));
  const target = path.join(state.paths.outputDirectory, replacementNames[2]);
  const bytes = fs.readFileSync(target);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  rewritePrivateText(target, bytes);
  expectFailure(
    () => verifyProcessLocalRotationReplacements(materializeOptions(state)),
    "process_local_rotation_verify_failed"
  );

  const fresh = fixture(t, "verify-bundle-drift");
  materializeProcessLocalRotationReplacements(materializeOptions(fresh));
  const bundle = structuredClone(fresh.bundle);
  bundle.contract.liveResourceBindings.find(binding =>
    binding.kind === "Deployment" && binding.name === "dialog"
  ).resourceVersion = "different-rv";
  rewritePrivateText(fresh.paths.bundlePath, `${canonicalJson(bundle)}\n`);
  expectFailure(
    () => verifyProcessLocalRotationReplacements(materializeOptions(fresh)),
    "process_local_rotation_verify_failed"
  );
});

test("authenticates intent, operation key, binding HMAC and exact bound input bytes", t => {
  const bindingTamper = fixture(t, "binding-hmac");
  const binding = JSON.parse(fs.readFileSync(bindingTamper.paths.bindingPath, "utf8"));
  binding.applyAttestationSha256 = "a".repeat(64);
  rewritePrivateText(bindingTamper.paths.bindingPath, `${canonicalJson(binding)}\n`);
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(bindingTamper)),
    "process_local_rotation_materialize_failed"
  );

  const keyTamper = fixture(t, "operation-key");
  const key = fs.readFileSync(keyTamper.paths.operationKeyPath);
  key[0] ^= 1;
  rewritePrivateText(keyTamper.paths.operationKeyPath, key);
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(keyTamper)),
    "process_local_rotation_materialize_failed"
  );

  const baselineTamper = fixture(t, "bound-baseline");
  const baseline = JSON.parse(fs.readFileSync(
    baselineTamper.paths.quiescedBaselinePath,
    "utf8"
  ));
  findResource(baseline.items, "Deployment", "dialog").metadata.resourceVersion += "-x";
  rewritePrivateJson(baselineTamper.paths.quiescedBaselinePath, baseline);
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(baselineTamper)),
    "process_local_rotation_materialize_failed"
  );

  const wrongLayout = fixture(t, "layout");
  const bindingAlias = path.join(wrongLayout.paths.operationDirectory, "binding-alias.json");
  fs.copyFileSync(wrongLayout.paths.bindingPath, bindingAlias);
  fs.chmodSync(bindingAlias, 0o600);
  expectFailure(
    () => materializeProcessLocalRotationReplacements({
      ...materializeOptions(wrongLayout),
      bindingPath: bindingAlias
    }),
    "process_local_rotation_materialize_failed"
  );
});

test("consumes authenticated in-memory inputs and detects mutation during a pinned read", t => {
  const afterAuthentication = fixture(t, "toctou-after-auth");
  let changed = false;
  assert.equal(materializeProcessLocalRotationReplacements({
    ...materializeOptions(afterAuthentication),
    hooks: {
      afterAuthenticatedInputs() {
        changed = true;
        rewritePrivateText(afterAuthentication.paths.bundlePath, "{}\n");
      }
    }
  }), true);
  assert.equal(changed, true);
  const emittedCandidate = JSON.parse(fs.readFileSync(
    path.join(afterAuthentication.paths.outputDirectory, replacementNames[2]),
    "utf8"
  ));
  assert.deepEqual(emittedCandidate, afterAuthentication.candidates[2]);
  expectFailure(
    () => verifyProcessLocalRotationReplacements(materializeOptions(afterAuthentication)),
    "process_local_rotation_verify_failed"
  );

  const duringRead = fixture(t, "toctou-during-read");
  let injected = false;
  expectFailure(
    () => materializeProcessLocalRotationReplacements({
      ...materializeOptions(duringRead),
      hooks: {
        afterPrivateFileFirstRead(event) {
          if (!injected && event.name === "binding.json") {
            injected = true;
            rewritePrivateText(duringRead.paths.bindingPath, "{}\n");
          }
        }
      }
    }),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(injected, true);
  assert.equal(fs.existsSync(duringRead.paths.outputDirectory), false);
});

test("ancestor directory link churn does not cause a false TOCTOU failure", t => {
  const state = fixture(t, "ancestor-churn");
  let changed = false;
  assert.equal(materializeProcessLocalRotationReplacements({
    ...materializeOptions(state),
    hooks: {
      afterPrivateFileFirstRead(event) {
        if (!changed && event.name === "operation.key") {
          changed = true;
          fs.mkdirSync(path.join(state.paths.operationDirectory, "concurrent-sibling"), {
            mode: 0o700
          });
        }
      }
    }
  }), true);
  assert.equal(changed, true);
});

test("classifies pending and every partial or fully applied cut without leaking payloads", t => {
  const state = fixture(t, "classify-cuts");
  const secretValueKeys = [
    ...profile.required_rotated_secret_keys,
    ...profile.rotate_if_configured_secret_keys
  ];
  const forbidden = [
    ...secretValueKeys.map(key => newSecrets[key]),
    permsMaterial(newPermsKey).jwt,
    oldPullConfig,
    oldLivePullConfig,
    newPullConfig,
    state.bundle.contract.databaseCredentialChecksum,
    state.bundle.contract.botAccessKeyChecksum,
    state.bundle.contract.permsPublicKeySha256,
    ...Object.values(profile.annotations)
  ].filter(value => typeof value === "string" && value.length > 0);
  for (let appliedCount = 0; appliedCount <= 8; appliedCount += 1) {
    rewritePrivateJson(
      state.paths.liveBaselinePath,
      { apiVersion: "v1", kind: "List", items: liveAfterAppliedCount(state, appliedCount) }
    );
    const plan = classifyProcessLocalRotationFiles(classifyOptions(state));
    assert.equal(plan.resourceCount, 8);
    assert.equal(plan.pendingCount, 8 - appliedCount);
    assert.equal(plan.alreadyAppliedCount, appliedCount);
    assert.equal(plan.complete, appliedCount === 8);
    assert.deepEqual(
      plan.resources.map(resource => resource.state),
      [
        ...Array.from({ length: appliedCount }, () => "already-applied"),
        ...Array.from({ length: 8 - appliedCount }, () => "pending")
      ]
    );
    for (const resource of plan.resources) {
      assert.deepEqual(Object.keys(resource).sort(), [
        "apiVersion",
        "baselineResourceVersion",
        "kind",
        "liveResourceVersion",
        "name",
        "namespace",
        "state",
        "uid"
      ]);
    }
    const serialized = canonicalJson(plan);
    assert.equal(forbidden.some(value => serialized.includes(value)), false);
    assert.equal(serialized.includes("data"), false);
    assert.equal(serialized.includes("stringData"), false);
    assert.equal(serialized.includes("annotations"), false);
    assert.equal(serialized.includes("fingerprint"), false);
  }
});

test("classification fails closed on target and bind-only GHCR drift or ABA", t => {
  const mutations = [
    live => {
      findResource(live, "Deployment", "dialog").metadata.uid = "replacement-uid";
    },
    live => {
      findResource(live, "Deployment", "dialog").metadata.resourceVersion = "advanced-aba";
    },
    live => {
      findResource(live, "Deployment", "dialog").metadata.labels = { drift: "true" };
    },
    live => {
      findResource(live, "Secret", "configs").stringData.DB_PASS += "-tampered";
    },
    live => {
      findResource(
        live,
        "Secret",
        profile.legacy_image_pull.secret.name
      ).metadata.uid = "replacement-pull-secret-uid";
    },
    live => {
      const pullSecret = findResource(
        live,
        "Secret",
        profile.legacy_image_pull.secret.name
      );
      pullSecret.data[profile.legacy_image_pull.secret.data_key] = encodedPullConfig(
        "materialize-fixture-user",
        "materialize-foreign-pull-token"
      );
    },
    live => {
      findResource(
        live,
        "Secret",
        profile.legacy_image_pull.secret.name
      ).metadata.resourceVersion = "advanced-pull-secret-aba";
    },
    live => {
      findResource(
        live,
        "ServiceAccount",
        profile.legacy_image_pull.service_account.name
      ).metadata.uid = "replacement-service-account-uid";
    },
    live => {
      findResource(
        live,
        "ServiceAccount",
        profile.legacy_image_pull.service_account.name
      ).metadata.resourceVersion = "advanced-service-account-rv";
    },
    live => {
      findResource(
        live,
        "ServiceAccount",
        profile.legacy_image_pull.service_account.name
      ).imagePullSecrets = [{ name: "foreign-pull" }];
    }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const state = fixture(t, `classify-drift-${index}`);
    const live = structuredClone(state.quiesced);
    mutate(live);
    rewritePrivateJson(state.paths.liveBaselinePath, live);
    const error = expectFailure(
      () => classifyProcessLocalRotationFiles(classifyOptions(state)),
      "process_local_rotation_classify_failed"
    );
    assert.equal(JSON.stringify(error).includes(newSecrets.DB_PASS), false);
    assert.equal(JSON.stringify(error).includes(oldPullConfig), false);
    assert.equal(JSON.stringify(error).includes(newPullConfig), false);
  }
});

test("enforces private modes, link rules, symlink-free paths and exclusive output", t => {
  const permissive = fixture(t, "mode");
  fs.chmodSync(permissive.paths.quiescedBaselinePath, 0o644);
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(permissive)),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(fs.existsSync(permissive.paths.outputDirectory), false);

  const hardlinked = fixture(t, "hardlink");
  fs.linkSync(hardlinked.paths.bundlePath, path.join(hardlinked.root, "bundle.alias"));
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(hardlinked)),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(fs.existsSync(hardlinked.paths.outputDirectory), false);

  const symlinked = fixture(t, "symlink-component");
  const alias = `${symlinked.root}-alias`;
  fs.symlinkSync(symlinked.root, alias);
  t.after(() => fs.rmSync(alias, { force: true }));
  expectFailure(
    () => materializeProcessLocalRotationReplacements({
      ...materializeOptions(symlinked),
      quiescedBaselinePath: path.join(alias, "quiesced.json")
    }),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(fs.existsSync(symlinked.paths.outputDirectory), false);

  const existing = fixture(t, "existing");
  fs.mkdirSync(existing.paths.outputDirectory, { mode: 0o700 });
  const marker = path.join(existing.paths.outputDirectory, "foreign-marker");
  fs.writeFileSync(marker, "preserve", { mode: 0o600 });
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(existing)),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "preserve");

  const parentMode = fixture(t, "parent-mode");
  fs.chmodSync(parentMode.root, 0o755);
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(parentMode)),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(fs.existsSync(parentMode.paths.outputDirectory), false);
});

test("crash cuts are resumable and pre-link temps are preserved outside final inventory", t => {
  for (const hookName of [
    "afterArtifactOpened",
    "afterArtifactPartialWrite",
    "afterArtifactFsync",
    "afterArtifactLinked"
  ]) {
    const state = fixture(t, `crash-${hookName}`);
    let injected = false;
    expectFailure(
      () => materializeProcessLocalRotationReplacements({
        ...materializeOptions(state),
        hooks: {
          [hookName](event) {
            if (!injected && event.name === replacementNames[0]) {
              injected = true;
              throw new Error(`injected ${hookName}`);
            }
          }
        }
      }),
      "process_local_rotation_materialize_failed"
    );
    assert.equal(injected, true);
    const pendingBefore = fs.readdirSync(state.paths.operationDirectory)
      .filter(name => name.startsWith(
        `.pending-replacements-${replacementNames[0]}.`
      ));
    assert.equal(pendingBefore.length, 1);
    assert.equal(
      materializeProcessLocalRotationReplacements(materializeOptions(state)),
      true
    );
    assert.deepEqual(fs.readdirSync(state.paths.outputDirectory).sort(), replacementNames);
    const pendingAfter = fs.readdirSync(state.paths.operationDirectory)
      .filter(name => name.startsWith(
        `.pending-replacements-${replacementNames[0]}.`
      ));
    assert.equal(
      pendingAfter.length,
      hookName === "afterArtifactLinked" ? 0 : 1
    );
  }
});

test("pending-path substitution is detected and the foreign inode is never unlinked", t => {
  const state = fixture(t, "pending-swap");
  let cut = false;
  expectFailure(
    () => materializeProcessLocalRotationReplacements({
      ...materializeOptions(state),
      hooks: {
        afterArtifactLinked(event) {
          if (!cut && event.name === replacementNames[0]) {
            cut = true;
            throw new Error("leave linked publication cut");
          }
        }
      }
    }),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(cut, true);
  let swapped = false;
  let foreignPath;
  let ownedPath;
  expectFailure(
    () => materializeProcessLocalRotationReplacements({
      ...materializeOptions(state),
      hooks: {
        beforePendingUnlink(event) {
          if (!swapped && event.name === replacementNames[0]) {
            swapped = true;
            foreignPath = event.path;
            ownedPath = `${event.path}.owned`;
            fs.renameSync(event.path, ownedPath);
            writePrivateText(event.path, "foreign-preserve");
          }
        }
      }
    }),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(foreignPath, "utf8"), "foreign-preserve");
  assert.equal(fs.existsSync(ownedPath), true);
  assert.equal(
    fs.lstatSync(ownedPath).ino,
    fs.lstatSync(path.join(state.paths.outputDirectory, replacementNames[0])).ino
  );
});

test("partial failure preserves unknown entries without deleting completed outputs", { concurrency: false }, t => {
  const state = fixture(t, "partial-cleanup");
  let injected = false;
  expectFailure(
    () => materializeProcessLocalRotationReplacements({
      ...materializeOptions(state),
      hooks: {
        afterArtifactLinked(event) {
          if (!injected && event.name === replacementNames[2]) {
            injected = true;
            writePrivateText(
              path.join(state.paths.outputDirectory, "foreign-marker"),
              "preserve"
            );
            throw new Error("injected linked cut");
          }
        }
      }
    }),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(injected, true);
  expectFailure(
    () => materializeProcessLocalRotationReplacements(materializeOptions(state)),
    "process_local_rotation_materialize_failed"
  );
  assert.equal(
    fs.readFileSync(path.join(state.paths.outputDirectory, "foreign-marker"), "utf8"),
    "preserve"
  );
  for (const name of replacementNames) {
    assert.equal(fs.existsSync(path.join(state.paths.outputDirectory, name)), true);
  }
});

test("extract-applied writes an exclusive canonical eight-resource List only when complete", t => {
  const pending = fixture(t, "extract-pending");
  expectFailure(
    () => extractAppliedProcessLocalRotationResources({
      ...classifyOptions(pending),
      outputPath: pending.paths.outputPath
    }),
    "process_local_rotation_extract_applied_failed"
  );
  assert.equal(fs.existsSync(pending.paths.outputPath), false);

  const complete = fixture(t, "extract-complete");
  const live = liveAfterAppliedCount(complete, 8);
  rewritePrivateJson(complete.paths.liveBaselinePath, {
    apiVersion: "v1",
    kind: "List",
    items: live
  });
  assert.equal(extractAppliedProcessLocalRotationResources({
    ...classifyOptions(complete),
    outputPath: complete.paths.outputPath
  }), true);
  const stat = fs.lstatSync(complete.paths.outputPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  const bytes = fs.readFileSync(complete.paths.outputPath);
  const evidence = JSON.parse(bytes);
  assert.equal(bytes.equals(Buffer.from(`${canonicalJson(evidence)}\n`, "utf8")), true);
  assert.equal(evidence.apiVersion, "v1");
  assert.equal(evidence.kind, "List");
  assert.deepEqual(
    evidence.items.map(resource => `${resource.kind}/${resource.metadata.name}`),
    [
      "Secret/configs",
      `Secret/${profile.legacy_image_pull.secret.name}`,
      ...profile.rotation_revision_deployments.map(name => `Deployment/${name}`)
    ]
  );
  assert.deepEqual(evidence.items, targetResources(live));
  assert.equal(extractAppliedProcessLocalRotationResources({
    ...classifyOptions(complete),
    outputPath: complete.paths.outputPath
  }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(complete.paths.outputPath)), evidence);
});

test("extract-applied resumes every private-file publication cut", t => {
  for (const hookName of [
    "afterArtifactOpened",
    "afterArtifactPartialWrite",
    "afterArtifactFsync",
    "afterArtifactLinked"
  ]) {
    const state = fixture(t, `extract-${hookName}`);
    rewritePrivateJson(state.paths.liveBaselinePath, {
      apiVersion: "v1",
      kind: "List",
      items: liveAfterAppliedCount(state, 8)
    });
    let injected = false;
    expectFailure(
      () => extractAppliedProcessLocalRotationResources({
        ...classifyOptions(state),
        outputPath: state.paths.outputPath,
        hooks: {
          [hookName](event) {
            if (!injected && event.name === path.basename(state.paths.outputPath)) {
              injected = true;
              throw new Error(`injected ${hookName}`);
            }
          }
        }
      }),
      "process_local_rotation_extract_applied_failed"
    );
    assert.equal(injected, true);
    assert.equal(extractAppliedProcessLocalRotationResources({
      ...classifyOptions(state),
      outputPath: state.paths.outputPath
    }), true);
    assert.equal(fs.existsSync(state.paths.outputPath), true);
    const pending = fs.readdirSync(state.paths.operationDirectory).filter(name =>
      name.startsWith(`.pending-${path.basename(state.paths.outputPath)}.`)
    );
    assert.equal(pending.length, hookName === "afterArtifactLinked" ? 0 : 1);
  }
});

test("emit-verified returns the exact authenticated artifact buffer without reopening it", t => {
  const state = fixture(t, "emit-api");
  materializeProcessLocalRotationReplacements(materializeOptions(state));
  const name = replacementNames[3];
  const artifactPath = path.join(state.paths.outputDirectory, name);
  const expected = fs.readFileSync(artifactPath);
  let changed = false;
  const emitted = emitVerifiedProcessLocalRotationReplacement({
    ...materializeOptions(state),
    name,
    hooks: {
      afterVerifiedArtifact(event) {
        assert.equal(event.name, name);
        changed = true;
        rewritePrivateText(artifactPath, "{}\n");
      }
    }
  });
  assert.equal(changed, true);
  assert.equal(Buffer.isBuffer(emitted), true);
  assert.equal(emitted.equals(expected), true);
  assert.equal(emitted.equals(fs.readFileSync(artifactPath)), false);
  expectFailure(
    () => emitVerifiedProcessLocalRotationReplacement({
      ...materializeOptions(state),
      name
    }),
    "process_local_rotation_emit_verified_failed"
  );

  const invalid = fixture(t, "emit-invalid-name");
  materializeProcessLocalRotationReplacements(materializeOptions(invalid));
  expectFailure(
    () => emitVerifiedProcessLocalRotationReplacement({
      ...materializeOptions(invalid),
      name: "../operation.key"
    }),
    "process_local_rotation_emit_verified_failed"
  );
});

test("operational attestation is built only from authenticated intent, barrier and bundle inputs", t => {
  const state = fixture(t, "operational-attestation");
  const outputPath = path.join(state.paths.operationDirectory, "operational-attestation.json");
  const options = { ...materializeOptions(state), outputPath };
  assert.equal(writeProcessLocalOperationalAttestation(options), true);
  assert.equal(writeProcessLocalOperationalAttestation(options), true);
  const value = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const inputs = loadVerifiedProcessLocalOperationalAttestationInputs(
    materializeOptions(state)
  );
  assert.equal(value.operationBindingSha256, inputs.operationBindingSha256);
  assert.equal(value.bundleBindingHmacSha256, inputs.bundleBindingHmacSha256);
  assert.equal(value.operationId, inputs.operationId);
  assert.equal(value.lockUid, state.barrier.lockUid);
  assert.equal(
    value.authenticatedContractState,
    "bundle-and-barrier-authenticated"
  );
  assert.equal(fs.readFileSync(outputPath, "utf8"), `${canonicalJson(value)}\n`);

  const cliOutput = path.join(state.paths.operationDirectory, "operational-attestation-cli.json");
  const cli = spawnSync(process.execPath, [
    attestationCliPath,
    "--operation-directory", state.paths.operationDirectory,
    "--quiesced-baseline", state.paths.quiescedBaselinePath,
    "--bundle", state.paths.bundlePath,
    "--binding", state.paths.bindingPath,
    "--operation-key", state.paths.operationKeyPath,
    "--expected-operation-id", state.intent.operationId,
    "--expected-operation-binding-sha256",
    state.intent.operationBindingSha256,
    "--output", cliOutput
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr, "");
  assert.equal(fs.readFileSync(cliOutput, "utf8"), fs.readFileSync(outputPath, "utf8"));
});

test("CLI materialize/verify/extract are silent, classify is safe and emit writes exact bytes", t => {
  const state = fixture(t, "cli");
  const materialize = spawnSync(process.execPath, [
    ...commonCliArguments("materialize", state),
    "--output-directory", state.paths.outputDirectory
  ], { encoding: "utf8" });
  assert.equal(materialize.status, 0);
  assert.equal(materialize.stdout, "");
  assert.equal(materialize.stderr, "");

  const verify = spawnSync(process.execPath, [
    ...commonCliArguments("verify", state),
    "--output-directory", state.paths.outputDirectory
  ], { encoding: "utf8" });
  assert.equal(verify.status, 0);
  assert.equal(verify.stdout, "");
  assert.equal(verify.stderr, "");

  const emittedName = replacementNames[4];
  const emitted = spawnSync(process.execPath, [
    ...commonCliArguments("emit-verified", state),
    "--output-directory", state.paths.outputDirectory,
    "--name", emittedName,
    "--stream-purpose", "coordinator-cas-stream"
  ]);
  assert.equal(emitted.status, 0);
  assert.equal(emitted.stderr.length, 0);
  assert.equal(
    emitted.stdout.equals(fs.readFileSync(
      path.join(state.paths.outputDirectory, emittedName)
    )),
    true
  );

  const unacknowledgedSecretStream = spawnSync(process.execPath, [
    ...commonCliArguments("emit-verified", state),
    "--output-directory", state.paths.outputDirectory,
    "--name", replacementNames[1]
  ]);
  assert.equal(unacknowledgedSecretStream.status, 1);
  assert.equal(unacknowledgedSecretStream.stdout.length, 0);
  assert.equal(
    unacknowledgedSecretStream.stderr.toString("utf8"),
    "process-local rotation replacement operation failed closed\n"
  );

  const classify = spawnSync(process.execPath, [
    ...commonCliArguments("classify", state),
    "--live-baseline", state.paths.liveBaselinePath
  ], { encoding: "utf8" });
  assert.equal(classify.status, 0);
  assert.equal(classify.stderr, "");
  const plan = JSON.parse(classify.stdout);
  assert.equal(classify.stdout, `${canonicalJson(plan)}\n`);
  for (const sensitive of [
    ...profile.required_rotated_secret_keys.map(key => newSecrets[key]),
    ...profile.rotate_if_configured_secret_keys.map(key => newSecrets[key]),
    permsMaterial(newPermsKey).jwt
  ]) {
    assert.equal(classify.stdout.includes(sensitive), false);
  }

  const attestationInputs = loadVerifiedProcessLocalOperationalAttestationInputs(
    materializeOptions(state)
  );
  assert.deepEqual(Object.keys(attestationInputs).sort(), [
    "bundleBindingHmacSha256",
    "checkpointDumpSha256",
    "checkpointInventorySha256",
    "checkpointStamp",
    "checkpointStorageSha256",
    "expectedKubeContext",
    "namespaceName",
    "namespaceUid",
    "operationBindingSha256",
    "operationId",
    "retPvcName",
    "retPvcUid"
  ]);
  const emittedAttestationInputs = spawnSync(process.execPath, [
    ...commonCliArguments("emit-attestation-inputs", state)
  ], { encoding: "utf8" });
  assert.equal(emittedAttestationInputs.status, 0, emittedAttestationInputs.stderr);
  assert.equal(emittedAttestationInputs.stderr, "");
  assert.equal(
    emittedAttestationInputs.stdout,
    `${canonicalJson(attestationInputs)}\n`
  );

  const deploymentContract = emitVerifiedProcessLocalDeploymentContract({
    ...materializeOptions(state),
    deployment: "reticulum"
  }).toString("utf8");
  const deployment = state.candidates.find(candidate =>
    candidate.kind === "Deployment" && candidate.metadata.name === "reticulum"
  );
  const baseline = state.targets.find(target =>
    target.kind === "Deployment" && target.metadata.name === "reticulum"
  );
  const expectedFingerprint = Buffer.from(canonicalJson({
    selector: deployment.spec.selector,
    strategy: deployment.spec.strategy || {},
    template: deployment.spec.template
  }), "utf8").toString("base64");
  assert.equal(deploymentContract, [
    deployment.metadata.uid,
    baseline.metadata.resourceVersion,
    "0",
    "reticulum",
    expectedFingerprint
  ].join("\t") + "\n");
  const emittedDeploymentContract = spawnSync(process.execPath, [
    ...commonCliArguments("emit-deployment-contract", state),
    "--deployment", "reticulum"
  ], { encoding: "utf8" });
  assert.equal(emittedDeploymentContract.status, 0, emittedDeploymentContract.stderr);
  assert.equal(emittedDeploymentContract.stderr, "");
  assert.equal(emittedDeploymentContract.stdout, deploymentContract);

  rewritePrivateJson(state.paths.liveBaselinePath, liveAfterAppliedCount(state, 8));
  const extract = spawnSync(process.execPath, [
    ...commonCliArguments("extract-applied", state),
    "--live-baseline", state.paths.liveBaselinePath,
    "--output", state.paths.outputPath
  ], { encoding: "utf8" });
  assert.equal(extract.status, 0);
  assert.equal(extract.stdout, "");
  assert.equal(extract.stderr, "");

  const failed = spawnSync(process.execPath, [
    ...commonCliArguments("classify", state),
    "--live-baseline", path.join(state.root, newSecrets.DB_PASS)
  ], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.equal(
    failed.stderr,
    "process-local rotation replacement operation failed closed\n"
  );
  assert.equal(failed.stderr.includes(newSecrets.DB_PASS), false);

  const invalidEmit = spawnSync(process.execPath, [
    ...commonCliArguments("emit-verified", state),
    "--output-directory", state.paths.outputDirectory,
    "--name", "not-allowlisted.json",
    "--stream-purpose", "coordinator-cas-stream"
  ], { encoding: "utf8" });
  assert.equal(invalidEmit.status, 1);
  assert.equal(invalidEmit.stdout, "");
  assert.equal(
    invalidEmit.stderr,
    "process-local rotation replacement operation failed closed\n"
  );

  const foreignIdentityArgs = commonCliArguments("emit-verified", state);
  foreignIdentityArgs[
    foreignIdentityArgs.indexOf("--expected-operation-id") + 1
  ] = "f".repeat(32);
  const foreignIdentity = spawnSync(process.execPath, [
    ...foreignIdentityArgs,
    "--output-directory", state.paths.outputDirectory,
    "--name", emittedName,
    "--stream-purpose", "coordinator-cas-stream"
  ]);
  assert.equal(foreignIdentity.status, 1);
  assert.equal(foreignIdentity.stdout.length, 0);
  assert.equal(
    foreignIdentity.stderr.toString("utf8"),
    "process-local rotation replacement operation failed closed\n"
  );
});

test("source has no command execution, Kubernetes client or sensitive filename derivation", () => {
  const source = fs.readFileSync(cliPath, "utf8");
  assert.equal(source.includes("node:child_process"), false);
  assert.equal(source.includes("kubectl"), false);
  assert.equal(source.includes("execSync"), false);
  assert.equal(source.includes("spawnSync"), false);
  assert.equal(source.includes("rotationRevision}.json"), false);
});

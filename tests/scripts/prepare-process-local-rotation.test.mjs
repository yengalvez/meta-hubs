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
  OfflineProcessLocalRotationError,
  prepareOfflineProcessLocalRotation,
  verifyOfflineProcessLocalRotation,
  verifyOfflineProcessLocalRotationPlan
} from "../../deployment/prepare-process-local-rotation.mjs";
import {
  canonicalJson,
  loadProcessLocalRotationProfile
} from "../../deployment/process-local-rotation.mjs";
import {
  canonicalOperationJson,
  initProcessLocalRotationOperation,
  loadVerifiedProcessLocalBarrierBinding,
  loadVerifiedProcessLocalRotationIntent,
  writeProcessLocalBarrierBinding,
  sealProcessLocalRotationOperation
} from "../../deployment/process-local-rotation-operation.mjs";

const profile = loadProcessLocalRotationProfile();
const namespace = "hcce";
const revision = "aud065-offlinefixture";
const cliPath = path.resolve("deployment/prepare-process-local-rotation.mjs");
const artifactNames = [
  "binding.json",
  "bundle.json",
  "redacted.json",
  "restart-contract.json"
];
const operationMetadata = Object.freeze({
  expectedKubeContext: "fixture-context",
  namespaceName: namespace,
  namespaceUid: "fixture-namespace-uid",
  retPvcName: "ret-pvc",
  retPvcUid: "fixture-ret-pvc-uid",
  checkpointStamp: "20260718-170405",
  checkpointDumpSha256: "a".repeat(64),
  checkpointStorageSha256: "b".repeat(64),
  checkpointInventorySha256: "c".repeat(64),
  profileId: profile.profile_id,
  profileSha256: sha256(Buffer.from(canonicalJson(profile), "utf8"))
});
const lockUid = "fixture-aud065-operation-lock-uid";
const PGSQL_MARKERS = Object.freeze({
  lockUid: "yenhubs.org/aud065-pgsql-lock-uid",
  operationToken: "yenhubs.org/aud065-pgsql-operation-token",
  operationBinding: "yenhubs.org/aud065-pgsql-operation-binding-sha256",
  state: "yenhubs.org/aud065-pgsql-barrier-state",
  normalSpecSha256: "yenhubs.org/aud065-pgsql-normal-spec-sha256"
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
const oldSecrets = snapshotSecretValues("before", oldPermsKey);
const newSecrets = snapshotSecretValues("after", newPermsKey);
const oldPerms = permsMaterial(oldPermsKey);
const uniqueImageKeys = [...new Set(profile.image_pairs.map(pair => pair.value_key))];
const imageByValueKey = Object.fromEntries(uniqueImageKeys.map((valueKey, index) => [
  valueKey,
  `${profile.image_pairs.find(pair => pair.value_key === valueKey).repositories[0]}@sha256:${(index + 1).toString(16).repeat(64)}`
]));
const imageByPair = Object.fromEntries(profile.image_pairs.map(pair => [
  `${pair.deployment}/${pair.container}`,
  imageByValueKey[pair.value_key]
]));

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

function metadata(name, resourceVersion) {
  return {
    name,
    namespace,
    uid: `offline-fixture-uid-${name}`,
    resourceVersion: String(resourceVersion),
    generation: 1
  };
}

function envSecret(name, key) {
  return { name, valueFrom: { secretKeyRef: { name: "configs", key } } };
}

function deployment(name, containers, resourceVersion) {
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
      ...metadata(name, resourceVersion),
      annotations: { "fixture.invalid/deployment": "stable" }
    },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name }, annotations },
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
    status: { replicas: 1, readyReplicas: 1 }
  };
}

function retConfigText() {
  return Object.entries(profile.ret_config_placeholder_counts)
    .flatMap(([name, count]) => Array.from({ length: count }, () => `<${name}>`))
    .join("\n");
}

function completeHistoricalInventory(resources) {
  const key = resource => [
    resource.apiVersion,
    resource.kind,
    resource.metadata.namespace || "",
    resource.metadata.name
  ].join("\0");
  const existing = new Set(resources.map(key));
  for (const identity of profile.baseline_resource_identities) {
    const namespaceValue = identity.namespace === "$Namespace" ? namespace : undefined;
    const name = identity.name === "$Namespace" ? namespace : identity.name;
    const resource = {
      apiVersion: identity.apiVersion,
      kind: identity.kind,
      metadata: {
        name,
        ...(namespaceValue ? { namespace: namespaceValue } : {})
      }
    };
    if (!existing.has(key(resource))) resources.push(resource);
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

function pgsqlBaseMetadata(policy) {
  const annotations = structuredClone(policy.metadata.annotations || {});
  for (const marker of Object.values(PGSQL_MARKERS)) delete annotations[marker];
  return {
    labels: structuredClone(policy.metadata.labels || {}),
    annotations,
    ownerReferences: structuredClone(policy.metadata.ownerReferences || []),
    finalizers: structuredClone(policy.metadata.finalizers || [])
  };
}

function originalBaseline() {
  let resourceVersion = 100;
  const next = () => {
    resourceVersion += 1;
    return resourceVersion;
  };
  const secretMetadata = metadata("configs", next());
  delete secretMetadata.generation;
  const resources = completeHistoricalInventory([
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: namespace, uid: operationMetadata.namespaceUid }
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
      metadata: metadata("ret-config", next()),
      data: { "config.toml.template": retConfigText() }
    },
    deployment("bot-orchestrator", [{
      name: "bot-orchestrator", image: imageByPair["bot-orchestrator/bot-orchestrator"]
    }], next()),
    deployment("coturn", [{ name: "coturn", image: imageByPair["coturn/coturn"] }], next()),
    deployment("dialog", [{ name: "dialog", image: imageByPair["dialog/dialog"] }], next()),
    deployment("haproxy", [{ name: "haproxy", image: imageByPair["haproxy/haproxy"] }], next()),
    deployment("hubs", [{ name: "hubs", image: imageByPair["hubs/hubs"] }], next()),
    deployment("nearspark", [{
      name: "nearspark", image: imageByPair["nearspark/nearspark"]
    }], next()),
    deployment("pgbouncer", [{
      name: "pgbouncer", image: imageByPair["pgbouncer/pgbouncer"]
    }], next()),
    deployment("pgbouncer-t", [{
      name: "pgbouncer-t", image: imageByPair["pgbouncer-t/pgbouncer-t"]
    }], next()),
    deployment("photomnemonic", [{
      name: "photomnemonic", image: imageByPair["photomnemonic/photomnemonic"]
    }], next()),
    deployment("pgsql", [{
      name: "postgresql", image: imageByPair["pgsql/postgresql"]
    }], next()),
    deployment("reticulum", [
      { name: "reticulum", image: imageByPair["reticulum/reticulum"] },
      { name: "postgrest", image: imageByPair["reticulum/postgrest"] }
    ], next()),
    deployment("spoke", [{ name: "spoke", image: imageByPair["spoke/spoke"] }], next())
  ]);
  for (const resource of resources) {
    resource.metadata.uid ||= resource.kind === "Namespace"
      ? operationMetadata.namespaceUid
      : `offline-fixture-uid-${resource.kind.toLowerCase()}-${resource.metadata.name}`;
    resource.metadata.resourceVersion ||= String(next());
  }
  const policy = resources.find(resource =>
    resource.apiVersion === "networking.k8s.io/v1" &&
    resource.kind === "NetworkPolicy" &&
    resource.metadata.name === "pgsql-ingress"
  );
  policy.metadata.labels = { "fixture.invalid/policy": "pgsql-ingress" };
  policy.metadata.annotations = { "fixture.invalid/owner": "yenhubs" };
  policy.spec = pgsqlNormalSpec();
  return resources;
}

function quiescedBaseline(original, operationIntent, barrierBinding) {
  const quiesced = structuredClone(original);
  for (const resource of quiesced) {
    if (resource.kind === "Deployment" &&
        profile.rotation_revision_deployments.includes(resource.metadata.name)) {
      resource.spec.replicas = 0;
      resource.metadata.resourceVersion = String(Number(resource.metadata.resourceVersion) + 1000);
      resource.metadata.generation += 1;
      resource.status = { replicas: 0, readyReplicas: 0 };
    }
  }
  const policy = quiesced.find(resource =>
    resource.apiVersion === "networking.k8s.io/v1" &&
    resource.kind === "NetworkPolicy" &&
    resource.metadata.name === "pgsql-ingress"
  );
  policy.metadata.resourceVersion = `${policy.metadata.resourceVersion}-closed`;
  policy.metadata.annotations = {
    ...policy.metadata.annotations,
    [PGSQL_MARKERS.lockUid]: barrierBinding.lockUid,
    [PGSQL_MARKERS.operationToken]: operationIntent.operationToken,
    [PGSQL_MARKERS.operationBinding]: operationIntent.operationBindingSha256,
    [PGSQL_MARKERS.state]: "closed",
    [PGSQL_MARKERS.normalSpecSha256]: barrierBinding.normalSpecSha256
  };
  policy.spec = pgsqlClosedSpec();
  return quiesced;
}

function snapshotValues(values) {
  return {
    Namespace: namespace,
    ...structuredClone(values),
    ...structuredClone(imageByValueKey)
  };
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${canonicalOperationJson(value)}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  fs.chmodSync(filePath, 0o600);
}

function rewritePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${canonicalOperationJson(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function listValue(items) {
  return { apiVersion: "v1", kind: "List", items };
}

function deterministicRandom() {
  let value = 1;
  return size => Buffer.alloc(size, value++);
}

function fixture(t, suffix = "fixture", {
  mutateOriginal,
  mutateOldValues,
  mutateNewValues
} = {}) {
  const root = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    `yenhubs-aud065-${suffix}-`
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
  const original = originalBaseline();
  if (mutateOriginal) mutateOriginal(original);
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
    bundleDirectory: path.join(operationDirectory, "bundle")
  };
  const oldValues = snapshotValues(oldSecrets);
  const newValues = snapshotValues(newSecrets);
  if (mutateOldValues) mutateOldValues(oldValues);
  if (mutateNewValues) mutateNewValues(newValues);
  writePrivateJson(paths.originalBaselinePath, listValue(original));
  writePrivateJson(paths.oldSnapshotPath, oldValues);
  writePrivateJson(paths.newSnapshotPath, newValues);
  writePrivateJson(paths.oldValuesSourcePath, { fixture: "old-source" });
  writePrivateJson(paths.newValuesSourcePath, { fixture: "new-source" });
  sealProcessLocalRotationOperation({ operationDirectory, metadata: operationMetadata });
  const operationIntent = loadVerifiedProcessLocalRotationIntent({ operationDirectory });
  const policy = original.find(resource =>
    resource.apiVersion === "networking.k8s.io/v1" &&
    resource.kind === "NetworkPolicy" &&
    resource.metadata.name === "pgsql-ingress"
  );
  writeProcessLocalBarrierBinding({
    operationDirectory,
    policyUid: policy.metadata.uid,
    policyResourceVersion: policy.metadata.resourceVersion,
    policyMetadataSha256: sha256(Buffer.from(
      canonicalJson(pgsqlBaseMetadata(policy)), "utf8"
    )),
    normalSpecSha256: sha256(Buffer.from(canonicalJson(pgsqlNormalSpec()), "utf8")),
    lockUid
  });
  const barrierBinding = loadVerifiedProcessLocalBarrierBinding({ operationDirectory });
  const quiesced = quiescedBaseline(original, operationIntent, barrierBinding);
  writePrivateJson(paths.quiescedBaselinePath, listValue(quiesced));
  return { root, paths, original, quiesced };
}

function expectOfflineFailure(fn) {
  let captured;
  assert.throws(fn, error => {
    captured = error;
    return error instanceof OfflineProcessLocalRotationError;
  });
  assert.match(captured.code, /^offline_(?:prepare|verify|plan_verify)_failed$/u);
}

function cliArguments(command, paths) {
  return [
    cliPath,
    command,
    "--operation-directory", paths.operationDirectory,
    "--original-baseline", paths.originalBaselinePath,
    "--quiesced-baseline", paths.quiescedBaselinePath,
    "--old-snapshot", paths.oldSnapshotPath,
    "--new-snapshot", paths.newSnapshotPath,
    "--revision-file", paths.revisionPath,
    "--operation-key", paths.operationKeyPath,
    "--bundle-directory", paths.bundleDirectory
  ];
}

function planCliArguments(paths) {
  return [
    cliPath,
    "verify-plan",
    "--operation-directory", paths.operationDirectory,
    "--original-baseline", paths.originalBaselinePath,
    "--old-snapshot", paths.oldSnapshotPath,
    "--new-snapshot", paths.newSnapshotPath
  ];
}

test("prepares a private Secret-only bundle with separate restart and redacted records", t => {
  const { paths } = fixture(t, "prepare");
  assert.equal(prepareOfflineProcessLocalRotation(paths), true);
  assert.equal(fs.statSync(paths.bundleDirectory).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(paths.bundleDirectory).sort(), artifactNames);
  for (const name of artifactNames) {
    assert.equal(fs.statSync(path.join(paths.bundleDirectory, name)).mode & 0o777, 0o600);
  }

  const bundle = JSON.parse(fs.readFileSync(
    path.join(paths.bundleDirectory, "bundle.json"), "utf8"
  ));
  assert.deepEqual(
    bundle.resources.map(resource => `${resource.kind}/${resource.metadata.name}`),
    ["Secret/configs"]
  );
  assert.equal(bundle.contract.configMapInvariant, true);

  const restart = JSON.parse(fs.readFileSync(
    path.join(paths.bundleDirectory, "restart-contract.json"), "utf8"
  ));
  assert.equal(restart.bundleRestoresReplicas, false);
  assert.equal(restart.restorationPhase, "verified-callbacks-only");
  assert.equal(restart.deployments.length, 6);
  assert.equal(restart.deployments.every(item => item.originalReplicas === 1), true);

  const redacted = JSON.parse(fs.readFileSync(
    path.join(paths.bundleDirectory, "redacted.json"), "utf8"
  ));
  assert.equal(redacted.applyAttestation.allConsumersQuiesced, true);
  assert.equal(redacted.applyAttestation.bundleRestoresReplicas, false);
  assert.equal(redacted.applyAttestation.deployments.every(item => item.replicas === 0), true);
  assert.equal(redacted.applyAttestation.deployments.every(item =>
    item.uidBound === true && item.resourceVersionBound === true &&
    !Object.hasOwn(item, "uid") && !Object.hasOwn(item, "resourceVersion")
  ), true);
  assert.equal(redacted.placeholderConfigMap.action, "bind-existing-no-apply");
  assert.equal(Object.hasOwn(redacted, "sensitiveConfigMap"), false);
  assert.equal(Object.hasOwn(redacted, "desiredDeploymentAnnotations"), false);
  assert.equal(Object.hasOwn(redacted, "imagePairs"), false);
  assert.equal(Object.hasOwn(redacted, "databaseCredentialChecksum"), false);
  assert.equal(JSON.stringify(redacted).includes("@sha256:"), false);

  const binding = JSON.parse(fs.readFileSync(
    path.join(paths.bundleDirectory, "binding.json"), "utf8"
  ));
  const intent = JSON.parse(fs.readFileSync(
    path.join(paths.operationDirectory, "intent.json"), "utf8"
  ));
  assert.equal(binding.operationBindingSha256, intent.operationBindingSha256);

  assert.equal(verifyOfflineProcessLocalRotation(paths), true);
});

test("prepare repairs attributable publications and ignores pre-link staging orphans", t => {
  const state = fixture(t, "crash-reentry");
  assert.equal(prepareOfflineProcessLocalRotation(state.paths), true);
  assert.equal(prepareOfflineProcessLocalRotation(state.paths), true);

  const bundlePath = path.join(state.paths.bundleDirectory, "bundle.json");
  const linkedPending = path.join(
    state.paths.operationDirectory,
    `.bundle.json.pending-${"a".repeat(32)}`
  );
  fs.linkSync(bundlePath, linkedPending);
  assert.equal(fs.lstatSync(bundlePath).nlink, 2);
  assert.equal(verifyOfflineProcessLocalRotation(state.paths), true);
  assert.equal(fs.existsSync(linkedPending), false);
  assert.equal(fs.lstatSync(bundlePath).nlink, 1);

  const restartPath = path.join(state.paths.bundleDirectory, "restart-contract.json");
  fs.unlinkSync(restartPath);
  const partial = path.join(
    state.paths.operationDirectory,
    `.restart-contract.json.pending-${"b".repeat(32)}`
  );
  fs.writeFileSync(partial, "partial-private-artifact", { mode: 0o600 });
  fs.chmodSync(partial, 0o600);
  assert.equal(prepareOfflineProcessLocalRotation(state.paths), true);
  assert.equal(fs.existsSync(partial), true);
  assert.equal(fs.readFileSync(partial, "utf8"), "partial-private-artifact");
  assert.equal(fs.existsSync(restartPath), true);
  assert.equal(verifyOfflineProcessLocalRotation(state.paths), true);
  assert.deepEqual(fs.readdirSync(state.paths.bundleDirectory).sort(), artifactNames);
});

test("CLI prepare and verify are silent and accept paths only", t => {
  const { paths } = fixture(t, "cli");
  const prepare = spawnSync(process.execPath, cliArguments("prepare", paths), {
    encoding: "utf8"
  });
  assert.equal(prepare.status, 0);
  assert.equal(prepare.stdout, "");
  assert.equal(prepare.stderr, "");

  const verify = spawnSync(process.execPath, cliArguments("verify", paths), {
    encoding: "utf8"
  });
  assert.equal(verify.status, 0);
  assert.equal(verify.stdout, "");
  assert.equal(verify.stderr, "");
});

test("read-only plan verifier binds the exact running baseline without quiescence", t => {
  const { paths } = fixture(t, "plan-verify");
  const options = {
    operationDirectory: paths.operationDirectory,
    originalBaselinePath: paths.originalBaselinePath,
    oldSnapshotPath: paths.oldSnapshotPath,
    newSnapshotPath: paths.newSnapshotPath
  };
  assert.equal(verifyOfflineProcessLocalRotationPlan(options), true);
  const cli = spawnSync(process.execPath, planCliArguments(paths), { encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr, "");
});

test("plan verifier rejects a new DB_PASS outside the runtime rotation contract", t => {
  const { paths } = fixture(t, "plan-db-pass", {
    mutateNewValues: values => {
      values.DB_PASS = "too-short";
      values.PGRST_DB_URI =
        `postgres://${values.DB_USER}:${values.DB_PASS}@${values.DB_HOST}:5432/${values.DB_NAME}`;
      values.PSQL =
        `postgres://${values.DB_USER}:${values.DB_PASS}@pgsql:5432/${values.DB_NAME}`;
    }
  });
  assert.throws(() => verifyOfflineProcessLocalRotationPlan({
    operationDirectory: paths.operationDirectory,
    originalBaselinePath: paths.originalBaselinePath,
    oldSnapshotPath: paths.oldSnapshotPath,
    newSnapshotPath: paths.newSnapshotPath
  }), error => error instanceof OfflineProcessLocalRotationError &&
    error.code === "offline_plan_verify_failed" &&
    error.causeCode === "plan_new_db_password_invalid");
});

test("plan verifier rejects inventory, Secret, ret-config, image and pgsql-normal drift", t => {
  const mutations = new Map([
    ["inventory", resources => {
      resources.splice(resources.findIndex(resource =>
        resource.kind === "Service" && resource.metadata.name === "ret"
      ), 1);
    }],
    ["secret", resources => {
      resources.find(resource =>
        resource.kind === "Secret" && resource.metadata.name === "configs"
      ).stringData.DB_PASS = "foreign-database-password-with-sufficient-entropy";
    }],
    ["ret-config", resources => {
      const config = resources.find(resource =>
        resource.kind === "ConfigMap" && resource.metadata.name === "ret-config"
      );
      const placeholder = Object.keys(profile.ret_config_placeholder_counts)[0];
      config.data[profile.ret_config_data_key] = config.data[profile.ret_config_data_key]
        .replace(`<${placeholder}>`, "");
    }],
    ["image", resources => {
      resources.find(resource =>
        resource.kind === "Deployment" && resource.metadata.name === "dialog"
      ).spec.template.spec.containers[0].image =
        `ghcr.io/yengalvez/dialog@sha256:${"f".repeat(64)}`;
    }],
    ["replicas", resources => {
      resources.find(resource =>
        resource.kind === "Deployment" && resource.metadata.name === "dialog"
      ).spec.replicas = 2;
    }],
    ["pgsql", resources => {
      resources.find(resource =>
        resource.kind === "NetworkPolicy" && resource.metadata.name === "pgsql-ingress"
      ).spec = pgsqlClosedSpec();
    }]
  ]);
  for (const [name, mutateOriginal] of mutations) {
    const { paths } = fixture(t, `plan-${name}`, { mutateOriginal });
    expectOfflineFailure(() => verifyOfflineProcessLocalRotationPlan({
      operationDirectory: paths.operationDirectory,
      originalBaselinePath: paths.originalBaselinePath,
      oldSnapshotPath: paths.oldSnapshotPath,
      newSnapshotPath: paths.newSnapshotPath
    }));
  }
});

test("prepare accepts only the exact original-normal to quiesced-closed policy CAS", t => {
  const mutations = new Map([
    ["uid", policy => { policy.metadata.uid = "foreign-policy-uid"; }],
    ["resource-version", (policy, originalPolicy) => {
      policy.metadata.resourceVersion = originalPolicy.metadata.resourceVersion;
    }],
    ["marker", policy => {
      policy.metadata.annotations[PGSQL_MARKERS.operationToken] = "f".repeat(32);
    }],
    ["spec", policy => { policy.spec = pgsqlNormalSpec(); }],
    ["user-metadata", policy => {
      policy.metadata.labels["fixture.invalid/policy"] = "mutated";
    }],
    ["second-mutation", policy => {
      policy.spec.ingress = [{ from: [], ports: [] }];
      policy.metadata.annotations["fixture.invalid/second-mutation"] = "true";
    }]
  ]);
  for (const [name, mutate] of mutations) {
    const state = fixture(t, `policy-${name}`);
    const changed = structuredClone(state.quiesced);
    const policy = changed.find(resource =>
      resource.kind === "NetworkPolicy" && resource.metadata.name === "pgsql-ingress"
    );
    const originalPolicy = state.original.find(resource =>
      resource.kind === "NetworkPolicy" && resource.metadata.name === "pgsql-ingress"
    );
    mutate(policy, originalPolicy);
    rewritePrivateJson(state.paths.quiescedBaselinePath, listValue(changed));
    expectOfflineFailure(() => prepareOfflineProcessLocalRotation(state.paths));
    assert.equal(fs.existsSync(state.paths.bundleDirectory), false);
  }
});

test("server metadata and status churn do not weaken desired-state invariants", t => {
  const state = fixture(t, "server-metadata-churn");
  const changed = structuredClone(state.quiesced);
  const policy = changed.find(resource =>
    resource.kind === "NetworkPolicy" && resource.metadata.name === "pgsql-ingress"
  );
  policy.metadata.generation = 9;
  policy.metadata.managedFields = [{ manager: "fixture-controller" }];
  policy.status = { observedGeneration: 9 };
  const service = changed.find(resource =>
    resource.kind === "Service" && resource.metadata.name === "ret"
  );
  service.metadata.resourceVersion = `${service.metadata.resourceVersion}-controller`;
  service.metadata.generation = 7;
  service.metadata.managedFields = [{ manager: "fixture-controller" }];
  service.status = { loadBalancer: {} };
  rewritePrivateJson(state.paths.quiescedBaselinePath, listValue(changed));
  assert.equal(prepareOfflineProcessLocalRotation(state.paths), true);
  assert.equal(verifyOfflineProcessLocalRotation(state.paths), true);
});

test("rejects non-0600 and symlinked private inputs without publishing output", t => {
  const permissive = fixture(t, "mode");
  fs.chmodSync(permissive.paths.oldSnapshotPath, 0o644);
  expectOfflineFailure(() => prepareOfflineProcessLocalRotation(permissive.paths));
  assert.equal(fs.existsSync(permissive.paths.bundleDirectory), false);

  const linked = fixture(t, "symlink");
  const revisionTarget = path.join(linked.root, "revision-target.json");
  fs.renameSync(linked.paths.revisionPath, revisionTarget);
  fs.symlinkSync(revisionTarget, linked.paths.revisionPath);
  expectOfflineFailure(() => prepareOfflineProcessLocalRotation(linked.paths));
  assert.equal(fs.existsSync(linked.paths.bundleDirectory), false);
});

test("rejects hardlinked inputs, operation keys and artifacts", t => {
  const linkedInput = fixture(t, "hardlink-input");
  fs.linkSync(
    linkedInput.paths.oldSnapshotPath,
    path.join(linkedInput.root, "old.alias")
  );
  expectOfflineFailure(() => prepareOfflineProcessLocalRotation(linkedInput.paths));
  assert.equal(fs.existsSync(linkedInput.paths.bundleDirectory), false);

  const linkedKey = fixture(t, "hardlink-key");
  fs.linkSync(
    linkedKey.paths.operationKeyPath,
    path.join(linkedKey.root, "operation.alias")
  );
  expectOfflineFailure(() => prepareOfflineProcessLocalRotation(linkedKey.paths));
  assert.equal(fs.existsSync(linkedKey.paths.bundleDirectory), false);

  const linkedArtifact = fixture(t, "hardlink-artifact");
  prepareOfflineProcessLocalRotation(linkedArtifact.paths);
  fs.linkSync(
    path.join(linkedArtifact.paths.bundleDirectory, "bundle.json"),
    path.join(linkedArtifact.root, "bundle.alias")
  );
  expectOfflineFailure(() => verifyOfflineProcessLocalRotation(linkedArtifact.paths));
});

test("sealed intent, operation key and original/old/new source hashes fail closed", t => {
  const tamperedIntent = fixture(t, "intent-hmac");
  const intentPath = path.join(tamperedIntent.paths.operationDirectory, "intent.json");
  const intent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
  intent.hmacSha256 = "0".repeat(64);
  rewritePrivateJson(intentPath, intent);
  expectOfflineFailure(() => prepareOfflineProcessLocalRotation(tamperedIntent.paths));
  assert.equal(fs.existsSync(tamperedIntent.paths.bundleDirectory), false);

  const foreignKey = fixture(t, "foreign-key");
  fs.writeFileSync(foreignKey.paths.operationKeyPath, Buffer.alloc(32, 0x7f), {
    mode: 0o600
  });
  fs.chmodSync(foreignKey.paths.operationKeyPath, 0o600);
  expectOfflineFailure(() => prepareOfflineProcessLocalRotation(foreignKey.paths));
  assert.equal(fs.existsSync(foreignKey.paths.bundleDirectory), false);

  for (const source of ["original", "old", "new"]) {
    const changed = fixture(t, `sealed-${source}`);
    if (source === "original") {
      const resources = structuredClone(changed.original);
      resources.find(resource => resource.kind === "ConfigMap").data.extra = "drift";
      rewritePrivateJson(changed.paths.originalBaselinePath, listValue(resources));
    } else {
      const sourcePath = source === "old"
        ? changed.paths.oldSnapshotPath
        : changed.paths.newSnapshotPath;
      const values = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      values.ADM_EMAIL = `${source}@tampered.invalid`;
      rewritePrivateJson(sourcePath, values);
    }
    expectOfflineFailure(() => prepareOfflineProcessLocalRotation(changed.paths));
    assert.equal(fs.existsSync(changed.paths.bundleDirectory), false);
  }
});

test("refuses an existing output directory and never deletes it", t => {
  const { paths } = fixture(t, "exclusive");
  fs.mkdirSync(paths.bundleDirectory, { mode: 0o700 });
  const marker = path.join(paths.bundleDirectory, "owner-marker");
  fs.writeFileSync(marker, "preserve", { mode: 0o600 });
  expectOfflineFailure(() => prepareOfflineProcessLocalRotation(paths));
  assert.equal(fs.readFileSync(marker, "utf8"), "preserve");
});

for (const artifact of artifactNames) {
  test(`verify rejects tampering of ${artifact}`, t => {
    const { paths } = fixture(t, `tamper-${artifact.replace(/\W/gu, "-")}`);
    prepareOfflineProcessLocalRotation(paths);
    const artifactPath = path.join(paths.bundleDirectory, artifact);
    const bytes = fs.readFileSync(artifactPath);
    bytes[0] ^= 1;
    fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
    fs.chmodSync(artifactPath, 0o600);
    expectOfflineFailure(() => verifyOfflineProcessLocalRotation(paths));
  });
}

test("verify rejects a stale quiesced resourceVersion", t => {
  const fixtureState = fixture(t, "stale-rv");
  prepareOfflineProcessLocalRotation(fixtureState.paths);
  const changed = structuredClone(fixtureState.quiesced);
  const dialog = changed.find(resource =>
    resource.kind === "Deployment" && resource.metadata.name === "dialog"
  );
  dialog.metadata.resourceVersion = String(Number(dialog.metadata.resourceVersion) + 1);
  rewritePrivateJson(fixtureState.paths.quiescedBaselinePath, listValue(changed));
  expectOfflineFailure(() => verifyOfflineProcessLocalRotation(fixtureState.paths));
});

test("prepare rejects APPLY input with any affected replica above zero", t => {
  const fixtureState = fixture(t, "running");
  const changed = structuredClone(fixtureState.quiesced);
  changed.find(resource =>
    resource.kind === "Deployment" && resource.metadata.name === "dialog"
  ).spec.replicas = 1;
  rewritePrivateJson(fixtureState.paths.quiescedBaselinePath, listValue(changed));
  expectOfflineFailure(() => prepareOfflineProcessLocalRotation(fixtureState.paths));
  assert.equal(fs.existsSync(fixtureState.paths.bundleDirectory), false);
});

test("prepare rejects image, spec and contractual metadata drift between captures", t => {
  for (const drift of ["image", "spec", "metadata"]) {
    const fixtureState = fixture(t, `drift-${drift}`);
    const changed = structuredClone(fixtureState.quiesced);
    const dialog = changed.find(resource =>
      resource.kind === "Deployment" && resource.metadata.name === "dialog"
    );
    if (drift === "image") {
      dialog.spec.template.spec.containers[0].image =
        `ghcr.io/yengalvez/dialog@sha256:${"f".repeat(64)}`;
    } else if (drift === "spec") {
      dialog.spec.strategy = { type: "RollingUpdate" };
    } else {
      dialog.metadata.labels = { changed: "true" };
    }
    rewritePrivateJson(fixtureState.paths.quiescedBaselinePath, listValue(changed));
    expectOfflineFailure(() => prepareOfflineProcessLocalRotation(fixtureState.paths));
    assert.equal(fs.existsSync(fixtureState.paths.bundleDirectory), false);
  }
});

test("source has no external execution or AUD-075 manifest path", () => {
  const source = fs.readFileSync(cliPath, "utf8");
  assert.equal(source.includes("node:child_process"), false);
  assert.equal(source.includes("execSync"), false);
  assert.equal(source.includes("spawnSync"), false);
  assert.equal(source.includes("hcce-bot-runners"), false);
  assert.equal(source.includes("hcce.yaml"), false);
});

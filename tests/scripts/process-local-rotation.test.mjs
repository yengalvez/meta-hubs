import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  ProcessLocalRotationError,
  applyProcessLocalRotationAnnotations,
  canonicalJson,
  classifyProcessLocalRotationReentry,
  createProcessLocalRotationBundle,
  loadProcessLocalRotationProfile,
  projectProcessLocalRotationReplacement,
  redactProcessLocalRotationBundle,
  verifyProcessLocalRotationBundle
} from "../../deployment/process-local-rotation.mjs";

const profile = loadProcessLocalRotationProfile();
const namespace = "hcce";
const revision = "aud065-fixture001";
const cloudPackageRequire = createRequire(
  path.resolve("hubs-cloud/community-edition/package.json")
);
const { parseAllDocuments } = cloudPackageRequire("yaml");

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

function permsMaterial(encodedKey) {
  const privateKey = createPrivateKey(encodedKey.replace(/\\+n/gu, "\n"));
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  return {
    jwt: JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e }),
    fingerprint: sha256(publicKey.export({ type: "spki", format: "der" }))
  };
}

function runtimePrivateKey(encodedKey) {
  return encodedKey.replace(/\\+n/gu, "\n").trim().replace(/\n/gu, "\\\\n");
}

const oldPermsKey = encodedPrivateKey();
const newPermsKey = encodedPrivateKey();
const oldPerms = permsMaterial(oldPermsKey);

const uniqueValueKeys = [...new Set([
  ...profile.image_pairs.map(pair => pair.value_key),
  ...profile.legacy_image_pull.verified_image_value_keys
])];
const imageByValueKey = Object.fromEntries(uniqueValueKeys.map((valueKey, index) => [
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

const oldSnapshotSecrets = snapshotSecretValues("before", oldPermsKey);
const newSnapshotSecrets = snapshotSecretValues("after", newPermsKey);
const oldLiveSecrets = {
  ...structuredClone(oldSnapshotSecrets),
  PERMS_KEY: runtimePrivateKey(oldSnapshotSecrets.PERMS_KEY),
  PGRST_JWT_SECRET: oldPerms.jwt
};

function encodedPullConfig(username, token, spacing = 0) {
  return Buffer.from(JSON.stringify({
    auths: {
      "ghcr.io": {
        auth: Buffer.from(`${username}:${token}`, "utf8").toString("base64")
      }
    }
  }, null, spacing), "utf8").toString("base64");
}

const oldPullConfig = encodedPullConfig("fixture-user", "old-pull-token-value");
const oldLivePullConfig = encodedPullConfig(
  "fixture-user", "old-pull-token-value", 2
);
const newPullConfig = encodedPullConfig("fixture-user", "new-pull-token-value");

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

function envSecret(name, key) {
  return { name, valueFrom: { secretKeyRef: { name: "configs", key } } };
}

let resourceVersion = 100;

function metadata(name) {
  resourceVersion += 1;
  return {
    name,
    namespace,
    uid: `fixture-uid-${name}`,
    resourceVersion: String(resourceVersion)
  };
}

function baselineAnnotations(name) {
  const annotations = { "fixture.invalid/stable": "true" };
  if (profile.db_checksum_deployments.includes(name)) {
    annotations[profile.annotations.database_checksum] = databaseChecksum(oldSnapshotSecrets);
  }
  if (profile.bot_access_checksum_deployments.includes(name)) {
    annotations[profile.annotations.bot_access_key_checksum] =
      sha256(oldSnapshotSecrets.BOT_ACCESS_KEY);
  }
  return annotations;
}

function deployment(name, containers, { env = [] } = {}) {
  const projectedContainers = containers.map((container, index) => {
    const secretEnv = profile.secret_env_bindings
      .filter(binding => binding.deployment === name && binding.container === container.name)
      .map(binding => envSecret(binding.env, binding.key));
    const selectedEnv = [
      ...secretEnv,
      ...(index === 0 ? structuredClone(env) : [])
    ];
    return {
      name: container.name,
      image: container.image,
      ...(selectedEnv.length > 0 ? { env: selectedEnv } : {})
    };
  });
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      ...metadata(name),
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
          containers: projectedContainers
        }
      }
    },
    status: { observedGeneration: 7 }
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
  for (const resource of resources) {
    resource.metadata.uid ??=
      `fixture-uid-${resource.kind.toLowerCase()}-${resource.metadata.name}`;
    resource.metadata.resourceVersion ??= String(++resourceVersion);
  }
  return resources;
}

function baselineResources() {
  resourceVersion = 100;
  const deployments = [
    deployment("bot-orchestrator", [{
      name: "bot-orchestrator",
      image: imageByPair["bot-orchestrator/bot-orchestrator"]
    }], {
      env: [
        { name: "RUNNER_AUTOSTART", value: "true" },
        { name: "RUNNER_BACKEND", value: "ghost" }
      ]
    }),
    deployment("coturn", [{ name: "coturn", image: imageByPair["coturn/coturn"] }]),
    deployment("dialog", [{ name: "dialog", image: imageByPair["dialog/dialog"] }]),
    deployment("haproxy", [{ name: "haproxy", image: imageByPair["haproxy/haproxy"] }]),
    deployment("hubs", [{ name: "hubs", image: imageByPair["hubs/hubs"] }]),
    deployment("nearspark", [{ name: "nearspark", image: imageByPair["nearspark/nearspark"] }]),
    deployment("pgbouncer", [{
      name: "pgbouncer", image: imageByPair["pgbouncer/pgbouncer"]
    }]),
    deployment("pgbouncer-t", [{
      name: "pgbouncer-t", image: imageByPair["pgbouncer-t/pgbouncer-t"]
    }]),
    deployment("photomnemonic", [{
      name: "photomnemonic", image: imageByPair["photomnemonic/photomnemonic"]
    }]),
    deployment("pgsql", [{ name: "postgresql", image: imageByPair["pgsql/postgresql"] }]),
    deployment("reticulum", [
      { name: "reticulum", image: imageByPair["reticulum/reticulum"] },
      { name: "postgrest", image: imageByPair["reticulum/postgrest"] }
    ]),
    deployment("spoke", [{ name: "spoke", image: imageByPair["spoke/spoke"] }])
  ];
  const resources = completeHistoricalInventory([
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: namespace }
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata("configs"),
      type: "Opaque",
      stringData: structuredClone(oldLiveSecrets)
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata("ret-config"),
      data: { "config.toml.template": retConfigText() }
    },
    ...deployments
  ]);
  resources.push(
    {
      apiVersion: profile.legacy_image_pull.secret.apiVersion,
      kind: profile.legacy_image_pull.secret.kind,
      metadata: metadata(profile.legacy_image_pull.secret.name),
      type: profile.legacy_image_pull.secret.type,
      data: {
        [profile.legacy_image_pull.secret.data_key]: oldLivePullConfig
      }
    },
    {
      apiVersion: profile.legacy_image_pull.service_account.apiVersion,
      kind: profile.legacy_image_pull.service_account.kind,
      metadata: metadata(profile.legacy_image_pull.service_account.name),
      imagePullSecrets: structuredClone(
        profile.legacy_image_pull.service_account.image_pull_secrets
      )
    }
  );
  return resources;
}

function values(snapshot, pullConfig) {
  return {
    Namespace: namespace,
    ...structuredClone(snapshot),
    ...structuredClone(imageByValueKey),
    [profile.legacy_image_pull.snapshot_value_key]: pullConfig
  };
}

function fixture() {
  return {
    baselineResources: baselineResources(),
    oldValues: values(oldSnapshotSecrets, oldPullConfig),
    newValues: values(newSnapshotSecrets, newPullConfig),
    rotationRevision: revision,
    profile
  };
}

function historicalLastApplied(secret) {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: secret.metadata.name, namespace: secret.metadata.namespace },
    stringData: structuredClone(secret.stringData)
  });
}

function expectCode(fn, code) {
  let captured;
  assert.throws(fn, error => {
    captured = error;
    return error instanceof ProcessLocalRotationError;
  });
  assert.equal(captured.code, code);
}

function findResource(resources, kind, name) {
  return resources.find(resource =>
    resource.kind === kind && resource.metadata.name === name
  );
}

function stripManagedAnnotations(resource) {
  const result = structuredClone(resource);
  const annotations = result.spec?.template?.metadata?.annotations;
  if (annotations) {
    for (const key of Object.values(profile.annotations)) delete annotations[key];
    if (Object.keys(annotations).length === 0) {
      delete result.spec.template.metadata.annotations;
    }
  }
  return result;
}

function reentryFixture() {
  const input = fixture();
  const bundle = createProcessLocalRotationBundle(input);
  const targets = [
    structuredClone(findResource(input.baselineResources, "Secret", "configs")),
    structuredClone(findResource(
      input.baselineResources,
      "Secret",
      profile.legacy_image_pull.secret.name
    )),
    ...profile.rotation_revision_deployments.map(name =>
      structuredClone(findResource(input.baselineResources, "Deployment", name)))
  ];
  const candidates = [
    ...targets.map(baselineResource =>
      projectProcessLocalRotationReplacement({
        baselineResource,
        bundle,
        profile
      }))
  ];
  return { input, bundle, targets, candidates };
}

function identity(resource) {
  return [
    resource.apiVersion,
    resource.kind,
    resource.metadata.namespace || "",
    resource.metadata.name
  ].join("\0");
}

function expandTargetLiveResources(state, targetResources) {
  const replacements = new Map(targetResources.map(resource => [identity(resource), resource]));
  return state.input.baselineResources.map(resource =>
    structuredClone(replacements.get(identity(resource)) || resource));
}

function appliedCandidate(candidate, baseline, index) {
  const result = structuredClone(candidate);
  result.metadata.resourceVersion = `applied-${index + 1}`;
  result.metadata.managedFields = [{
    manager: "kubectl-replace",
    operation: "Update",
    time: "2026-07-18T12:00:00Z"
  }];
  if (result.kind === "Deployment") {
    result.metadata.generation = baseline.metadata.generation + 1;
    result.status = {
      observedGeneration: baseline.metadata.generation,
      replicas: 0
    };
  } else if (result.stringData) {
    result.data = Object.fromEntries(Object.entries(result.stringData).map(([key, value]) => [
      key,
      Buffer.from(value, "utf8").toString("base64")
    ]));
    delete result.stringData;
  }
  return result;
}

function classifyReentry(state) {
  const liveResources = state.liveResources.length === state.targets.length
    ? expandTargetLiveResources(state, state.liveResources)
    : state.liveResources;
  return classifyProcessLocalRotationReentry({
    baselineResources: state.input.baselineResources,
    liveResources,
    bundle: state.bundle,
    profile
  });
}

test("pins the exact historical 22-key process-local Secret contract", () => {
  assert.deepEqual(profile.baseline_provenance, {
    cloud_source_commit: "5a82de5387d7296cd01470d5136b2c07c2d5c7ac",
    historical_generated_resource_count: 42
  });
  assert.equal(profile.namespace_value_key, "Namespace");
  assert.equal(profile.baseline_resource_identities.length, 42);
  assert.equal(profile.secret_keys.length, 22);
  assert.deepEqual(
    profile.secret_keys.filter(key => profile.forbidden.secret_domain_keys.includes(key)),
    []
  );
  assert.deepEqual(profile.forbidden.secret_domain_keys.sort(), [
    "BOT_ORCHESTRATOR_ACCESS_KEY",
    "BOT_RUNNER_ACCESS_KEY",
    "DASHBOARD_ACCESS_KEY"
  ]);
  assert.equal(profile.required_deployments.length, 12);
  assert.equal(profile.image_pairs.length, 13);
  assert.deepEqual(profile.legacy_image_pull, {
    snapshot_value_key: "BOT_IMAGE_PULL_CONFIG_JSON_BASE64",
    verified_image_value_keys: [
      "OVERRIDE_BOT_ORCHESTRATOR_IMAGE",
      "OVERRIDE_BOT_RUNNER_IMAGE"
    ],
    secret: {
      apiVersion: "v1",
      kind: "Secret",
      name: "ghcr-pull",
      type: "kubernetes.io/dockerconfigjson",
      data_key: ".dockerconfigjson"
    },
    service_account: {
      apiVersion: "v1",
      kind: "ServiceAccount",
      name: "default",
      image_pull_secrets: [{ name: "ghcr-pull" }]
    }
  });
});

test("matches all 42 identities in the independently parsed historical Cloud template", () => {
  const provenance = profile.baseline_provenance;
  const template = execFileSync(
    "git",
    [
      "-C",
      "hubs-cloud",
      "show",
      `${provenance.cloud_source_commit}:community-edition/generate_script/hcce.yam`
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  const documents = parseAllDocuments(template);
  assert.equal(documents.length, provenance.historical_generated_resource_count);
  assert.deepEqual(documents.flatMap(document => document.errors), []);
  const identities = documents.map(document => {
    const resource = document.toJSON();
    return {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      namespace: resource.metadata.namespace ?? null,
      name: resource.metadata.name
    };
  });
  assert.deepEqual(identities, profile.baseline_resource_identities);
});

test("rejects every relaxed or substituted historical profile contract", () => {
  const mutations = [
    candidate => {
      candidate.baseline_provenance.cloud_source_commit = "0".repeat(40);
    },
    candidate => {
      candidate.baseline_provenance.historical_generated_resource_count = 41;
    },
    candidate => {
      candidate.namespace_value_key = "namespace";
    },
    candidate => {
      candidate.baseline_resource_identities.pop();
    },
    candidate => {
      candidate.required_deployments.reverse();
    },
    candidate => {
      candidate.secret_keys[0] = "RELAXED_KEY";
    },
    candidate => {
      candidate.ret_config_placeholder_counts.ADM_EMAIL = 2;
    },
    candidate => {
      candidate.secret_env_bindings[0].env = "RELAXED_ENV";
    },
    candidate => {
      candidate.image_pairs[0].repositories.push("registry.invalid/relaxed");
    },
    candidate => {
      candidate.forbidden.resource_names = [];
    },
    candidate => {
      candidate.forbidden.annotation_keys = [];
    },
    candidate => {
      candidate.forbidden.secret_domain_keys = [];
    },
    candidate => {
      candidate.forbidden.bot_orchestrator_env_names = [];
    },
    candidate => {
      candidate.legacy_image_pull.secret.name = "relaxed-pull";
    },
    candidate => {
      candidate.legacy_image_pull.service_account.image_pull_secrets = [];
    }
  ];
  for (const mutate of mutations) {
    const input = fixture();
    input.profile = structuredClone(profile);
    mutate(input.profile);
    expectCode(() => createProcessLocalRotationBundle(input), "rotation_profile_invalid");
  }
});

test("snapshots accessor-backed profiles before validating their canonical contract", () => {
  const input = fixture();
  input.baselineResources.push({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "hcce-bot-runners" }
  });
  const accessorProfile = structuredClone(profile);
  const trusted = accessorProfile.forbidden;
  const relaxed = {
    resource_names: [],
    annotation_keys: [],
    secret_domain_keys: [],
    bot_orchestrator_env_names: []
  };
  let reads = 0;
  Object.defineProperty(accessorProfile, "forbidden", {
    enumerable: true,
    get() {
      reads += 1;
      return reads < 8 ? trusted : relaxed;
    }
  });
  input.profile = accessorProfile;
  expectCode(
    () => createProcessLocalRotationBundle(input),
    "aud075_resource_or_annotation_forbidden"
  );
  assert.equal(reads, 1);
});

test("projects two Secrets and binds both, ret-config, default and 12 Deployments for CAS", () => {
  const input = fixture();
  const bundle = createProcessLocalRotationBundle(input);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.runnerMode, "process-local");
  assert.deepEqual(
    bundle.resources.map(resource => `${resource.kind}/${resource.metadata.name}`).sort(),
    ["Secret/configs", "Secret/ghcr-pull"]
  );
  assert.equal(bundle.contract.liveResourceBindings.length, 16);
  assert.equal(bundle.contract.liveResourceBindings.every(binding =>
    binding.uid && binding.resourceVersion
  ), true);
  assert.deepEqual(bundle.contract.workloadChanges, []);
  assert.equal(bundle.contract.specInvariant, true);
  assert.equal(bundle.contract.configMapInvariant, true);
  assert.equal(bundle.contract.legacyLastAppliedRemoved, false);
  assert.equal(bundle.contract.retConfigBinding.name, "ret-config");
  assert.deepEqual(bundle.contract.legacyImagePull.serviceAccount, {
    name: "default",
    imagePullSecrets: [{ name: "ghcr-pull" }],
    action: "bind-existing-no-apply"
  });
  assert.deepEqual(
    bundle.contract.retConfigBinding.placeholderCounts,
    profile.ret_config_placeholder_counts
  );
  assert.deepEqual(bundle.contract.imagePairs, imageByPair);
  for (const resource of bundle.resources) {
    const baseline = findResource(input.baselineResources, resource.kind, resource.metadata.name);
    assert.equal(resource.metadata.uid, baseline.metadata.uid);
    assert.equal(resource.metadata.resourceVersion, baseline.metadata.resourceVersion);
  }
});

test("requires an explicit old snapshot matching every live Secret value", () => {
  const missing = fixture();
  delete missing.oldValues;
  expectCode(() => createProcessLocalRotationBundle(missing), "old_namespace_invalid");

  const drift = fixture();
  drift.oldValues.BOT_ACCESS_KEY = "different-old-snapshot-secret";
  expectCode(() => createProcessLocalRotationBundle(drift), "baseline_secret_snapshot_mismatch");

  const pullDrift = fixture();
  findResource(pullDrift.baselineResources, "Secret", "ghcr-pull")
    .data[".dockerconfigjson"] = encodedPullConfig("fixture-user", "wrong-live-token");
  expectCode(
    () => createProcessLocalRotationBundle(pullDrift),
    "legacy_pull_credential_contract_invalid"
  );

  const derivedDrift = fixture();
  derivedDrift.oldValues.PGRST_JWT_SECRET = "stale-derived-value";
  expectCode(() => createProcessLocalRotationBundle(derivedDrift), "old_derived_secret_mismatch");

  const liveDerivedDrift = fixture();
  findResource(liveDerivedDrift.baselineResources, "Secret", "configs")
    .stringData.PGRST_JWT_SECRET = "stale-live-derived-value";
  expectCode(
    () => createProcessLocalRotationBundle(liveDerivedDrift),
    "baseline_secret_snapshot_mismatch"
  );
});

test("requires exact private snapshot projections with no AUD-075 or unrelated keys", () => {
  for (const [name, value] of [
    ["BOT_RUNNER_ACCESS_KEY", "forbidden-runner-secret"],
    ["UNRELATED_VALUE", "unrelated"]
  ]) {
    const extraOld = fixture();
    extraOld.oldValues[name] = value;
    expectCode(() => createProcessLocalRotationBundle(extraOld), "old_values_keyset_invalid");

    const extraNew = fixture();
    extraNew.newValues[name] = value;
    expectCode(() => createProcessLocalRotationBundle(extraNew), "new_values_keyset_invalid");
  }

  const optionalDerived = fixture();
  optionalDerived.oldValues.PGRST_JWT_SECRET = oldLiveSecrets.PGRST_JWT_SECRET;
  optionalDerived.newValues.PGRST_JWT_SECRET = permsMaterial(newPermsKey).jwt;
  assert.equal(createProcessLocalRotationBundle(optionalDerived).resources.length, 2);
});

test("rotates the exact Secret while keeping placeholder ret-config non-applicable", () => {
  const input = fixture();
  const bundle = createProcessLocalRotationBundle(input);
  const secret = findResource(bundle.resources, "Secret", "configs");
  assert.equal(Object.keys(secret.stringData).length, 22);
  assert.equal(secret.stringData.DB_PASS, newSnapshotSecrets.DB_PASS);
  assert.equal(secret.stringData.PERMS_KEY, runtimePrivateKey(newSnapshotSecrets.PERMS_KEY));
  assert.equal(JSON.parse(secret.stringData.PGRST_JWT_SECRET).kty, "RSA");
  const pullSecret = findResource(bundle.resources, "Secret", "ghcr-pull");
  assert.equal(pullSecret.data[".dockerconfigjson"], newPullConfig);
  assert.equal(findResource(bundle.resources, "ConfigMap", "ret-config"), undefined);
  const config = findResource(input.baselineResources, "ConfigMap", "ret-config");
  assert.equal(config.data["config.toml.template"], retConfigText());
  assert.match(bundle.contract.databaseCredentialChecksum, /^[a-f0-9]{64}$/u);
  assert.match(bundle.contract.botAccessKeyChecksum, /^[a-f0-9]{64}$/u);
  assert.match(bundle.contract.permsPublicKeySha256, /^[a-f0-9]{64}$/u);
});

test("validates and removes the exact historical last-applied Secret payload", () => {
  const input = fixture();
  const baselineSecret = findResource(input.baselineResources, "Secret", "configs");
  baselineSecret.metadata.annotations = {
    "kubectl.kubernetes.io/last-applied-configuration": historicalLastApplied(baselineSecret)
  };
  baselineSecret.metadata.managedFields = [{
    manager: "kubectl-client-side-apply",
    operation: "Update"
  }];
  const baselinePullSecret = findResource(input.baselineResources, "Secret", "ghcr-pull");
  baselinePullSecret.metadata.annotations = {
    "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { annotations: {}, name: "ghcr-pull", namespace },
      type: "kubernetes.io/dockerconfigjson",
      data: structuredClone(baselinePullSecret.data)
    })
  };
  baselinePullSecret.metadata.managedFields = [{
    manager: "kubectl-client-side-apply",
    operation: "Update"
  }];
  const bundle = createProcessLocalRotationBundle(input);
  const projected = findResource(bundle.resources, "Secret", "configs");
  const projectedPull = findResource(bundle.resources, "Secret", "ghcr-pull");
  assert.equal(bundle.contract.legacyLastAppliedRemoved, true);
  assert.equal(projected.metadata.managedFields, undefined);
  assert.equal(projected.metadata.annotations, undefined);
  assert.equal(projectedPull.metadata.managedFields, undefined);
  assert.equal(projectedPull.metadata.annotations, undefined);
  assert.equal(projectedPull.data[".dockerconfigjson"], newPullConfig);
  assert.equal(JSON.stringify(projected).includes(oldSnapshotSecrets.GUARDIAN_KEY), false);

  const redacted = redactProcessLocalRotationBundle({
    ...input,
    bundle,
    fingerprintKey: Buffer.alloc(32, 9)
  });
  assert.equal(redacted.secret.legacyLastAppliedRemoved, true);
  assert.equal(JSON.stringify(redacted).includes(oldSnapshotSecrets.GUARDIAN_KEY), false);
});

test("rejects stale last-applied, unknown Secret annotations and immutable Secrets", () => {
  const stale = fixture();
  const staleSecret = findResource(stale.baselineResources, "Secret", "configs");
  const stalePayload = JSON.parse(historicalLastApplied(staleSecret));
  stalePayload.stringData.DB_PASS = "stale-password";
  staleSecret.metadata.annotations = {
    "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify(stalePayload)
  };
  expectCode(
    () => createProcessLocalRotationBundle(stale),
    "baseline_secret_last_applied_invalid"
  );

  const stalePull = fixture();
  const stalePullSecret = findResource(stalePull.baselineResources, "Secret", "ghcr-pull");
  stalePullSecret.metadata.annotations = {
    "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "ghcr-pull", namespace },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": newPullConfig }
    })
  };
  expectCode(
    () => createProcessLocalRotationBundle(stalePull),
    "baseline_pull_secret_last_applied_invalid"
  );

  const annotatedLastAppliedPull = fixture();
  const annotatedLastAppliedPullSecret = findResource(
    annotatedLastAppliedPull.baselineResources, "Secret", "ghcr-pull"
  );
  annotatedLastAppliedPullSecret.metadata.annotations = {
    "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        annotations: { "example.invalid/unknown": "value" },
        name: "ghcr-pull",
        namespace
      },
      type: "kubernetes.io/dockerconfigjson",
      data: structuredClone(annotatedLastAppliedPullSecret.data)
    })
  };
  expectCode(
    () => createProcessLocalRotationBundle(annotatedLastAppliedPull),
    "baseline_pull_secret_last_applied_invalid"
  );

  const annotated = fixture();
  findResource(annotated.baselineResources, "Secret", "configs")
    .metadata.annotations = { "example.invalid/unknown": "value" };
  expectCode(
    () => createProcessLocalRotationBundle(annotated),
    "baseline_secret_metadata_invalid"
  );

  const immutable = fixture();
  findResource(immutable.baselineResources, "Secret", "configs").immutable = true;
  expectCode(
    () => createProcessLocalRotationBundle(immutable),
    "baseline_secret_metadata_invalid"
  );
});

test("builds exact annotation maps and changes only those paths on a fresh zero Deployment", () => {
  const input = fixture();
  const bundle = createProcessLocalRotationBundle(input);
  const desired = bundle.contract.desiredDeploymentAnnotations;
  assert.deepEqual(Object.keys(desired).sort(), [...profile.rotation_revision_deployments].sort());
  assert.deepEqual(Object.keys(desired.reticulum).sort(), Object.values(profile.annotations).sort());
  assert.deepEqual(Object.keys(desired.dialog).sort(), [
    profile.annotations.credential_revision,
    profile.annotations.perms_public_key_sha256
  ].sort());
  for (const name of profile.rotation_revision_deployments) {
    const before = findResource(input.baselineResources, "Deployment", name);
    const after = applyProcessLocalRotationAnnotations({ deployment: before, bundle, profile });
    assert.equal(after.metadata.uid, before.metadata.uid);
    assert.equal(after.metadata.resourceVersion, before.metadata.resourceVersion);
    assert.equal(after.spec.replicas, 0);
    assert.deepEqual(
      after.spec.template.spec.containers.map(container => container.image),
      before.spec.template.spec.containers.map(container => container.image)
    );
    assert.equal(canonicalJson(stripManagedAnnotations(after)),
      canonicalJson(stripManagedAnnotations(before)));
    for (const [key, value] of Object.entries(desired[name])) {
      assert.equal(after.spec.template.metadata.annotations[key], value);
    }
    assert.equal(
      before.spec.template.metadata.annotations[profile.annotations.credential_revision],
      undefined,
      "the helper must not mutate its input"
    );
  }
});

test("annotation projection fails closed on stale binding, image drift or non-quiescence", () => {
  const input = fixture();
  const bundle = createProcessLocalRotationBundle(input);

  const running = structuredClone(findResource(input.baselineResources, "Deployment", "dialog"));
  running.spec.replicas = 1;
  expectCode(
    () => applyProcessLocalRotationAnnotations({ deployment: running, bundle, profile }),
    "live_deployment_not_quiesced"
  );

  const stale = structuredClone(findResource(input.baselineResources, "Deployment", "dialog"));
  stale.metadata.resourceVersion = "99999";
  expectCode(
    () => applyProcessLocalRotationAnnotations({ deployment: stale, bundle, profile }),
    "live_resource_binding_mismatch"
  );

  const changedImage = structuredClone(
    findResource(input.baselineResources, "Deployment", "dialog")
  );
  changedImage.spec.template.spec.containers[0].image =
    `ghcr.io/yengalvez/dialog@sha256:${"f".repeat(64)}`;
  expectCode(
    () => applyProcessLocalRotationAnnotations({
      deployment: changedImage,
      bundle: {
        ...bundle,
        contract: {
          ...bundle.contract,
          liveResourceBindings: bundle.contract.liveResourceBindings.map(binding =>
            binding.name === "dialog"
              ? { ...binding, resourceVersion: changedImage.metadata.resourceVersion }
              : binding
          )
        }
      },
      profile
    }),
    "live_deployment_image_mismatch"
  );
});

test("classifies the exact eight-resource inventory after a crash at every replacement", () => {
  for (let appliedCount = 0; appliedCount <= 8; appliedCount += 1) {
    const state = reentryFixture();
    state.liveResources = state.targets.map((baseline, index) =>
      index < appliedCount
        ? appliedCandidate(state.candidates[index], state.targets[index], index)
        : structuredClone(baseline)
    );
    const unchangedInputs = canonicalJson({
      baselineResources: state.input.baselineResources,
      liveResources: state.liveResources,
      bundle: state.bundle
    });
    const result = classifyReentry(state);
    assert.equal(canonicalJson({
      baselineResources: state.input.baselineResources,
      liveResources: state.liveResources,
      bundle: state.bundle
    }), unchangedInputs, "classification must not mutate its inputs");
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.resourceCount, 8);
    assert.equal(result.pendingCount, 8 - appliedCount);
    assert.equal(result.alreadyAppliedCount, appliedCount);
    assert.equal(result.complete, appliedCount === 8);
    assert.deepEqual(
      result.resources.map(resource => `${resource.kind}/${resource.name}`),
      [
        "Secret/configs",
        "Secret/ghcr-pull",
        ...profile.rotation_revision_deployments.map(name => `Deployment/${name}`)
      ]
    );
    assert.deepEqual(
      result.resources.map(resource => resource.state),
      [
        ...Array.from({ length: appliedCount }, () => "already-applied"),
        ...Array.from({ length: 8 - appliedCount }, () => "pending")
      ]
    );
    assert.equal(
      JSON.stringify(result).includes(newSnapshotSecrets.DB_PASS),
      false,
      "the re-entry inventory must not expose Secret content"
    );
  }
});

test("re-entry requires the complete 44-resource inventory", () => {
  const mutations = [
    live => live.slice(1),
    live => [...live, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "unexpected",
        namespace,
        uid: "unexpected-uid",
        resourceVersion: "1"
      }
    }],
    live => [...live.slice(0, -1), structuredClone(live[0])],
    live => live.map((resource, index) => index === 1
      ? { ...resource, metadata: { ...resource.metadata, name: "rogue" } }
      : resource)
  ];
  for (const mutate of mutations) {
    const state = reentryFixture();
    state.liveResources = mutate(expandTargetLiveResources(
      state,
      state.targets.map(resource => structuredClone(resource))
    ));
    expectCode(() => classifyReentry(state), "rotation_reentry_inventory_invalid");
  }
});

test("re-entry binds default and ret-config while tolerating only server state elsewhere", () => {
  const serviceAccountDrift = reentryFixture();
  serviceAccountDrift.liveResources = expandTargetLiveResources(
    serviceAccountDrift,
    serviceAccountDrift.targets
  );
  findResource(serviceAccountDrift.liveResources, "ServiceAccount", "default")
    .imagePullSecrets = [];
  expectCode(
    () => classifyReentry(serviceAccountDrift),
    "baseline_pull_service_account_invalid"
  );

  const serviceAccountRvDrift = reentryFixture();
  serviceAccountRvDrift.liveResources = expandTargetLiveResources(
    serviceAccountRvDrift,
    serviceAccountRvDrift.targets
  );
  findResource(serviceAccountRvDrift.liveResources, "ServiceAccount", "default")
    .metadata.resourceVersion = "advanced-default";
  expectCode(
    () => classifyReentry(serviceAccountRvDrift),
    "rotation_reentry_bind_only_resource_drift"
  );

  const retConfigDrift = reentryFixture();
  retConfigDrift.liveResources = expandTargetLiveResources(
    retConfigDrift,
    retConfigDrift.targets
  );
  findResource(retConfigDrift.liveResources, "ConfigMap", "ret-config")
    .data["config.toml.template"] += "\ndrift";
  expectCode(
    () => classifyReentry(retConfigDrift),
    "rotation_reentry_non_target_resource_drift"
  );

  const uidDrift = reentryFixture();
  uidDrift.liveResources = expandTargetLiveResources(uidDrift, uidDrift.targets);
  findResource(uidDrift.liveResources, "Deployment", "hubs").metadata.uid = "replacement";
  expectCode(
    () => classifyReentry(uidDrift),
    "rotation_reentry_invariant_uid_mismatch"
  );

  const serverState = reentryFixture();
  serverState.liveResources = expandTargetLiveResources(serverState, serverState.targets);
  const hubs = findResource(serverState.liveResources, "Deployment", "hubs");
  hubs.metadata.resourceVersion = "status-advanced";
  hubs.status = { observedGeneration: hubs.metadata.generation, availableReplicas: 1 };
  const result = classifyReentry(serverState);
  assert.equal(result.resourceCount, 8);
  assert.equal(result.pendingCount, 8);
});

test("re-entry rejects UID replacement for every one of the eight targets", () => {
  for (let index = 0; index < 8; index += 1) {
    const state = reentryFixture();
    state.liveResources = state.targets.map(resource => structuredClone(resource));
    state.liveResources[index].metadata.uid = `replacement-uid-${index}`;
    expectCode(() => classifyReentry(state), "rotation_reentry_uid_mismatch");
  }
});

test("re-entry rejects stale resourceVersions and same-content ABA states", () => {
  const staleCandidate = reentryFixture();
  staleCandidate.liveResources = staleCandidate.targets.map(resource => structuredClone(resource));
  staleCandidate.liveResources[0] = structuredClone(staleCandidate.candidates[0]);
  assert.equal(
    staleCandidate.liveResources[0].metadata.resourceVersion,
    staleCandidate.targets[0].metadata.resourceVersion
  );
  expectCode(
    () => classifyReentry(staleCandidate),
    "rotation_reentry_resource_drift"
  );

  const abaBaseline = reentryFixture();
  abaBaseline.liveResources = abaBaseline.targets.map(resource => structuredClone(resource));
  abaBaseline.liveResources[3].metadata.resourceVersion = "advanced-after-aba";
  expectCode(
    () => classifyReentry(abaBaseline),
    "rotation_reentry_resource_drift"
  );

  const missingRv = reentryFixture();
  missingRv.liveResources = missingRv.targets.map(resource => structuredClone(resource));
  delete missingRv.liveResources[4].metadata.resourceVersion;
  expectCode(
    () => classifyReentry(missingRv),
    "rotation_reentry_resource_version_invalid"
  );

  const candidateBindingDrift = reentryFixture();
  candidateBindingDrift.liveResources = candidateBindingDrift.targets
    .map(resource => structuredClone(resource));
  findResource(candidateBindingDrift.bundle.resources, "Secret", "configs")
    .metadata.resourceVersion = "unbound-candidate";
  expectCode(
    () => classifyReentry(candidateBindingDrift),
    "rotation_reentry_candidate_binding_invalid"
  );
});

test("re-entry rejects Secret, annotation, image and replica content drift", () => {
  const secretDrift = reentryFixture();
  secretDrift.liveResources = secretDrift.targets.map(resource => structuredClone(resource));
  secretDrift.liveResources[0] = appliedCandidate(
    secretDrift.candidates[0], secretDrift.targets[0], 0
  );
  const secretBody = secretDrift.liveResources[0].stringData || secretDrift.liveResources[0].data;
  if (secretDrift.liveResources[0].data) {
    secretBody.DB_PASS = Buffer.from(
      `${Buffer.from(secretBody.DB_PASS, "base64").toString("utf8")}-tampered`,
      "utf8"
    ).toString("base64");
  } else {
    secretBody.DB_PASS += "-tampered";
  }
  expectCode(() => classifyReentry(secretDrift), "rotation_reentry_resource_drift");

  const pullSecretDrift = reentryFixture();
  pullSecretDrift.liveResources = pullSecretDrift.targets.map(resource =>
    structuredClone(resource));
  pullSecretDrift.liveResources[1] = appliedCandidate(
    pullSecretDrift.candidates[1], pullSecretDrift.targets[1], 1
  );
  pullSecretDrift.liveResources[1].data[".dockerconfigjson"] = encodedPullConfig(
    "fixture-user", "new-pull-token-value", 2
  );
  expectCode(
    () => classifyReentry(pullSecretDrift),
    "rotation_reentry_resource_drift"
  );

  const annotationDrift = reentryFixture();
  annotationDrift.liveResources = annotationDrift.targets.map(resource => structuredClone(resource));
  annotationDrift.liveResources[2] = appliedCandidate(
    annotationDrift.candidates[2], annotationDrift.targets[2], 2
  );
  annotationDrift.liveResources[2].spec.template.metadata.annotations[
    profile.annotations.credential_revision
  ] = "aud065-wrong999";
  expectCode(() => classifyReentry(annotationDrift), "rotation_reentry_resource_drift");

  const imageDrift = reentryFixture();
  imageDrift.liveResources = imageDrift.targets.map(resource => structuredClone(resource));
  imageDrift.liveResources[5] = appliedCandidate(
    imageDrift.candidates[5], imageDrift.targets[5], 5
  );
  imageDrift.liveResources[5].spec.template.spec.containers[0].image =
    `ghcr.io/yengalvez/drift@sha256:${"f".repeat(64)}`;
  expectCode(() => classifyReentry(imageDrift), "rotation_reentry_resource_drift");

  const statusDrift = reentryFixture();
  statusDrift.liveResources = statusDrift.targets.map(resource => structuredClone(resource));
  statusDrift.liveResources[6] = appliedCandidate(
    statusDrift.candidates[6], statusDrift.targets[6], 6
  );
  statusDrift.liveResources[6].status.observedGeneration += 1;
  assert.equal(
    classifyReentry(statusDrift).resources[6].state,
    "already-applied",
    "Deployment status is API-managed and may advance independently"
  );

  const replicaDrift = reentryFixture();
  replicaDrift.liveResources = replicaDrift.targets.map(resource => structuredClone(resource));
  replicaDrift.liveResources[2].spec.replicas = 1;
  expectCode(
    () => classifyReentry(replicaDrift),
    "rotation_reentry_deployment_not_quiesced"
  );
});

test("re-entry permits only real server defaults and exact generation advancement", () => {
  const accepted = reentryFixture();
  accepted.liveResources = accepted.targets.map((baseline, index) =>
    appliedCandidate(accepted.candidates[index], baseline, index));
  accepted.liveResources[0].metadata.managedFields.push({
    manager: "kube-controller-manager",
    operation: "Update"
  });
  accepted.liveResources[2].status = {
    observedGeneration: accepted.targets[2].metadata.generation + 1,
    conditions: [{ type: "Available", status: "False" }]
  };
  const result = classifyReentry(accepted);
  assert.equal(result.complete, true);
  assert.equal(result.resources.every(resource => resource.state === "already-applied"), true);

  for (const generation of [7, 9]) {
    const drift = reentryFixture();
    drift.liveResources = drift.targets.map(resource => structuredClone(resource));
    drift.liveResources[2] = appliedCandidate(drift.candidates[2], drift.targets[2], 2);
    drift.liveResources[2].metadata.generation = generation;
    expectCode(() => classifyReentry(drift), "rotation_reentry_resource_drift");
  }

  const malformedManagedFields = reentryFixture();
  malformedManagedFields.liveResources = malformedManagedFields.targets
    .map(resource => structuredClone(resource));
  malformedManagedFields.liveResources[2] = appliedCandidate(
    malformedManagedFields.candidates[2], malformedManagedFields.targets[2], 2
  );
  malformedManagedFields.liveResources[2].metadata.managedFields = "not-an-array";
  expectCode(
    () => classifyReentry(malformedManagedFields),
    "rotation_reentry_live_deployment_invalid"
  );
});

test("re-entry rejects all non-server metadata drift", () => {
  const mutations = [
    deployment => { deployment.metadata.labels = { drift: "true" }; },
    deployment => { deployment.metadata.annotations["fixture.invalid/drift"] = "true"; },
    deployment => {
      deployment.metadata.ownerReferences = [{
        apiVersion: "v1", kind: "ConfigMap", name: "rogue", uid: "rogue-uid"
      }];
    },
    deployment => { deployment.metadata.finalizers = ["fixture.invalid/finalizer"]; },
    deployment => { deployment.metadata.creationTimestamp = "2026-07-18T12:00:01Z"; }
  ];
  for (const mutate of mutations) {
    const state = reentryFixture();
    state.liveResources = state.targets.map(resource => structuredClone(resource));
    state.liveResources[2] = appliedCandidate(state.candidates[2], state.targets[2], 2);
    mutate(state.liveResources[2]);
    expectCode(() => classifyReentry(state), "rotation_reentry_resource_drift");
  }

  const secretMetadata = reentryFixture();
  secretMetadata.liveResources = secretMetadata.targets.map(resource => structuredClone(resource));
  secretMetadata.liveResources[0] = appliedCandidate(
    secretMetadata.candidates[0], secretMetadata.targets[0], 0
  );
  secretMetadata.liveResources[0].metadata.labels = { drift: "true" };
  expectCode(
    () => classifyReentry(secretMetadata),
    "rotation_reentry_live_secret_invalid"
  );
});

test("replacement projection strips status and server-managed write metadata", () => {
  const state = reentryFixture();
  const unchanged = canonicalJson(state.targets);
  for (const [index, baselineResource] of state.targets.entries()) {
    const replacement = projectProcessLocalRotationReplacement({
      baselineResource,
      bundle: state.bundle,
      profile
    });
    assert.equal(replacement.status, undefined);
    assert.equal(replacement.metadata.managedFields, undefined);
    assert.equal(replacement.metadata.generation, undefined);
    assert.equal(replacement.metadata.uid, baselineResource.metadata.uid);
    assert.equal(
      replacement.metadata.resourceVersion,
      baselineResource.metadata.resourceVersion
    );
    if (replacement.kind === "Deployment") assert.equal(replacement.spec.replicas, 0);
  }
  assert.equal(canonicalJson(state.targets), unchanged, "projection must remain pure");
});

test("re-entry accepts only a sanitized, mutable Opaque final Secret", () => {
  for (const [mutate, code] of [
    [secret => { secret.type = "kubernetes.io/tls"; }, "rotation_reentry_secret_final_invalid"],
    [secret => { secret.immutable = true; }, "rotation_reentry_secret_final_invalid"],
    [secret => { secret.metadata.managedFields = []; }, "rotation_bundle_contract_mismatch"],
    [secret => {
      secret.metadata.annotations = { "example.invalid/drift": "true" };
    }, "rotation_reentry_secret_final_invalid"],
    [secret => { secret.metadata.labels = { drift: "true" }; },
      "rotation_reentry_secret_final_invalid"]
  ]) {
    const state = reentryFixture();
    mutate(findResource(state.bundle.resources, "Secret", "configs"));
    state.liveResources = state.targets.map(resource => structuredClone(resource));
    expectCode(
      () => classifyReentry(state),
      code
    );
  }

  const legacy = fixture();
  const baselineSecret = findResource(legacy.baselineResources, "Secret", "configs");
  baselineSecret.metadata.annotations = {
    "kubectl.kubernetes.io/last-applied-configuration": historicalLastApplied(baselineSecret)
  };
  baselineSecret.metadata.managedFields = [{
    manager: "kubectl-client-side-apply",
    operation: "Update"
  }];
  const bundle = createProcessLocalRotationBundle(legacy);
  const projected = findResource(bundle.resources, "Secret", "configs");
  assert.equal(projected.metadata.annotations, undefined);
  assert.equal(projected.metadata.managedFields, undefined);
  assert.equal(projected.type, "Opaque");
  assert.equal(projected.immutable, undefined);
});

test("verifies an exact two-Secret bundle and rejects post-projection mutation", () => {
  const input = fixture();
  const bundle = createProcessLocalRotationBundle(input);
  assert.equal(verifyProcessLocalRotationBundle({ ...input, bundle }), true);

  const changed = structuredClone(bundle);
  findResource(changed.resources, "Secret", "configs").stringData.DB_PASS += "tampered";
  expectCode(
    () => verifyProcessLocalRotationBundle({ ...input, bundle: changed }),
    "rotation_bundle_contract_mismatch"
  );

  const changedPull = structuredClone(bundle);
  findResource(changedPull.resources, "Secret", "ghcr-pull")
    .data[".dockerconfigjson"] = oldPullConfig;
  expectCode(
    () => verifyProcessLocalRotationBundle({ ...input, bundle: changedPull }),
    "rotation_bundle_contract_mismatch"
  );

  const added = structuredClone(bundle);
  added.resources.push({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "dialog", namespace }
  });
  expectCode(
    () => verifyProcessLocalRotationBundle({ ...input, bundle: added }),
    "rotation_bundle_contract_mismatch"
  );
});

test("requires both snapshots and all 13 live images to remain exact trusted digests", () => {
  const changedNew = fixture();
  changedNew.newValues.OVERRIDE_RETICULUM_IMAGE =
    `ghcr.io/yengalvez/reticulum@sha256:${"f".repeat(64)}`;
  expectCode(() => createProcessLocalRotationBundle(changedNew), "new_image_override_changed");

  const changedOld = fixture();
  changedOld.oldValues.OVERRIDE_RETICULUM_IMAGE =
    `ghcr.io/yengalvez/reticulum@sha256:${"f".repeat(64)}`;
  expectCode(() => createProcessLocalRotationBundle(changedOld), "old_image_override_changed");

  const changedRunner = fixture();
  changedRunner.newValues.OVERRIDE_BOT_RUNNER_IMAGE =
    `ghcr.io/yengalvez/bot-runner@sha256:${"f".repeat(64)}`;
  expectCode(
    () => createProcessLocalRotationBundle(changedRunner),
    "pull_image_override_changed"
  );

  const unchangedPullCredential = fixture();
  unchangedPullCredential.newValues.BOT_IMAGE_PULL_CONFIG_JSON_BASE64 = oldPullConfig;
  expectCode(
    () => createProcessLocalRotationBundle(unchangedPullCredential),
    "legacy_pull_credential_contract_invalid"
  );

  const untrusted = fixture();
  const reticulum = findResource(untrusted.baselineResources, "Deployment", "reticulum");
  reticulum.spec.template.spec.containers[0].image =
    `evil.invalid/reticulum@sha256:${"f".repeat(64)}`;
  untrusted.oldValues.OVERRIDE_RETICULUM_IMAGE = reticulum.spec.template.spec.containers[0].image;
  untrusted.newValues.OVERRIDE_RETICULUM_IMAGE = reticulum.spec.template.spec.containers[0].image;
  expectCode(
    () => createProcessLocalRotationBundle(untrusted),
    "baseline_image_not_trusted_digest"
  );

  const missing = fixture();
  missing.baselineResources = missing.baselineResources.filter(resource =>
    !(resource.kind === "Deployment" && resource.metadata.name === "spoke")
  );
  expectCode(() => createProcessLocalRotationBundle(missing), "baseline_resource_inventory_invalid");

  const expanded = fixture();
  expanded.baselineResources.push(deployment("rogue", [{
    name: "rogue",
    image: `ghcr.io/yengalvez/rogue@sha256:${"e".repeat(64)}`
  }]));
  expectCode(() => createProcessLocalRotationBundle(expanded), "baseline_resource_inventory_invalid");
});

test("requires the exact 32 historical Secret env references in the live baseline", () => {
  const drift = fixture();
  const dialog = findResource(drift.baselineResources, "Deployment", "dialog");
  dialog.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.key = "PHX_KEY";
  expectCode(
    () => createProcessLocalRotationBundle(drift),
    "baseline_secret_env_inventory_invalid"
  );
});

test("rejects every AUD-075 marker, secret domain and parent authority", () => {
  const namespaceResidual = fixture();
  namespaceResidual.baselineResources.push({
    apiVersion: "v1", kind: "Namespace", metadata: { name: "hcce-bot-runners" }
  });
  expectCode(
    () => createProcessLocalRotationBundle(namespaceResidual),
    "aud075_resource_or_annotation_forbidden"
  );

  const secretDomain = fixture();
  findResource(secretDomain.baselineResources, "Deployment", "reticulum")
    .spec.template.spec.containers[0].env.push(
      envSecret("turkeyCfg_BOT_RUNNER_ACCESS_KEY", "BOT_RUNNER_ACCESS_KEY")
    );
  expectCode(
    () => createProcessLocalRotationBundle(secretDomain),
    "aud075_secret_domain_forbidden"
  );

  const annotationResidual = fixture();
  findResource(annotationResidual.baselineResources, "Deployment", "reticulum")
    .spec.template.metadata.annotations["yenhubs.org/bot-runner-recovery-epoch"] =
      "11111111-1111-4111-8111-111111111111";
  expectCode(
    () => createProcessLocalRotationBundle(annotationResidual),
    "aud075_resource_or_annotation_forbidden"
  );

  const parentAuthority = fixture();
  const parentSpec = findResource(
    parentAuthority.baselineResources, "Deployment", "bot-orchestrator"
  ).spec.template.spec;
  parentSpec.serviceAccountName = "bot-orchestrator";
  parentSpec.automountServiceAccountToken = true;
  expectCode(
    () => createProcessLocalRotationBundle(parentAuthority),
    "process_local_parent_authority_invalid"
  );
});

test("requires exact rotations, stable configuration and correct DB URI hosts", () => {
  const unchanged = fixture();
  unchanged.newValues.DB_PASS = oldSnapshotSecrets.DB_PASS;
  unchanged.newValues.PGRST_DB_URI = oldSnapshotSecrets.PGRST_DB_URI;
  unchanged.newValues.PSQL = oldSnapshotSecrets.PSQL;
  expectCode(() => createProcessLocalRotationBundle(unchanged), "required_secret_not_rotated");

  const domainDrift = fixture();
  domainDrift.newValues.HUB_DOMAIN = "other.invalid";
  expectCode(() => createProcessLocalRotationBundle(domainDrift), "invariant_secret_value_changed");

  const smtpDrift = fixture();
  smtpDrift.newValues.SMTP_USER = "other@example.invalid";
  expectCode(() => createProcessLocalRotationBundle(smtpDrift), "invariant_secret_value_changed");

  const optionalUnchanged = fixture();
  optionalUnchanged.newValues.TENOR_API_KEY = oldSnapshotSecrets.TENOR_API_KEY;
  expectCode(
    () => createProcessLocalRotationBundle(optionalUnchanged),
    "configured_secret_not_rotated"
  );

  const optionalRemoved = fixture();
  optionalRemoved.newValues.TENOR_API_KEY = "";
  expectCode(
    () => createProcessLocalRotationBundle(optionalRemoved),
    "configured_secret_presence_changed"
  );

  const staleUri = fixture();
  staleUri.newValues.PGRST_DB_URI = oldSnapshotSecrets.PGRST_DB_URI;
  expectCode(() => createProcessLocalRotationBundle(staleUri), "new_pgrst_db_uri_invalid");

  const wrongPsqlHost = fixture();
  wrongPsqlHost.newValues.PSQL = wrongPsqlHost.newValues.PSQL.replace("@pgsql:", "@pgbouncer:");
  expectCode(() => createProcessLocalRotationBundle(wrongPsqlHost), "new_psql_invalid");
});

test("fails on invalid PERMS, rendered ret-config, stale annotation or running consumer", () => {
  const invalidPerms = fixture();
  invalidPerms.newValues.PERMS_KEY = "not-a-private-key";
  expectCode(() => createProcessLocalRotationBundle(invalidPerms), "new_perms_key_invalid");

  const missingPlaceholder = fixture();
  const config = findResource(missingPlaceholder.baselineResources, "ConfigMap", "ret-config");
  config.data["config.toml.template"] = config.data["config.toml.template"]
    .replace("<GUARDIAN_KEY>", "fixture-placeholder-removed");
  expectCode(
    () => createProcessLocalRotationBundle(missingPlaceholder),
    "ret_config_placeholder_inventory_invalid"
  );

  const renderedSecret = fixture();
  findResource(renderedSecret.baselineResources, "ConfigMap", "ret-config")
    .data["config.toml.template"] += `\n${oldSnapshotSecrets.GUARDIAN_KEY}`;
  expectCode(
    () => createProcessLocalRotationBundle(renderedSecret),
    "ret_config_contains_rendered_secret"
  );

  const staleAnnotation = fixture();
  findResource(staleAnnotation.baselineResources, "Deployment", "reticulum")
    .spec.template.metadata.annotations[profile.annotations.database_checksum] = "0".repeat(64);
  expectCode(
    () => createProcessLocalRotationBundle(staleAnnotation),
    "baseline_rotation_annotation_mismatch"
  );

  const running = fixture();
  findResource(running.baselineResources, "Deployment", "dialog").spec.replicas = 1;
  expectCode(
    () => createProcessLocalRotationBundle(running),
    "rotation_consumer_not_quiesced"
  );
});

test("supports an existing data-encoded Secret without changing its encoding", () => {
  const input = fixture();
  const secret = findResource(input.baselineResources, "Secret", "configs");
  secret.data = Object.fromEntries(Object.entries(secret.stringData).map(([key, value]) => [
    key,
    Buffer.from(value, "utf8").toString("base64")
  ]));
  delete secret.stringData;
  const bundle = createProcessLocalRotationBundle(input);
  const projected = findResource(bundle.resources, "Secret", "configs");
  assert.equal(projected.stringData, undefined);
  assert.equal(
    Buffer.from(projected.data.DB_PASS, "base64").toString("utf8"),
    newSnapshotSecrets.DB_PASS
  );
});

test("redacts Secret and sensitive ConfigMap bodies with operation-local HMACs", () => {
  const input = fixture();
  const bundle = createProcessLocalRotationBundle(input);
  const redacted = redactProcessLocalRotationBundle({
    ...input,
    bundle,
    fingerprintKey: Buffer.alloc(32, 7)
  });
  const serialized = JSON.stringify(redacted);
  for (const key of [
    ...profile.required_rotated_secret_keys,
    ...profile.rotate_if_configured_secret_keys
  ]) {
    assert.equal(
      serialized.includes(newSnapshotSecrets[key]),
      false,
      `${key} leaked into redacted plan`
    );
  }
  assert.equal(serialized.includes(oldSnapshotSecrets.GUARDIAN_KEY), false);
  assert.equal(serialized.includes(oldPullConfig), false);
  assert.equal(serialized.includes(newPullConfig), false);
  assert.equal(serialized.includes("old-pull-token-value"), false);
  assert.equal(serialized.includes("new-pull-token-value"), false);
  assert.equal(redacted.secret.keys.length, 22);
  assert.equal(redacted.placeholderConfigMap.dataKeys.length, 1);
  assert.match(redacted.secret.keys[0].fingerprint, /^[a-f0-9]{64}$/u);
  assert.match(redacted.placeholderConfigMap.dataKeys[0].fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(redacted.workloadChanges, []);
  assert.equal(redacted.specInvariant, true);
  assert.equal(redacted.configMapInvariant, true);
  assert.equal(redacted.placeholderConfigMap.action, "bind-existing-no-apply");
  assert.equal(redacted.legacyImagePull.pullSecret.credentialRotated, true);
  assert.equal(redacted.legacyImagePull.serviceAccount.action, "bind-existing-no-apply");
  assert.equal(hasOwn(redacted, "sensitiveConfigMap"), false);
  assert.equal(hasOwn(redacted, "deployments"), false);
  assert.equal(hasOwn(redacted, "desiredDeploymentAnnotations"), false);
  assert.equal(hasOwn(redacted, "liveResourceBindings"), false);
  assert.equal(hasOwn(redacted, "imagePairs"), false);
  assert.equal(hasOwn(redacted, "databaseCredentialChecksum"), false);
  assert.equal(hasOwn(redacted, "botAccessKeyChecksum"), false);
  assert.equal(hasOwn(redacted, "permsPublicKeySha256"), false);
  assert.equal(serialized.includes("@sha256:"), false);
});

test("requires a strong operation-local HMAC key for redaction", () => {
  const input = fixture();
  const bundle = createProcessLocalRotationBundle(input);
  expectCode(() => redactProcessLocalRotationBundle({
    ...input,
    bundle,
    fingerprintKey: "too-short"
  }), "redaction_fingerprint_key_invalid");
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

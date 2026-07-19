#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  PROCESS_LOCAL_IMAGE_PULL_CONTRACTS,
  verifyBotDeploymentChecksums,
  verifyBotPullConfig,
  verifyBotPullConfigCredentialMatch,
  verifyBotPullConfigRotation,
  verifyGhcrPullAccess,
  verifyProcessLocalSnapshotGhcrAccess
} from "../../deployment/verify-bot-image-pull-config.mjs";

const botImage = `ghcr.io/yengalvez/bot-orchestrator@sha256:${"a".repeat(64)}`;
const runnerImage = `ghcr.io/yengalvez/bot-runner@sha256:${"b".repeat(64)}`;
const encoded = Buffer.from(JSON.stringify({
  auths: { "ghcr.io": { auth: Buffer.from("ci-user:ci-token").toString("base64") } }
})).toString("base64");
const secret = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "bot-images-pull", namespace: "hcce" },
  type: "kubernetes.io/dockerconfigjson",
  data: { ".dockerconfigjson": encoded }
};
const runnerSecret = structuredClone(secret);
runnerSecret.metadata.namespace = "hcce-bot-runners";
const base = {
  encoded,
  botImage,
  runnerImage,
  secret,
  namespace: "hcce",
  runnerSecret,
  runnerNamespace: "hcce-bot-runners"
};

assert.equal(verifyBotPullConfig(base), true);
assert.throws(() => verifyBotPullConfig({ ...base, encoded: "not-base64" }));
assert.throws(() => verifyBotPullConfig({ ...base, runnerImage: runnerImage.replace("yengalvez", "other") }));
assert.throws(() => verifyBotPullConfig({ ...base, secret: { ...secret, type: "Opaque" } }));
assert.throws(() => verifyBotPullConfig({
  ...base,
  secret: { ...secret, data: { ".dockerconfigjson": `${encoded}x` } }
}));

const semanticallySameEncoded = Buffer.from(JSON.stringify({
  auths: { "ghcr.io": { auth: Buffer.from("ci-user:ci-token").toString("base64") } }
}, null, 2)).toString("base64");
assert.equal(verifyBotPullConfigCredentialMatch({
  expectedEncoded: encoded,
  actualEncoded: semanticallySameEncoded,
  botImage,
  runnerImage
}), true);
const rotatedEncoded = Buffer.from(JSON.stringify({
  auths: { "ghcr.io": { auth: Buffer.from("ci-user:new-ci-token").toString("base64") } }
})).toString("base64");
assert.equal(verifyBotPullConfigRotation({
  oldEncoded: encoded,
  newEncoded: rotatedEncoded,
  botImage,
  runnerImage
}), true);
assert.throws(() => verifyBotPullConfigRotation({
  oldEncoded: encoded,
  newEncoded: semanticallySameEncoded,
  botImage,
  runnerImage
}), error => error.code === "credential_not_rotated" &&
  !String(error).includes("ci-token"));
assert.throws(() => verifyBotPullConfigCredentialMatch({
  expectedEncoded: encoded,
  actualEncoded: rotatedEncoded,
  botImage,
  runnerImage
}), error => error.code === "credential_mismatch" &&
  !String(error).includes("ci-token") && !String(error).includes("new-ci-token"));
assert.throws(() => verifyBotPullConfig({ ...base, namespace: "other" }));
assert.throws(() => verifyBotPullConfig({
  ...base,
  runnerSecret: { ...runnerSecret, data: { ".dockerconfigjson": `${encoded}x` } }
}));
assert.throws(() => verifyBotPullConfig({ ...base, runnerNamespace: "hcce" }));
assert.throws(() => verifyBotPullConfig({
  ...base,
  runnerSecret: {
    ...runnerSecret,
    metadata: { ...runnerSecret.metadata, deletionTimestamp: "2026-07-18T08:00:00Z" }
  }
}));

const keys = {
  botKey: "b".repeat(64),
  runnerKey: "r".repeat(64),
  orchestratorKey: "o".repeat(64),
  dashboardKey: "d".repeat(64),
  recoveryEpoch: "44444444-4444-4444-8444-444444444444",
  namespace: "hcce"
};
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const deployments = { items: [
  {
    metadata: { name: "reticulum", namespace: "hcce" },
    spec: { template: { metadata: { annotations: {
      "yenhubs.org/bot-access-key-checksum": digest(keys.botKey),
      "yenhubs.org/bot-runner-access-key-checksum": digest(keys.runnerKey),
      "yenhubs.org/bot-orchestrator-access-key-checksum": digest(keys.orchestratorKey),
      "yenhubs.org/bot-runner-recovery-epoch": keys.recoveryEpoch,
      "yenhubs.org/dashboard-access-key-checksum": digest(keys.dashboardKey),
      "yenhubs.org/db-credential-checksum": "e".repeat(64)
    } } } }
  },
  {
    metadata: { name: "bot-orchestrator", namespace: "hcce" },
    spec: { template: { metadata: { annotations: {
      "yenhubs.org/bot-orchestrator-access-key-checksum": digest(keys.orchestratorKey),
      "yenhubs.org/bot-runner-recovery-epoch": keys.recoveryEpoch
    } } } }
  }
] };
assert.equal(verifyBotDeploymentChecksums({ deployments, ...keys }), true);
const restartedDeployments = structuredClone(deployments);
for (const item of restartedDeployments.items) {
  item.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] =
    "2026-07-18T08:00:00+02:00";
}
assert.equal(verifyBotDeploymentChecksums({ deployments: restartedDeployments, ...keys }), true);
const invalidRestart = structuredClone(restartedDeployments);
invalidRestart.items[0].spec.template.metadata.annotations[
  "kubectl.kubernetes.io/restartedAt"
] = "not-a-time";
assert.throws(() => verifyBotDeploymentChecksums({ deployments: invalidRestart, ...keys }));
assert.throws(() => verifyBotDeploymentChecksums({
  deployments: structuredClone(deployments),
  ...keys,
  runnerKey: "x".repeat(64)
}));
const parentWithMasterChecksum = structuredClone(deployments);
parentWithMasterChecksum.items[1].spec.template.metadata.annotations[
  "yenhubs.org/bot-runner-access-key-checksum"
] = digest(keys.runnerKey);
assert.throws(() => verifyBotDeploymentChecksums({ deployments: parentWithMasterChecksum, ...keys }));

const manifestBody = JSON.stringify({ schemaVersion: 2, mediaType: "fixture" });
const registryCalls = [];
const registryFetch = async (url, init) => {
  const parsed = new URL(url);
  registryCalls.push({ url: parsed.toString(), authorization: init.headers.Authorization });
  if (parsed.pathname === "/token") {
    assert.equal(init.headers.Authorization, `Basic ${JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8")
    ).auths["ghcr.io"].auth}`);
    const repository = parsed.searchParams.get("scope").split("/").at(-1).split(":")[0];
    const body = JSON.stringify({ token: `bearer-${repository}` });
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) }
    });
  }
  const match = parsed.pathname.match(/^\/v2\/yengalvez\/(bot-orchestrator|bot-runner)\/manifests\/(sha256:[a-f0-9]{64})$/);
  assert.ok(match);
  assert.equal(init.headers.Authorization, `Bearer bearer-${match[1]}`);
  return new Response(manifestBody, {
    status: 200,
    headers: {
      "content-length": String(Buffer.byteLength(manifestBody)),
      "docker-content-digest": match[2]
    }
  });
};
assert.equal(await verifyGhcrPullAccess({
  encoded,
  images: [botImage, runnerImage],
  fetchImpl: registryFetch
}), true);
assert.equal(registryCalls.length, 4);

const revokedEncoded = Buffer.from(JSON.stringify({
  auths: { "ghcr.io": { auth: Buffer.from("ci-user:revoked-token").toString("base64") } }
})).toString("base64");
await assert.rejects(
  verifyGhcrPullAccess({
    encoded: revokedEncoded,
    images: [botImage, runnerImage],
    githubToken: "valid-but-unrelated-github-token",
    fetchImpl: async url => {
      if (new URL(url).pathname === "/token") return new Response("denied", { status: 401 });
      throw new Error("manifest_must_not_be_reached");
    }
  }),
  error => !String(error).includes("revoked-token") && !String(error).includes("valid-but-unrelated")
);

await assert.rejects(verifyGhcrPullAccess({
  encoded,
  images: [botImage, runnerImage],
  fetchImpl: async url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/token") {
      return new Response(JSON.stringify({ token: "fixture" }), { status: 200 });
    }
    return new Response(manifestBody, {
      status: 200,
      headers: { "docker-content-digest": `sha256:${"f".repeat(64)}` }
    });
  }
}));

const extraAuthEncoded = Buffer.from(JSON.stringify({
  auths: {
    "ghcr.io": { auth: Buffer.from("ci-user:ci-token").toString("base64") },
    "registry.example": { auth: Buffer.from("other:token").toString("base64") }
  }
})).toString("base64");
await assert.rejects(verifyGhcrPullAccess({
  encoded: extraAuthEncoded,
  images: [botImage, runnerImage],
  fetchImpl: async () => { throw new Error("noncanonical_config_must_not_reach_network"); }
}));

await assert.rejects(verifyGhcrPullAccess({
  encoded,
  images: [botImage, runnerImage],
  fetchImpl: async url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/token") {
      const body = JSON.stringify({ token: "fixture" });
      return new Response(body, { status: 200 });
    }
    if (parsed.pathname.includes("/bot-runner/")) return new Response("denied", { status: 403 });
    const digest = parsed.pathname.split("/").at(-1);
    return new Response(manifestBody, {
      status: 200,
      headers: { "docker-content-digest": digest }
    });
  }
}));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

const profile = JSON.parse(fs.readFileSync(
  path.resolve("deployment/process-local-rotation-profile.json"),
  "utf8"
));
const contractsFromProfile = new Map();
for (const pair of profile.image_pairs) {
  const existing = contractsFromProfile.get(pair.value_key);
  if (existing) assert.deepEqual(existing, pair.repositories);
  else contractsFromProfile.set(pair.value_key, pair.repositories);
}
assert.deepEqual(profile.legacy_image_pull.verified_image_value_keys, [
  "OVERRIDE_BOT_ORCHESTRATOR_IMAGE",
  "OVERRIDE_BOT_RUNNER_IMAGE"
]);
contractsFromProfile.set("OVERRIDE_BOT_RUNNER_IMAGE", ["ghcr.io/yengalvez/bot-runner"]);
assert.deepEqual(
  PROCESS_LOCAL_IMAGE_PULL_CONTRACTS
    .map(contract => ({ valueKey: contract.valueKey, repositories: [...contract.repositories] }))
    .sort((left, right) => left.valueKey.localeCompare(right.valueKey)),
  [...contractsFromProfile]
    .map(([valueKey, repositories]) => ({ valueKey, repositories }))
    .sort((left, right) => left.valueKey.localeCompare(right.valueKey))
);
assert.equal(new Set(PROCESS_LOCAL_IMAGE_PULL_CONTRACTS.map(item => item.valueKey)).size, 13);

const privateRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-ghcr-gate-"));
fs.chmodSync(privateRoot, 0o700);
const cliPath = path.resolve("deployment/verify-bot-image-pull-config.mjs");
const snapshotCredential = Buffer.from(JSON.stringify({
  auths: {
    "ghcr.io": {
      auth: Buffer.from("snapshot-user:snapshot-secret-token", "utf8").toString("base64")
    }
  }
}), "utf8").toString("base64");
const snapshotBasic = JSON.parse(
  Buffer.from(snapshotCredential, "base64").toString("utf8")
).auths["ghcr.io"].auth;
const requiredSnapshotKeys = new Set([
  profile.namespace_value_key,
  ...profile.secret_keys.filter(key => !profile.derived_secret_keys.includes(key)),
  ...profile.image_pairs.map(pair => pair.value_key),
  profile.legacy_image_pull.snapshot_value_key,
  ...profile.legacy_image_pull.verified_image_value_keys
]);

function makeProcessLocalSnapshot() {
  const snapshot = Object.fromEntries(
    [...requiredSnapshotKeys].map(key => [key, `fixture-${key}`])
  );
  snapshot.Namespace = "hcce";
  snapshot.BOT_IMAGE_PULL_CONFIG_JSON_BASE64 = snapshotCredential;
  PROCESS_LOCAL_IMAGE_PULL_CONTRACTS.forEach((contract, index) => {
    snapshot[contract.valueKey] =
      `${contract.repositories[0]}@sha256:${(index + 1).toString(16).repeat(64)}`;
  });
  return snapshot;
}

let fixtureIndex = 0;
function writeSnapshot(snapshot, { mode = 0o600, canonical = true } = {}) {
  fixtureIndex += 1;
  const snapshotPath = path.join(privateRoot, `snapshot-${fixtureIndex}.json`);
  const text = canonical
    ? `${canonicalJson(snapshot)}\n`
    : `${JSON.stringify(snapshot, null, 2)}\n`;
  fs.writeFileSync(snapshotPath, text, { mode });
  fs.chmodSync(snapshotPath, mode);
  return snapshotPath;
}

const manifestBodyFixture = JSON.stringify({ schemaVersion: 2, mediaType: "fixture" });
function makeRegistryFetch({ deniedRepository = null, wrongDigestRepository = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.hostname, "ghcr.io");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    if (parsed.pathname === "/token") {
      const scope = parsed.searchParams.get("scope");
      const scopeMatch = scope?.match(/^repository:yengalvez\/([a-z0-9-]+):pull$/u);
      assert.ok(scopeMatch);
      assert.equal(parsed.searchParams.get("service"), "ghcr.io");
      assert.equal(init.headers.Authorization, `Basic ${snapshotBasic}`);
      calls.push({ type: "token", repository: scopeMatch[1] });
      const body = JSON.stringify({ token: `fixture-bearer-${scopeMatch[1]}` });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(body)) }
      });
    }
    const manifestMatch = parsed.pathname.match(
      /^\/v2\/yengalvez\/([a-z0-9-]+)\/manifests\/(sha256:[a-f0-9]{64})$/u
    );
    assert.ok(manifestMatch);
    const [, repository, requestedDigest] = manifestMatch;
    assert.equal(init.headers.Authorization, `Bearer fixture-bearer-${repository}`);
    calls.push({ type: "manifest", repository, digest: requestedDigest });
    if (repository === deniedRepository) return new Response("denied", { status: 403 });
    return new Response(manifestBodyFixture, {
      status: 200,
      headers: {
        "content-length": String(Buffer.byteLength(manifestBodyFixture)),
        "docker-content-digest": repository === wrongDigestRepository
          ? `sha256:${"f".repeat(64)}`
          : requestedDigest
      }
    });
  };
  return { calls, fetchImpl };
}

try {
  const allGhcrSnapshot = makeProcessLocalSnapshot();
  const allGhcrPath = writeSnapshot(allGhcrSnapshot);
  const allGhcrRegistry = makeRegistryFetch();
  assert.equal(await verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: allGhcrPath,
    fetchImpl: allGhcrRegistry.fetchImpl
  }), true);
  assert.equal(allGhcrRegistry.calls.length, PROCESS_LOCAL_IMAGE_PULL_CONTRACTS.length * 2);
  for (const contract of PROCESS_LOCAL_IMAGE_PULL_CONTRACTS) {
    const repository = contract.repositories[0].split("/").at(-1);
    assert.equal(allGhcrRegistry.calls.filter(call =>
      call.type === "token" && call.repository === repository).length, 1);
    assert.equal(allGhcrRegistry.calls.filter(call =>
      call.type === "manifest" && call.repository === repository).length, 1);
  }

  const dockerHubSnapshot = makeProcessLocalSnapshot();
  const dockerHubKeys = new Set();
  for (const contract of PROCESS_LOCAL_IMAGE_PULL_CONTRACTS) {
    const dockerRepositories = contract.repositories.filter(repository =>
      !repository.startsWith("ghcr.io/"));
    const dockerRepository = dockerRepositories.length > 0
      ? dockerRepositories[dockerHubKeys.size % dockerRepositories.length]
      : null;
    if (dockerRepository) {
      dockerHubKeys.add(contract.valueKey);
      dockerHubSnapshot[contract.valueKey] =
        `${dockerRepository}@sha256:${"e".repeat(64)}`;
    }
  }
  const dockerHubPath = writeSnapshot(dockerHubSnapshot);
  const dockerHubRegistry = makeRegistryFetch();
  assert.equal(await verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: dockerHubPath,
    fetchImpl: dockerHubRegistry.fetchImpl
  }), true);
  assert.equal(dockerHubKeys.size, 5);
  assert.equal(
    dockerHubRegistry.calls.length,
    (PROCESS_LOCAL_IMAGE_PULL_CONTRACTS.length - dockerHubKeys.size) * 2
  );
  assert.ok(dockerHubRegistry.calls.every(call =>
    !["haproxy", "nearspark", "pgbouncer", "postgres", "postgrest"].includes(call.repository)));

  const deniedRegistry = makeRegistryFetch({ deniedRepository: "reticulum" });
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: allGhcrPath,
    fetchImpl: deniedRegistry.fetchImpl
  }), error => error.code === "registry_manifest_denied" &&
    !String(error).includes("snapshot-secret-token"));

  const wrongDigestRegistry = makeRegistryFetch({ wrongDigestRepository: "hubs" });
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: allGhcrPath,
    fetchImpl: wrongDigestRegistry.fetchImpl
  }), error => error.code === "registry_manifest_digest" &&
    !String(error).includes("snapshot-secret-token"));

  const unpinnedSnapshot = makeProcessLocalSnapshot();
  unpinnedSnapshot.OVERRIDE_HUBS_IMAGE = "ghcr.io/yengalvez/hubs:latest";
  let invalidFetchCalls = 0;
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: writeSnapshot(unpinnedSnapshot),
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "process_local_image_contract");
  assert.equal(invalidFetchCalls, 0);

  const extraRepositorySnapshot = makeProcessLocalSnapshot();
  extraRepositorySnapshot.OVERRIDE_HUBS_IMAGE =
    `ghcr.io/yengalvez/not-hubs@sha256:${"a".repeat(64)}`;
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: writeSnapshot(extraRepositorySnapshot),
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "process_local_image_contract");
  assert.equal(invalidFetchCalls, 0);

  const extraKeySnapshot = makeProcessLocalSnapshot();
  extraKeySnapshot.OVERRIDE_UNKNOWN_IMAGE =
    `ghcr.io/yengalvez/unknown@sha256:${"a".repeat(64)}`;
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: writeSnapshot(extraKeySnapshot),
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "private_snapshot_keyset");
  assert.equal(invalidFetchCalls, 0);

  const missingKeySnapshot = makeProcessLocalSnapshot();
  delete missingKeySnapshot.OVERRIDE_SPOKE_IMAGE;
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: writeSnapshot(missingKeySnapshot),
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "private_snapshot_keyset");
  assert.equal(invalidFetchCalls, 0);

  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: writeSnapshot(makeProcessLocalSnapshot(), { canonical: false }),
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "private_snapshot_noncanonical");
  assert.equal(invalidFetchCalls, 0);

  const permissivePath = writeSnapshot(makeProcessLocalSnapshot(), { mode: 0o644 });
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: permissivePath,
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "private_snapshot_invalid");
  assert.equal(invalidFetchCalls, 0);

  const hardlinkSource = writeSnapshot(makeProcessLocalSnapshot());
  const hardlinkPath = path.join(privateRoot, "snapshot-hardlink.json");
  fs.linkSync(hardlinkSource, hardlinkPath);
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: hardlinkPath,
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "private_snapshot_invalid");
  assert.equal(invalidFetchCalls, 0);

  const symlinkSource = writeSnapshot(makeProcessLocalSnapshot());
  const symlinkPath = path.join(privateRoot, "snapshot-symlink.json");
  fs.symlinkSync(symlinkSource, symlinkPath);
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: symlinkPath,
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "private_snapshot_invalid");
  assert.equal(invalidFetchCalls, 0);

  const componentTargetDirectory = path.join(privateRoot, "component-target");
  const componentLinkDirectory = path.join(privateRoot, "component-link");
  fs.mkdirSync(componentTargetDirectory, { mode: 0o700 });
  const componentSnapshotPath = path.join(componentTargetDirectory, "snapshot.json");
  fs.writeFileSync(
    componentSnapshotPath,
    `${canonicalJson(makeProcessLocalSnapshot())}\n`,
    { mode: 0o600 }
  );
  fs.symlinkSync(componentTargetDirectory, componentLinkDirectory);
  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: path.join(componentLinkDirectory, "snapshot.json"),
    fetchImpl: async () => { invalidFetchCalls += 1; }
  }), error => error.code === "private_snapshot_invalid");
  assert.equal(invalidFetchCalls, 0);

  const changingSnapshot = makeProcessLocalSnapshot();
  const changingPath = writeSnapshot(changingSnapshot);
  const originalReadSync = fs.readSync;
  let changedDuringRead = false;
  fs.readSync = function (...arguments_) {
    const count = Reflect.apply(originalReadSync, fs, arguments_);
    if (!changedDuringRead && arguments_[4] === 0) {
      changedDuringRead = true;
      const replacement = structuredClone(changingSnapshot);
      replacement.SMTP_USER = replacement.SMTP_USER.replace(/.$/u, "X");
      fs.writeFileSync(changingPath, `${canonicalJson(replacement)}\n`, { mode: 0o600 });
    }
    return count;
  };
  try {
    await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
      snapshotPath: changingPath,
      fetchImpl: async () => { invalidFetchCalls += 1; }
    }), error => error.code === "private_snapshot_changed");
  } finally {
    fs.readSync = originalReadSync;
  }
  assert.equal(changedDuringRead, true);
  assert.equal(invalidFetchCalls, 0);

  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: allGhcrPath,
    requestTimeoutMs: 10,
    fetchImpl: async (_url, init) => await new Promise((resolve, rejectPromise) => {
      const hold = setTimeout(resolve, 1_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(hold);
        rejectPromise(new Error("fixture_timeout"));
      }, { once: true });
    })
  }), error => error.code === "registry_token_request");

  await assert.rejects(verifyProcessLocalSnapshotGhcrAccess({
    snapshotPath: allGhcrPath,
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.pathname === "/token") {
        return new Response("x", {
          status: 200,
          headers: { "content-length": String(64 * 1024 + 1) }
        });
      }
      throw new Error("manifest_must_not_be_reached");
    }
  }), error => error.code === "registry_token_response");

  const preloadPath = path.join(privateRoot, "registry-fetch-preload.mjs");
  fs.writeFileSync(preloadPath, `
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.pathname === "/token") {
    const repository = parsed.searchParams.get("scope").match(/repository:yengalvez\\/([^:]+):pull/)[1];
    const body = JSON.stringify({ token: \`fixture-bearer-\${repository}\` });
    return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
  }
  const match = parsed.pathname.match(/\\/v2\\/yengalvez\\/([^/]+)\\/manifests\\/(sha256:[a-f0-9]{64})/);
  if (process.env.DENY_FIXTURE_REPOSITORY === match[1]) return new Response("denied", { status: 403 });
  const body = JSON.stringify({ schemaVersion: 2 });
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(body.length), "docker-content-digest": match[2] }
  });
};
`, { mode: 0o600 });
  const cliBaseArguments = [
    "--import",
    pathToFileURL(preloadPath).href,
    cliPath,
    "--verify-process-local-snapshot",
    allGhcrPath
  ];
  const cliSuccess = spawnSync(process.execPath, cliBaseArguments, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(cliSuccess.status, 0, cliSuccess.stderr);
  assert.equal(cliSuccess.stdout, "");
  assert.equal(cliSuccess.stderr, "");

  const cliDenied = spawnSync(process.execPath, cliBaseArguments, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, DENY_FIXTURE_REPOSITORY: "reticulum" }
  });
  assert.equal(cliDenied.status, 1);
  assert.equal(cliDenied.stdout, "");
  assert.equal(
    cliDenied.stderr,
    "Bot image pull configuration failed: registry_manifest_denied.\n"
  );
  assert.ok(!cliDenied.stderr.includes("snapshot-secret-token"));
  assert.ok(!/[a-f0-9]{64}/u.test(cliDenied.stderr));
} finally {
  fs.rmSync(privateRoot, { recursive: true, force: true });
}

process.stdout.write("Bot image pull/checksum verifier: 44/44 passed\n");

#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyBotDeploymentChecksums,
  verifyBotPullConfig,
  verifyGhcrPullAccess
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

process.stdout.write("Bot image pull/checksum verifier: 19/19 passed\n");

#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ProcessLocalOldSourceCompletionError,
  completeProcessLocalOldSource
} from "../../deployment/complete-process-local-old-values.mjs";
import { parseLocalValuesSource } from "../../deployment/parse-local-values.mjs";
import { loadProcessLocalRotationProfile } from "../../deployment/process-local-rotation.mjs";
import { verifyBotPullConfig } from "../../deployment/verify-bot-image-pull-config.mjs";
import {
  RUNTIME_IMAGE_BUILD_REPOSITORY,
  RUNTIME_IMAGE_BUILD_REPOSITORY_ID,
  RUNTIME_IMAGE_BUILD_SOURCE_REF,
  RUNTIME_IMAGE_BUILD_WORKFLOW_PATH,
  canonicalRuntimeImageBuildReceiptJson,
  withRuntimeImageBuildProvenanceArtifactSnapshot
} from "../../deployment/verify-runtime-image-build-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "deployment/complete-process-local-old-values.mjs");
const CONTEXT = "fixture-context";
const NAMESPACE_UID = "11111111-2222-4333-8444-555555555555";
const RUNNER_IMAGE = `ghcr.io/yengalvez/bot-runner@sha256:${"d".repeat(64)}`;
const REGISTRY_CREDENTIAL = `fixture-user:fixture-old-registry-${"R".repeat(40)}`;
const profile = loadProcessLocalRotationProfile();

function privateKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey.replace(/\r?\n/gu, "\\n");
}

function pullConfig() {
  return encodedDockerConfig({
    auths: {
      "ghcr.io": {
        auth: Buffer.from(REGISTRY_CREDENTIAL, "utf8").toString("base64")
      }
    }
  });
}

function encodedDockerConfig(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function pinnedImage(valueKey) {
  const contract = profile.image_pairs.find(pair => pair.value_key === valueKey);
  return `${contract.repositories[0]}@sha256:${
    createHash("sha256").update(valueKey).digest("hex")
  }`;
}

const PARENT_IMAGE = pinnedImage("OVERRIDE_BOT_ORCHESTRATOR_IMAGE");
const RETICULUM_IMAGE = pinnedImage("OVERRIDE_RETICULUM_IMAGE");
const PROVENANCE_COMMIT = "a".repeat(40);
const PROVENANCE_INVOCATION =
  "https://github.com/yengalvez/hubs-cloud/actions/runs/31234567890/attempts/2";

function sourceValues() {
  const password = `Old_Db_Password_${"a".repeat(48)}`;
  const values = {
    Namespace: "hcce",
    ADM_EMAIL: "admin@example.invalid",
    BOT_ACCESS_KEY: `old-bot-${"a".repeat(48)}`,
    BOT_RUNNER_ACCESS_KEY: `old-runner-${"b".repeat(48)}`,
    BOT_ORCHESTRATOR_ACCESS_KEY: `old-orchestrator-${"c".repeat(48)}`,
    DASHBOARD_ACCESS_KEY: `old-dashboard-${"d".repeat(48)}`,
    DB_HOST: "pgbouncer",
    DB_HOST_T: "pgbouncer-t",
    DB_NAME: "retdb",
    DB_PASS: password,
    DB_USER: "postgres",
    GUARDIAN_KEY: `old-guardian-${"e".repeat(48)}`,
    HUB_DOMAIN: "example.invalid",
    NODE_COOKIE: `old-cookie-${"f".repeat(48)}`,
    OPENAI_API_KEY: `old-openai-${"g".repeat(48)}`,
    PERMS_KEY: privateKey(),
    PGRST_DB_URI: `postgres://postgres:${password}@pgbouncer:5432/retdb`,
    PHX_KEY: `old-phx-${"h".repeat(48)}`,
    PSQL: `postgres://postgres:${password}@pgsql:5432/retdb`,
    SKETCHFAB_API_KEY: "",
    SMTP_PASS: `old-smtp-${"j".repeat(48)}`,
    SMTP_PORT: "2525",
    SMTP_SERVER: "smtp.example.invalid",
    SMTP_USER: "mailer@example.invalid",
    TENOR_API_KEY: "",
    UNRELATED_VALUE: "preserve-this-line"
  };
  for (const pair of profile.image_pairs) {
    values[pair.value_key] = pinnedImage(pair.value_key);
  }
  return values;
}

function sourceBytes(values, {
  lineEnding = "\n",
  permsLiteralBlock = true
} = {}) {
  const lines = ["---", "# exact historical source fixture"];
  for (const [name, value] of Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (name === "PERMS_KEY" && permsLiteralBlock) {
      const pemLines = value.replace(/\\n/gu, "\n").trimEnd().split("\n");
      lines.push("PERMS_KEY: |", ...pemLines.map(line => `  ${line}`));
    } else {
      lines.push(`${name}: ${JSON.stringify(value)}`);
    }
  }
  return Buffer.from(`${lines.join(lineEnding)}${lineEnding}`, "utf8");
}

function fixture({ values = sourceValues(), ...options } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-old-source-"));
  fs.chmodSync(root, 0o700);
  const sourcePath = path.join(root, "input-values.local.yaml");
  const bytes = sourceBytes(values, options);
  fs.writeFileSync(sourcePath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(sourcePath, 0o600);
  return { root, sourcePath, bytes };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function liveResources({
  encodedPullConfig = pullConfig(),
  secretResourceVersion = "secret-rv:101",
  serviceAccountResourceVersion = "serviceaccount-rv:202",
  deploymentResourceVersion = "deployment-rv:404",
  deploymentUid = "11111111-aaaa-4bbb-8ccc-222222222222",
  botImage = PARENT_IMAGE,
  parentServiceAccountName,
  parentImagePullSecrets,
  imagePullSecrets = [{ name: "ghcr-pull" }]
} = {}) {
  return {
    namespace: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "hcce",
        uid: NAMESPACE_UID,
        resourceVersion: "namespace-rv:303"
      }
    },
    secret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "ghcr-pull",
        namespace: "hcce",
        uid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        resourceVersion: secretResourceVersion
      },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": encodedPullConfig }
    },
    serviceAccount: {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: "default",
        namespace: "hcce",
        uid: "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb",
        resourceVersion: serviceAccountResourceVersion
      },
      imagePullSecrets
    },
    deployment: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "bot-orchestrator",
        namespace: "hcce",
        uid: deploymentUid,
        resourceVersion: deploymentResourceVersion
      },
      spec: {
        template: {
          spec: {
            containers: [{ name: "bot-orchestrator", image: botImage }],
            ...(parentServiceAccountName === undefined
              ? {}
              : { serviceAccountName: parentServiceAccountName }),
            ...(parentImagePullSecrets === undefined
              ? {}
              : { imagePullSecrets: parentImagePullSecrets })
          }
        }
      }
    }
  };
}

function fakeKubectlRunner(calls, {
  preAuth = liveResources(),
  first = liveResources(),
  second = first,
  third = second,
  failCall = -1,
  leakToStderr = false,
  afterCall,
  trace
} = {}) {
  return invocation => {
    const index = calls.length;
    calls.push({
      executable: invocation.executable,
      args: [...invocation.args],
      env: { ...invocation.env }
    });
    const kind = invocation.args.includes("deployment")
      ? "deployment"
      : invocation.args.includes("secret")
        ? "secret"
        : invocation.args.includes("serviceaccount")
          ? "serviceaccount"
          : "namespace";
    trace?.push(`kubectl:${kind}`);
    if (index === failCall) {
      return {
        status: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("fixed kubectl failure\n", "utf8")
      };
    }
    const snapshots = [first, second, third];
    const group = index < 4
      ? preAuth
      : snapshots[Math.min(Math.floor((index - 4) / 4), snapshots.length - 1)];
    const resource = kind === "secret"
      ? group.secret
      : kind === "serviceaccount"
        ? group.serviceAccount
        : kind === "deployment"
          ? group.deployment
          : group.namespace;
    const result = {
      status: 0,
      signal: null,
      stdout: Buffer.from(JSON.stringify(resource), "utf8"),
      stderr: leakToStderr
        ? Buffer.from(REGISTRY_CREDENTIAL, "utf8")
        : Buffer.alloc(0)
    };
    afterCall?.(index, kind);
    return result;
  };
}

function fakeOperationLeaseFactory(events = [], {
  failAcquire = false,
  failRefreshAt = -1,
  failAssertAt = -1,
  failAssertAfterEvent,
  loseAfterEvent,
  failRelease = false,
  releaseAppliesThenThrows = false,
  trace
} = {}) {
  return ({ kubectlExecutable, expectedKubeContext, namespace }) => {
    events.push({
      type: "factory",
      kubectlExecutable,
      expectedKubeContext,
      namespace
    });
    trace?.push("lease:factory");
    let acquired = false;
    let refreshCount = 0;
    let assertCount = 0;
    let eventFailureInjected = false;
    let lossInjected = false;
    const applyEventLoss = () => {
      if (!lossInjected && typeof loseAfterEvent === "string" &&
          trace?.includes(loseAfterEvent)) {
        acquired = false;
        lossInjected = true;
      }
    };
    return {
      acquire() {
        events.push({ type: "acquire" });
        trace?.push("lease:acquire");
        if (failAcquire) throw new Error("fixed lease acquire failure");
        acquired = true;
      },
      refresh() {
        applyEventLoss();
        const index = refreshCount;
        refreshCount += 1;
        events.push({ type: "refresh", index });
        trace?.push("lease:refresh");
        if (!acquired || index === failRefreshAt) {
          throw new Error("fixed lease refresh failure");
        }
      },
      assertFresh() {
        applyEventLoss();
        const index = assertCount;
        assertCount += 1;
        events.push({ type: "assert", index });
        trace?.push("lease:assert");
        const failAfterEvent = !eventFailureInjected &&
          typeof failAssertAfterEvent === "string" &&
          trace?.includes(failAssertAfterEvent);
        if (!acquired || index === failAssertAt || failAfterEvent) {
          eventFailureInjected = failAfterEvent || eventFailureInjected;
          throw new Error("fixed lease assertion failure");
        }
      },
      release() {
        applyEventLoss();
        events.push({ type: "release" });
        trace?.push("lease:release");
        if (!acquired || failRelease) {
          throw new Error("fixed lease release failure");
        }
        acquired = false;
        if (releaseAppliesThenThrows) {
          throw new Error("fixed lost release acknowledgement");
        }
      }
    };
  };
}

function fakeRegistryFetch({ status = 200, calls = [], trace } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), authorizationPresent: Boolean(init?.headers?.Authorization) });
    trace?.push("ghcr:request");
    if (String(url).startsWith("https://ghcr.io/token")) {
      return new Response(JSON.stringify({ token: "fixture-bearer" }), {
        status,
        headers: { "content-type": "application/json" }
      });
    }
    const digest = String(url).split("/").at(-1);
    return new Response(JSON.stringify({ schemaVersion: 2 }), {
      status,
      headers: {
        "content-type": "application/vnd.oci.image.manifest.v1+json",
        "docker-content-digest": digest
      }
    });
  };
}

function fakeProvenanceVerifier({ calls = [], trace, failure, result } = {}) {
  return invocation => {
    const configPath = path.join(invocation.dockerConfigDirectory, "config.json");
    calls.push({
      ...invocation,
      dockerConfigMode: fs.lstatSync(invocation.dockerConfigDirectory).mode & 0o7777,
      configPresent: fs.existsSync(configPath),
      configMatches: fs.readFileSync(configPath).toString("base64") === pullConfig()
    });
    trace?.push("provenance:verify");
    if (failure) throw failure;
    return result || Object.freeze({
      sourceCommit: PROVENANCE_COMMIT,
      invocationId: PROVENANCE_INVOCATION,
      images: Object.freeze({
        botOrchestrator: PARENT_IMAGE,
        botRunner: RUNNER_IMAGE,
        reticulum: RETICULUM_IMAGE
      })
    });
  };
}

function fakeArtifactSnapshotHelper({ calls = [], trace, failure } = {}) {
  return async invocation => {
    calls.push({
      receiptPath: invocation.receiptPath,
      receiptBundlePath: invocation.receiptBundlePath,
      botOrchestratorBundlePath: invocation.botOrchestratorBundlePath,
      botRunnerBundlePath: invocation.botRunnerBundlePath,
      reticulumBundlePath: invocation.reticulumBundlePath,
      privateParentDirectory: invocation.privateParentDirectory
    });
    trace?.push("provenance:snapshot");
    if (failure) throw failure;
    return invocation.callback({
      artifactPaths: {
        receiptPath: invocation.receiptPath,
        receiptBundlePath: invocation.receiptBundlePath,
        botOrchestratorBundlePath: invocation.botOrchestratorBundlePath,
        botRunnerBundlePath: invocation.botRunnerBundlePath,
        reticulumBundlePath: invocation.reticulumBundlePath
      },
      artifactBindings: undefined,
      privateWorkDirectory: invocation.privateParentDirectory,
      privateWorkDirectoryIdentity: undefined
    });
  };
}

function realArtifactSnapshotHelper(options) {
  return withRuntimeImageBuildProvenanceArtifactSnapshot({
    ...options,
    expectedSourceCommit: PROVENANCE_COMMIT
  });
}

function invocation(sourcePath, kubectlRunner, fetchImpl, extra = {}) {
  const artifactRoot = path.dirname(sourcePath);
  return {
    command: "complete",
    expectedKubeContext: CONTEXT,
    expectedNamespaceUid: NAMESPACE_UID,
    receiptPath: path.join(artifactRoot, "runtime-receipt.json"),
    receiptBundlePath: path.join(artifactRoot, "receipt.sigstore.json"),
    botOrchestratorBundlePath: path.join(
      artifactRoot, "bot-orchestrator.sigstore.json"
    ),
    botRunnerBundlePath: path.join(artifactRoot, "bot-runner.sigstore.json"),
    reticulumBundlePath: path.join(artifactRoot, "reticulum.sigstore.json"),
    privateWorkDirectory: artifactRoot,
    sourcePath,
    kubectlExecutable: "/usr/bin/false",
    kubectlRunner,
    fetchImpl,
    requestTimeoutMs: 500,
    operationLeaseFactory: fakeOperationLeaseFactory(),
    provenanceArtifactSnapshotHelper: fakeArtifactSnapshotHelper(),
    provenanceVerifier: fakeProvenanceVerifier(),
    ...extra
  };
}

function writeRuntimeArtifacts(sourcePath) {
  const root = path.dirname(sourcePath);
  const paths = {
    receiptPath: path.join(root, "runtime-receipt.json"),
    receiptBundlePath: path.join(root, "receipt.sigstore.json"),
    botOrchestratorBundlePath: path.join(root, "bot-orchestrator.sigstore.json"),
    botRunnerBundlePath: path.join(root, "bot-runner.sigstore.json"),
    reticulumBundlePath: path.join(root, "reticulum.sigstore.json")
  };
  const receipt = {
    images: {
      botOrchestrator: PARENT_IMAGE,
      botRunner: RUNNER_IMAGE,
      reticulum: RETICULUM_IMAGE
    },
    repository: RUNTIME_IMAGE_BUILD_REPOSITORY,
    repositoryId: RUNTIME_IMAGE_BUILD_REPOSITORY_ID,
    runAttempt: "2",
    runId: "31234567890",
    schemaVersion: 1,
    sourceCommit: PROVENANCE_COMMIT,
    sourceRef: RUNTIME_IMAGE_BUILD_SOURCE_REF,
    workflowPath: RUNTIME_IMAGE_BUILD_WORKFLOW_PATH,
    workflowSha: PROVENANCE_COMMIT
  };
  const receiptBytes = Buffer.from(
    `${canonicalRuntimeImageBuildReceiptJson(receipt)}\n`,
    "utf8"
  );
  fs.writeFileSync(paths.receiptPath, receiptBytes, { mode: 0o600, flag: "wx" });
  for (const [name, artifactPath] of Object.entries(paths)) {
    if (name === "receiptPath") continue;
    fs.writeFileSync(
      artifactPath,
      Buffer.from(JSON.stringify({ role: name, fixture: true }), "utf8"),
      { mode: 0o600, flag: "wx" }
    );
  }
  return { paths, receiptBytes };
}

async function expectCode(promiseFactory, code) {
  let captured;
  await assert.rejects(promiseFactory, error => {
    captured = error;
    return error instanceof ProcessLocalOldSourceCompletionError;
  });
  assert.equal(captured.code, code);
  return captured;
}

test("completes OLD from the stable live Secret and preserves every pre-existing byte", async () => {
  const input = fixture();
  const kubectlCalls = [];
  const registryCalls = [];
  const provenanceCalls = [];
  const leaseEvents = [];
  const trace = [];
  try {
    assert.equal(await completeProcessLocalOldSource(invocation(
      input.sourcePath,
      fakeKubectlRunner(kubectlCalls, { trace }),
      fakeRegistryFetch({ calls: registryCalls, trace }),
      {
        provenanceArtifactSnapshotHelper: fakeArtifactSnapshotHelper({ trace }),
        provenanceVerifier: fakeProvenanceVerifier({
          calls: provenanceCalls,
          trace
        }),
        operationLeaseFactory: fakeOperationLeaseFactory(leaseEvents, { trace }),
        replacementHooks: {
          afterRenameBeforeFsync() {
            trace.push("cas:renamed");
          }
        }
      }
    )), "aud065_old_source_completed_v1");
    const completed = fs.readFileSync(input.sourcePath);
    const values = parseLocalValuesSource(completed.toString("utf8"));
    assert.equal(values.get("OVERRIDE_BOT_RUNNER_IMAGE"), RUNNER_IMAGE);
    assert.equal(values.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"), pullConfig());
    assert.equal(verifyBotPullConfig({
      encoded: values.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"),
      botImage: values.get("OVERRIDE_BOT_ORCHESTRATOR_IMAGE"),
      runnerImage: values.get("OVERRIDE_BOT_RUNNER_IMAGE")
    }), true);
    const ending = "\n";
    const inserted = Buffer.from([
      `OVERRIDE_BOT_RUNNER_IMAGE: ${JSON.stringify(RUNNER_IMAGE)}`,
      `BOT_IMAGE_PULL_CONFIG_JSON_BASE64: ${JSON.stringify(pullConfig())}`,
      ""
    ].join(ending), "utf8");
    const completedText = completed.toString("utf8");
    const insertionOffset = completedText.indexOf(inserted.toString("utf8"));
    assert.notEqual(insertionOffset, -1);
    assert.equal(Buffer.concat([
      completed.subarray(0, insertionOffset),
      completed.subarray(insertionOffset + inserted.length)
    ]).equals(input.bytes), true);
    assert.equal(fs.lstatSync(input.sourcePath).mode & 0o7777, 0o600);
    assert.equal(kubectlCalls.length, 16);
    assert.equal(registryCalls.length, 4);
    assert.equal(provenanceCalls.length, 1);
    assert.equal(provenanceCalls[0].dockerConfigMode, 0o700);
    assert.equal(provenanceCalls[0].configPresent, true);
    assert.equal(provenanceCalls[0].configMatches, true);
    assert.equal(provenanceCalls[0].receiptPath,
      path.join(input.root, "runtime-receipt.json"));
    assert.equal(provenanceCalls[0].receiptBundlePath,
      path.join(input.root, "receipt.sigstore.json"));
    assert.equal(provenanceCalls[0].botOrchestratorBundlePath,
      path.join(input.root, "bot-orchestrator.sigstore.json"));
    assert.equal(provenanceCalls[0].botRunnerBundlePath,
      path.join(input.root, "bot-runner.sigstore.json"));
    assert.equal(provenanceCalls[0].reticulumBundlePath,
      path.join(input.root, "reticulum.sigstore.json"));
    assert.equal(Object.hasOwn(provenanceCalls[0], "expectedSourceCommit"), false);
    assert.equal(fs.existsSync(provenanceCalls[0].dockerConfigDirectory), false);
    assert.equal(JSON.stringify(provenanceCalls[0]).includes(REGISTRY_CREDENTIAL), false);
    assert.equal(JSON.stringify(provenanceCalls[0]).includes(pullConfig()), false);
    assert.deepEqual(leaseEvents.slice(0, 2).map(event => event.type), [
      "factory",
      "acquire"
    ]);
    assert.equal(leaseEvents.at(-1).type, "release");
    assert.deepEqual(trace.slice(0, 6), [
      "provenance:snapshot",
      "kubectl:namespace",
      "kubectl:secret",
      "kubectl:serviceaccount",
      "kubectl:deployment",
      "provenance:verify"
    ]);
    assert.equal(trace[6], "lease:factory");
    assert.equal(trace[7], "lease:acquire");
    assert.equal(trace.at(-1), "lease:release");
    let preliminaryReads = 0;
    for (const [index, event] of trace.entries()) {
      if (!event.startsWith("kubectl:")) continue;
      if (preliminaryReads < 4) {
        preliminaryReads += 1;
        continue;
      }
      assert.equal(trace[index - 1], "lease:assert");
      assert.equal(trace[index + 1], "lease:assert");
    }
    const firstRegistryRequest = trace.indexOf("ghcr:request");
    const lastRegistryRequest = trace.lastIndexOf("ghcr:request");
    assert.equal(trace[firstRegistryRequest - 1], "lease:assert");
    assert.deepEqual(trace.slice(lastRegistryRequest + 1, lastRegistryRequest + 3), [
      "lease:refresh",
      "lease:assert"
    ]);
    const casIndex = trace.indexOf("cas:renamed");
    assert.equal(trace[casIndex - 1], "lease:assert");
    assert.equal(trace[casIndex + 1], "lease:assert");
    for (const call of kubectlCalls) {
      assert.equal(call.args.includes("--context"), true);
      assert.equal(call.args[call.args.indexOf("--context") + 1], CONTEXT);
      const exposed = `${call.args.join("\0")}\0${Object.values(call.env).join("\0")}`;
      assert.equal(exposed.includes(REGISTRY_CREDENTIAL), false);
      assert.equal(exposed.includes(pullConfig()), false);
    }
  } finally {
    cleanup(input.root);
  }
});

test("CRLF completion is idempotent and verify is strictly read-only", async () => {
  const input = fixture({ lineEnding: "\r\n" });
  try {
    const firstRunner = fakeKubectlRunner([]);
    assert.equal(await completeProcessLocalOldSource(invocation(
      input.sourcePath,
      firstRunner,
      fakeRegistryFetch()
    )), "aud065_old_source_completed_v1");
    const completed = fs.readFileSync(input.sourcePath);
    assert.equal(completed.toString("utf8").replace(/\r\n/gu, "").includes("\n"), false);

    assert.equal(await completeProcessLocalOldSource(invocation(
      input.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch()
    )), "aud065_old_source_already_complete_v1");
    assert.equal(fs.readFileSync(input.sourcePath).equals(completed), true);

    assert.equal(await completeProcessLocalOldSource(invocation(
      input.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch(),
      { command: "verify" }
    )), "aud065_old_source_verified_v1");
    assert.equal(fs.readFileSync(input.sourcePath).equals(completed), true);
  } finally {
    cleanup(input.root);
  }
});

test("invalid local artifact arguments fail before any cluster read", async t => {
  const input = fixture();
  try {
    for (const field of [
      "receiptPath",
      "receiptBundlePath",
      "botOrchestratorBundlePath",
      "botRunnerBundlePath",
      "reticulumBundlePath",
      "privateWorkDirectory"
    ]) {
      await t.test(field, async () => {
        const kubectlCalls = [];
        const leaseEvents = [];
        await expectCode(() => completeProcessLocalOldSource(invocation(
          input.sourcePath,
          fakeKubectlRunner(kubectlCalls),
          fakeRegistryFetch(),
          {
            [field]: "relative/local-path",
            operationLeaseFactory: fakeOperationLeaseFactory(leaseEvents)
          }
        )), field === "privateWorkDirectory"
          ? "private_work_directory_invalid"
          : "runtime_artifact_path_invalid");
        assert.equal(kubectlCalls.length, 0);
        assert.deepEqual(leaseEvents, []);
        assert.equal(fs.readFileSync(input.sourcePath).equals(input.bytes), true);
      });
    }
  } finally {
    cleanup(input.root);
  }
});

test("physical artifacts, private work mode and the full OLD contract preflight before kubectl", async t => {
  await t.test("missing receipt", async () => {
    const input = fixture();
    const kubectlCalls = [];
    try {
      await expectCode(() => completeProcessLocalOldSource(invocation(
        input.sourcePath,
        fakeKubectlRunner(kubectlCalls),
        fakeRegistryFetch(),
        {
          provenanceArtifactSnapshotHelper: realArtifactSnapshotHelper
        }
      )), "old_source_completion_failed");
      assert.equal(kubectlCalls.length, 0);
      assert.equal(fs.readFileSync(input.sourcePath).equals(input.bytes), true);
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("0755 private work directory", async () => {
    const input = fixture();
    const kubectlCalls = [];
    try {
      fs.chmodSync(input.root, 0o755);
      await expectCode(() => completeProcessLocalOldSource(invocation(
        input.sourcePath,
        fakeKubectlRunner(kubectlCalls),
        fakeRegistryFetch(),
        { provenanceArtifactSnapshotHelper: realArtifactSnapshotHelper }
      )), "old_source_completion_failed");
      assert.equal(kubectlCalls.length, 0);
      assert.equal(fs.readFileSync(input.sourcePath).equals(input.bytes), true);
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("invalid historical OLD value", async () => {
    const values = sourceValues();
    delete values.SMTP_SERVER;
    const input = fixture({ values });
    const kubectlCalls = [];
    const snapshotCalls = [];
    try {
      await expectCode(() => completeProcessLocalOldSource(invocation(
        input.sourcePath,
        fakeKubectlRunner(kubectlCalls),
        fakeRegistryFetch(),
        {
          provenanceArtifactSnapshotHelper: fakeArtifactSnapshotHelper({
            calls: snapshotCalls
          })
        }
      )), "completed_source_invalid");
      assert.equal(kubectlCalls.length, 0);
      assert.equal(snapshotCalls.length, 0);
      assert.equal(fs.readFileSync(input.sourcePath).equals(input.bytes), true);
    } finally {
      cleanup(input.root);
    }
  });
});

test("bound snapshot closes artifact and private-directory swaps before credentials reach gh", async t => {
  await t.test("an original receipt swap cannot change the verifier input", async () => {
    const input = fixture();
    const artifacts = writeRuntimeArtifacts(input.sourcePath);
    const provenanceCalls = [];
    let snapshotDirectory;
    let snapshotReceiptPath;
    try {
      const baseVerifier = fakeProvenanceVerifier({ calls: provenanceCalls });
      assert.equal(await completeProcessLocalOldSource(invocation(
        input.sourcePath,
        fakeKubectlRunner([]),
        fakeRegistryFetch(),
        {
          provenanceArtifactSnapshotHelper: realArtifactSnapshotHelper,
          provenanceSnapshotHooks: {
            afterSnapshotReady(snapshot) {
              snapshotDirectory = snapshot.privateWorkDirectory;
              fs.writeFileSync(
                artifacts.paths.receiptPath,
                Buffer.from('{"swapped":true}\n', "utf8")
              );
            }
          },
          provenanceVerifier(invocationValue) {
            snapshotReceiptPath = invocationValue.receiptPath;
            assert.notEqual(snapshotReceiptPath, artifacts.paths.receiptPath);
            assert.equal(
              fs.readFileSync(snapshotReceiptPath).equals(artifacts.receiptBytes),
              true
            );
            assert.equal(typeof invocationValue.artifactBindings, "object");
            return baseVerifier(invocationValue);
          }
        }
      )), "aud065_old_source_completed_v1");
      assert.equal(provenanceCalls.length, 1);
      assert.equal(fs.existsSync(snapshotDirectory), false);
      assert.equal(fs.existsSync(snapshotReceiptPath), false);
      assert.equal(
        fs.readFileSync(artifacts.paths.receiptPath, "utf8"),
        '{"swapped":true}\n'
      );
      assert.deepEqual(
        fs.readdirSync(input.root).filter(name =>
          name.startsWith(".yenhubs-runtime-provenance-")
        ),
        []
      );
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("a post-Secret snapshot-directory swap cannot receive Docker auth", async () => {
    const input = fixture();
    writeRuntimeArtifacts(input.sourcePath);
    const kubectlCalls = [];
    const provenanceCalls = [];
    const leaseEvents = [];
    let snapshotDirectory;
    let movedDirectory;
    let replacementWasEmpty = false;
    try {
      await expectCode(() => completeProcessLocalOldSource(invocation(
        input.sourcePath,
        fakeKubectlRunner(kubectlCalls, {
          afterCall(index) {
            if (index !== 2) return;
            movedDirectory = `${snapshotDirectory}.moved`;
            fs.renameSync(snapshotDirectory, movedDirectory);
            fs.mkdirSync(snapshotDirectory, { mode: 0o700 });
            fs.chmodSync(snapshotDirectory, 0o700);
          }
        }),
        fakeRegistryFetch(),
        {
          provenanceArtifactSnapshotHelper: realArtifactSnapshotHelper,
          provenanceSnapshotHooks: {
            afterSnapshotReady(snapshot) {
              snapshotDirectory = snapshot.privateWorkDirectory;
            },
            afterCallback() {
              replacementWasEmpty = fs.readdirSync(snapshotDirectory).length === 0;
              fs.rmdirSync(snapshotDirectory);
              fs.renameSync(movedDirectory, snapshotDirectory);
            }
          },
          provenanceVerifier: fakeProvenanceVerifier({ calls: provenanceCalls }),
          operationLeaseFactory: fakeOperationLeaseFactory(leaseEvents)
        }
      )), "old_source_completion_failed");
      assert.equal(kubectlCalls.length, 4);
      assert.equal(replacementWasEmpty, true);
      assert.equal(provenanceCalls.length, 0);
      assert.deepEqual(leaseEvents, []);
      assert.equal(fs.existsSync(snapshotDirectory), false);
      assert.equal(fs.existsSync(movedDirectory), false);
      assert.equal(fs.readFileSync(input.sourcePath).equals(input.bytes), true);
      assert.deepEqual(
        fs.readdirSync(input.root).filter(name =>
          name.startsWith(".yenhubs-runtime-provenance-")
        ),
        []
      );
    } finally {
      cleanup(input.root);
    }
  });
});

test("partial state and another missing required key fail without writing", async () => {
  const partialValues = {
    ...sourceValues(),
    OVERRIDE_BOT_RUNNER_IMAGE: RUNNER_IMAGE
  };
  const partial = fixture({ values: partialValues });
  const calls = [];
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      partial.sourcePath,
      fakeKubectlRunner(calls),
      fakeRegistryFetch()
    )), "old_source_partial_additions");
    assert.equal(calls.length, 0);
    assert.equal(fs.readFileSync(partial.sourcePath).equals(partial.bytes), true);
  } finally {
    cleanup(partial.root);
  }

  const missingValues = sourceValues();
  delete missingValues.SMTP_SERVER;
  const missing = fixture({ values: missingValues });
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      missing.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch()
    )), "completed_source_invalid");
    assert.equal(fs.readFileSync(missing.sourcePath).equals(missing.bytes), true);
  } finally {
    cleanup(missing.root);
  }
});

test("live binding drift or denied GHCR access fails before the local CAS", async () => {
  const beforeLeaseDrift = fixture();
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      beforeLeaseDrift.sourcePath,
      fakeKubectlRunner([], {
        first: liveResources({ deploymentResourceVersion: "first-rv:changed" })
      }),
      fakeRegistryFetch()
    )), "live_pull_state_changed_before_lease");
    assert.equal(
      fs.readFileSync(beforeLeaseDrift.sourcePath).equals(beforeLeaseDrift.bytes),
      true
    );
  } finally {
    cleanup(beforeLeaseDrift.root);
  }

  const drift = fixture();
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      drift.sourcePath,
      fakeKubectlRunner([], {
        second: liveResources({ secretResourceVersion: "999" })
      }),
      fakeRegistryFetch()
    )), "live_pull_state_changed");
    assert.equal(fs.readFileSync(drift.sourcePath).equals(drift.bytes), true);
  } finally {
    cleanup(drift.root);
  }

  const parentDrift = fixture();
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      parentDrift.sourcePath,
      fakeKubectlRunner([], {
        second: liveResources({ deploymentResourceVersion: "999" })
      }),
      fakeRegistryFetch()
    )), "live_pull_state_changed");
    assert.equal(
      fs.readFileSync(parentDrift.sourcePath).equals(parentDrift.bytes),
      true
    );
  } finally {
    cleanup(parentDrift.root);
  }

  const parentUidDrift = fixture();
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      parentUidDrift.sourcePath,
      fakeKubectlRunner([], {
        second: liveResources({
          deploymentUid: "33333333-aaaa-4bbb-8ccc-444444444444"
        })
      }),
      fakeRegistryFetch()
    )), "live_pull_state_changed");
    assert.equal(
      fs.readFileSync(parentUidDrift.sourcePath).equals(parentUidDrift.bytes),
      true
    );
  } finally {
    cleanup(parentUidDrift.root);
  }

  const denied = fixture();
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      denied.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch({ status: 403 })
    )), "old_source_completion_failed");
    assert.equal(fs.readFileSync(denied.sourcePath).equals(denied.bytes), true);
  } finally {
    cleanup(denied.root);
  }

  const wrongBinding = fixture();
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      wrongBinding.sourcePath,
      fakeKubectlRunner([], {
        first: liveResources({ imagePullSecrets: [{ name: "other" }] })
      }),
      fakeRegistryFetch()
    )), "live_pull_binding_invalid");
    assert.equal(fs.readFileSync(wrongBinding.sourcePath).equals(wrongBinding.bytes), true);
  } finally {
    cleanup(wrongBinding.root);
  }

  const noisyKubectl = fixture();
  try {
    const error = await expectCode(() => completeProcessLocalOldSource(invocation(
      noisyKubectl.sourcePath,
      fakeKubectlRunner([], { leakToStderr: true }),
      fakeRegistryFetch()
    )), "kubectl_read_failed");
    assert.equal(`${error.message}\n${error.stack}`.includes(REGISTRY_CREDENTIAL), false);
    assert.equal(fs.readFileSync(noisyKubectl.sourcePath).equals(noisyKubectl.bytes), true);
  } finally {
    cleanup(noisyKubectl.root);
  }
});

test("preliminary Namespace, pull binding and parent Deployment reject unsafe state before materialization or gh", async t => {
  const auth = Buffer.from(REGISTRY_CREDENTIAL, "utf8").toString("base64");
  const cases = [
    ["credsStore helper", "old_source_completion_failed", () => liveResources({
      encodedPullConfig: encodedDockerConfig({
        auths: { "ghcr.io": { auth } },
        credsStore: "desktop"
      })
    })],
    ["credHelpers helper", "old_source_completion_failed", () => liveResources({
      encodedPullConfig: encodedDockerConfig({
        auths: { "ghcr.io": { auth } },
        credHelpers: { "ghcr.io": "desktop" }
      })
    })],
    ["corrupt Docker JSON", "old_source_completion_failed", () =>
      liveResources({ encodedPullConfig: "%%%" })],
    ["wrong Namespace UID", "namespace_uid_mismatch", () => {
      const resources = liveResources();
      resources.namespace.metadata.uid = "99999999-8888-4777-8666-555555555555";
      return resources;
    }],
    ["invalid ServiceAccount binding", "live_pull_binding_invalid", () => liveResources({
      imagePullSecrets: [{ name: "other" }]
    })],
    ["parent image outside OLD", "live_parent_image_mismatch", () => liveResources({
      botImage: `ghcr.io/yengalvez/bot-orchestrator@sha256:${"f".repeat(64)}`
    })],
    ["parent uses another ServiceAccount", "live_parent_pull_binding_invalid",
      () => liveResources({ parentServiceAccountName: "other" })],
    ["parent overrides imagePullSecrets", "live_parent_pull_binding_invalid",
      () => liveResources({ parentImagePullSecrets: [{ name: "other" }] })]
  ];
  for (const [name, expectedCode, resources] of cases) {
    await t.test(name, async () => {
      const input = fixture();
      const kubectlCalls = [];
      const provenanceCalls = [];
      const leaseEvents = [];
      let materializerCalls = 0;
      try {
        await expectCode(() => completeProcessLocalOldSource(invocation(
          input.sourcePath,
          fakeKubectlRunner(kubectlCalls, { preAuth: resources() }),
          fakeRegistryFetch(),
          {
            provenanceVerifier: fakeProvenanceVerifier({
              calls: provenanceCalls
            }),
            privateDockerConfigHelper: async () => {
              materializerCalls += 1;
              throw new Error("materializer must not run");
            },
            operationLeaseFactory: fakeOperationLeaseFactory(leaseEvents)
          }
        )), expectedCode);
        assert.equal(kubectlCalls.length, 4);
        assert.equal(materializerCalls, 0);
        assert.equal(provenanceCalls.length, 0);
        assert.deepEqual(leaseEvents, []);
        assert.equal(fs.readFileSync(input.sourcePath).equals(input.bytes), true);
      } finally {
        cleanup(input.root);
      }
    });
  }
});

test("the Lease gate keeps the live parent and derives only the runner from provenance", async () => {
  const input = fixture();
  const kubectlCalls = [];
  const registryCalls = [];
  const leaseEvents = [];
  const mismatchedParent =
    `ghcr.io/yengalvez/bot-orchestrator@sha256:${"e".repeat(64)}`;
  try {
    assert.equal(await completeProcessLocalOldSource(invocation(
      input.sourcePath,
      fakeKubectlRunner(kubectlCalls),
      fakeRegistryFetch({ calls: registryCalls }),
      {
        provenanceVerifier: fakeProvenanceVerifier({
          result: {
            sourceCommit: PROVENANCE_COMMIT,
            invocationId: PROVENANCE_INVOCATION,
            images: {
              botOrchestrator: mismatchedParent,
              botRunner: RUNNER_IMAGE,
              reticulum: RETICULUM_IMAGE
            }
          }
        }),
        operationLeaseFactory: fakeOperationLeaseFactory(leaseEvents)
      }
    )), "aud065_old_source_completed_v1");
    assert.equal(kubectlCalls.length, 16);
    assert.equal(registryCalls.length, 4);
    const manifestUrls = registryCalls
      .map(call => call.url)
      .filter(url => url.includes("/manifests/"));
    assert.deepEqual(new Set(manifestUrls), new Set([
      `https://ghcr.io/v2/yengalvez/bot-orchestrator/manifests/${
        PARENT_IMAGE.split("@")[1]
      }`,
      `https://ghcr.io/v2/yengalvez/bot-runner/manifests/${
        RUNNER_IMAGE.split("@")[1]
      }`
    ]));
    assert.equal(registryCalls.some(call => call.url.includes("e".repeat(64))), false);
    assert.deepEqual(leaseEvents.slice(0, 2).map(event => event.type), [
      "factory",
      "acquire"
    ]);
    assert.equal(leaseEvents.at(-1).type, "release");
    const completedValues = parseLocalValuesSource(
      fs.readFileSync(input.sourcePath, "utf8")
    );
    assert.equal(completedValues.get("OVERRIDE_BOT_ORCHESTRATOR_IMAGE"), PARENT_IMAGE);
    assert.equal(completedValues.get("OVERRIDE_BOT_RUNNER_IMAGE"), RUNNER_IMAGE);
  } finally {
    cleanup(input.root);
  }
});

test("post-CAS drift or read failure rolls back only after a fresh Lease proof", async () => {
  const drift = fixture();
  const driftCalls = [];
  const driftLeaseEvents = [];
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      drift.sourcePath,
      fakeKubectlRunner(driftCalls, {
        third: liveResources({ deploymentResourceVersion: "999" })
      }),
      fakeRegistryFetch(),
      {
        operationLeaseFactory: fakeOperationLeaseFactory(driftLeaseEvents)
      }
    )), "live_pull_state_changed_after_cas");
    assert.equal(driftCalls.length, 16);
    assert.equal(fs.readFileSync(drift.sourcePath).equals(drift.bytes), true);
    assert.deepEqual(
      fs.readdirSync(drift.root).filter(name => name.includes("aud065-new-")),
      []
    );
    assert.equal(driftLeaseEvents.at(-1).type, "release");
  } finally {
    cleanup(drift.root);
  }

  const unreadable = fixture();
  const unreadableLeaseEvents = [];
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      unreadable.sourcePath,
      fakeKubectlRunner([], { failCall: 12 }),
      fakeRegistryFetch(),
      {
        operationLeaseFactory: fakeOperationLeaseFactory(unreadableLeaseEvents)
      }
    )), "kubectl_read_failed");
    assert.equal(fs.readFileSync(unreadable.sourcePath).equals(unreadable.bytes), true);
    assert.deepEqual(
      fs.readdirSync(unreadable.root).filter(name => name.includes("aud065-new-")),
      []
    );
    assert.equal(unreadableLeaseEvents.at(-1).type, "release");
  } finally {
    cleanup(unreadable.root);
  }
});

test("Lease acquisition fails before CAS and post-CAS loss preserves completed for reconciliation", async () => {
  const unavailable = fixture();
  const unavailableCalls = [];
  const unavailableEvents = [];
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      unavailable.sourcePath,
      fakeKubectlRunner(unavailableCalls),
      fakeRegistryFetch(),
      {
        operationLeaseFactory: fakeOperationLeaseFactory(unavailableEvents, {
          failAcquire: true
        })
      }
    )), "operation_lease_acquire_failed");
    assert.equal(unavailableCalls.length, 4);
    assert.equal(fs.readFileSync(unavailable.sourcePath).equals(unavailable.bytes), true);
    assert.deepEqual(unavailableEvents.map(event => event.type), ["factory", "acquire"]);
  } finally {
    cleanup(unavailable.root);
  }

  const lost = fixture();
  const lostEvents = [];
  const trace = [];
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      lost.sourcePath,
      fakeKubectlRunner([], { trace }),
      fakeRegistryFetch({ trace }),
      {
        operationLeaseFactory: fakeOperationLeaseFactory(lostEvents, {
          loseAfterEvent: "cas:renamed",
          trace
        }),
        replacementHooks: {
          afterRenameBeforeFsync() {
            trace.push("cas:renamed");
          }
        }
      }
    )), "old_source_reconciliation_required");
    const completed = fs.readFileSync(lost.sourcePath);
    const completedValues = parseLocalValuesSource(completed.toString("utf8"));
    assert.equal(completed.equals(lost.bytes), false);
    assert.equal(completedValues.get("OVERRIDE_BOT_RUNNER_IMAGE"), RUNNER_IMAGE);
    assert.equal(
      completedValues.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"),
      pullConfig()
    );
    assert.deepEqual(
      fs.readdirSync(lost.root).filter(name => name.includes("aud065-new-")),
      []
    );
    assert.equal(lostEvents.at(-1).type, "release");
  } finally {
    cleanup(lost.root);
  }
});

test("an applied Lease release with a lost ACK preserves completed for idempotent reconciliation", async () => {
  const input = fixture();
  const releaseEvents = [];
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      input.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch(),
      {
        operationLeaseFactory: fakeOperationLeaseFactory(releaseEvents, {
          releaseAppliesThenThrows: true
        })
      }
    )), "operation_lease_release_failed");
    const completed = fs.readFileSync(input.sourcePath);
    assert.equal(completed.equals(input.bytes), false);
    assert.equal(releaseEvents.at(-1).type, "release");
    assert.deepEqual(
      fs.readdirSync(input.root).filter(name => name.includes("aud065-new-")),
      []
    );
    assert.equal(await completeProcessLocalOldSource(invocation(
      input.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch()
    )), "aud065_old_source_already_complete_v1");
    assert.equal(fs.readFileSync(input.sourcePath).equals(completed), true);
    assert.equal(await completeProcessLocalOldSource(invocation(
      input.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch(),
      { command: "verify" }
    )), "aud065_old_source_verified_v1");
    assert.equal(fs.readFileSync(input.sourcePath).equals(completed), true);
  } finally {
    cleanup(input.root);
  }
});

test("unsafe paths, invalid provenance and a same-user race never get overwritten", async () => {
  const unsafe = fixture();
  try {
    fs.chmodSync(unsafe.sourcePath, 0o640);
    await expectCode(() => completeProcessLocalOldSource(invocation(
      unsafe.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch()
    )), "old_source_completion_failed");
  } finally {
    cleanup(unsafe.root);
  }

  const invalidProvenance = fixture();
  const invalidCalls = [];
  const invalidLeaseEvents = [];
  let invalidCasCalls = 0;
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      invalidProvenance.sourcePath,
      fakeKubectlRunner(invalidCalls),
      fakeRegistryFetch(),
      {
        provenanceVerifier: fakeProvenanceVerifier({
          failure: new Error("fixed invalid provenance")
        }),
        operationLeaseFactory: fakeOperationLeaseFactory(invalidLeaseEvents),
        replacementHooks: {
          beforeRename() {
            invalidCasCalls += 1;
          }
        }
      }
    )), "old_source_completion_failed");
    assert.equal(invalidCalls.length, 4);
    assert.deepEqual(invalidLeaseEvents, []);
    assert.equal(invalidCasCalls, 0);
    assert.equal(
      fs.readFileSync(invalidProvenance.sourcePath).equals(invalidProvenance.bytes),
      true
    );
  } finally {
    cleanup(invalidProvenance.root);
  }

  const raced = fixture();
  const foreign = Buffer.from("FOREIGN_VALUE: concurrent-writer\n", "utf8");
  try {
    await expectCode(() => completeProcessLocalOldSource(invocation(
      raced.sourcePath,
      fakeKubectlRunner([]),
      fakeRegistryFetch(),
      {
        replacementHooks: {
          beforeRename() {
            fs.writeFileSync(raced.sourcePath, foreign, { mode: 0o600 });
          }
        }
      }
    )), "old_source_completion_failed");
    assert.equal(fs.readFileSync(raced.sourcePath).equals(foreign), true);
    assert.deepEqual(
      fs.readdirSync(raced.root).filter(name => name.includes("aud065-new-")),
      []
    );
  } finally {
    cleanup(raced.root);
  }
});

test("CLI has no source-path escape hatch and emits one fixed value-free failure", () => {
  const result = spawnSync(process.execPath, [
    CLI,
    "complete",
    "--expected-kube-context", CONTEXT,
    "--expected-namespace-uid", NAMESPACE_UID,
    "--runner-image", `invalid-${REGISTRY_CREDENTIAL}`
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "AUD-065 OLD source completion failed closed\n");
  assert.equal(result.stderr.includes(REGISTRY_CREDENTIAL), false);
});

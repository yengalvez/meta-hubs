import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUNTIME_IMAGE_BUILD_REPOSITORIES,
  RUNTIME_IMAGE_BUILD_REPOSITORY,
  RUNTIME_IMAGE_BUILD_REPOSITORY_ID,
  RUNTIME_IMAGE_BUILD_SOURCE_REF,
  RUNTIME_IMAGE_BUILD_WORKFLOW_PATH,
  canonicalRuntimeImageBuildReceiptJson,
  inspectRuntimeImageBuildProvenanceArtifacts
} from "../../deployment/verify-runtime-image-build-provenance.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "hubs-cloud/community-edition/package.json"));
const YAML = require("yaml");
const actions = Object.freeze({
  build: "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
  attest: "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
  upload: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
});

function workflow() {
  return YAML.parse(fs.readFileSync(path.join(root, "hubs-cloud", RUNTIME_IMAGE_BUILD_WORKFLOW_PATH), "utf8"));
}

test("coordinated runtime producer exists at the consumer-owned workflow path", () => {
  const workflowPath = path.join(root, "hubs-cloud", RUNTIME_IMAGE_BUILD_WORKFLOW_PATH);
  assert.ok(fs.existsSync(workflowPath), "the required coordinated producer is missing");
  assert.equal(workflow().name, "runtime-images-build-push");
});

test("workflow publishes one complete same-run AMD64 three-image/four-bundle set", () => {
  const value = workflow();
  assert.deepEqual(Object.keys(value.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(value.on.workflow_dispatch.inputs), ["use_build_cache"]);
  assert.equal(value.on.workflow_dispatch.inputs.use_build_cache.type, "boolean");
  assert.deepEqual(value.permissions, { contents: "read" });
  assert.equal(value.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(value.jobs), ["build"]);
  const job = value.jobs.build;
  assert.equal(job.if, "github.repository == 'yengalvez/hubs-cloud' && github.repository_id == '1153407749' && github.ref == 'refs/heads/master'");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.deepEqual(job.permissions,
    { contents: "read", packages: "write", "id-token": "write", attestations: "write" });
  const steps = job.steps;
  const byId = Object.fromEntries(steps.filter(step => step.id).map(step => [step.id, step]));
  for (const step of steps) {
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.if, undefined, "no always(), optional or denial-bypassing publication");
    if (step.uses) assert.match(step.uses, /^[a-zA-Z0-9/-]+@[a-f0-9]{40}$/u);
  }
  assert.equal(byId.checkout.with.ref, "${{ github.sha }}");
  assert.equal(byId.checkout.with["persist-credentials"], false);
  assert.equal(byId.source.run, "node .github/scripts/runtime-image-build-receipt.mjs --check-source");
  assert.ok(steps.indexOf(byId.source) < steps.findIndex(step => step.name === "Select approved GHCR credentials"));
  const builds = [
    ["reticulum", "reticulum", "community-edition/services/reticulum", "Dockerfile"],
    ["bot-orchestrator", "botOrchestrator", "community-edition/services/bot-orchestrator", "Dockerfile"],
    ["bot-runner", "botRunner", "community-edition/services/bot-orchestrator", "Dockerfile.runner"]
  ];
  assert.equal(steps.filter(step => step.uses === actions.build).length, 3);
  assert.equal(steps.filter(step => step.uses === actions.attest).length, 4);
  for (const [id, role, context, dockerfile] of builds) {
    const build = byId[id];
    assert.equal(build.uses, actions.build);
    assert.equal(build.with.context, context);
    assert.equal(build.with.file, `${context}/${dockerfile}`);
    assert.ok(fs.existsSync(path.join(root, "hubs-cloud", build.with.file)));
    assert.equal(build.with.platforms, "linux/amd64");
    assert.equal(build.with.tags,
      `${RUNTIME_IMAGE_BUILD_REPOSITORIES[role]}:sha-\${{ github.sha }}-run-\${{ github.run_id }}-\${{ github.run_attempt }}`);
    assert.equal(build.with.push, true);
    assert.equal(build.with.provenance, "mode=max");
    assert.equal(build.with.sbom, true);
    assert.ok(steps.indexOf(build) < steps.indexOf(byId.receipt));
    const attestation = byId[`attest-${id}`];
    assert.equal(attestation.uses, actions.attest);
    assert.deepEqual(attestation.with, {
      "subject-name": RUNTIME_IMAGE_BUILD_REPOSITORIES[role],
      "subject-digest": `\${{ steps.${id}.outputs.digest }}`,
      "push-to-registry": true,
      "create-storage-record": false
    });
    assert.ok(steps.indexOf(byId.receipt) < steps.indexOf(attestation));
    assert.ok(steps.indexOf(attestation) < steps.indexOf(byId.bundles));
  }
  assert.deepEqual(byId.receipt.env, {
    RETICULUM_DIGEST: "${{ steps.reticulum.outputs.digest }}",
    BOT_ORCHESTRATOR_DIGEST: "${{ steps.bot-orchestrator.outputs.digest }}",
    BOT_RUNNER_DIGEST: "${{ steps.bot-runner.outputs.digest }}"
  });
  assert.match(byId.receipt.run, /node \.github\/scripts\/runtime-image-build-receipt\.mjs > "\$RUNNER_TEMP\/runtime-image-build\/receipt\.json"/u);
  assert.deepEqual(byId["attest-receipt"].with,
    { "subject-path": "${{ runner.temp }}/runtime-image-build/receipt.json", "create-storage-record": false });
  assert.ok(steps.indexOf(byId["attest-receipt"]) < steps.indexOf(byId.bundles));
  assert.deepEqual(byId.bundles.env, {
    RECEIPT_BUNDLE: "${{ steps.attest-receipt.outputs.bundle-path }}",
    RETICULUM_BUNDLE: "${{ steps.attest-reticulum.outputs.bundle-path }}",
    BOT_ORCHESTRATOR_BUNDLE: "${{ steps.attest-bot-orchestrator.outputs.bundle-path }}",
    BOT_RUNNER_BUNDLE: "${{ steps.attest-bot-runner.outputs.bundle-path }}"
  });
  assert.ok(steps.indexOf(byId.bundles) < steps.indexOf(byId.publish));
  assert.equal(byId.publish.uses, actions.upload);
  assert.deepEqual(byId.publish.with, {
    name: "runtime-image-build-${{ github.run_id }}-${{ github.run_attempt }}",
    path: ["receipt.json", "receipt.bundle.json", "reticulum.bundle.json",
      "bot-orchestrator.bundle.json", "bot-runner.bundle.json"]
      .map(name => `\${{ runner.temp }}/runtime-image-build/${name}`).join("\n") + "\n",
    "if-no-files-found": "error", "retention-days": 7,
    overwrite: false, "include-hidden-files": false
  });
});

test("producer receipt passes the existing artifact-format inspector, not signature verification", async () => {
  const producer = await import("../../hubs-cloud/.github/scripts/runtime-image-build-receipt.mjs");
  assert.equal(producer.REPOSITORY, RUNTIME_IMAGE_BUILD_REPOSITORY);
  assert.equal(producer.REPOSITORY_ID, RUNTIME_IMAGE_BUILD_REPOSITORY_ID);
  assert.equal(producer.SOURCE_REF, RUNTIME_IMAGE_BUILD_SOURCE_REF);
  assert.equal(producer.WORKFLOW_PATH, RUNTIME_IMAGE_BUILD_WORKFLOW_PATH);
  assert.deepEqual(producer.IMAGE_REPOSITORIES, RUNTIME_IMAGE_BUILD_REPOSITORIES);
  const commit = "a".repeat(40);
  const receipt = producer.createRuntimeImageBuildReceipt({
    GITHUB_REPOSITORY: producer.REPOSITORY,
    GITHUB_REPOSITORY_ID: producer.REPOSITORY_ID,
    GITHUB_REF: producer.SOURCE_REF,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_WORKFLOW_REF: `${producer.REPOSITORY}/${producer.WORKFLOW_PATH}@${producer.SOURCE_REF}`,
    GITHUB_SHA: commit, GITHUB_WORKFLOW_SHA: commit,
    GITHUB_RUN_ID: "31234567890", GITHUB_RUN_ATTEMPT: "2",
    RETICULUM_DIGEST: `sha256:${"d".repeat(64)}`,
    BOT_ORCHESTRATOR_DIGEST: `sha256:${"b".repeat(64)}`,
    BOT_RUNNER_DIGEST: `sha256:${"c".repeat(64)}`
  }, commit);
  const text = `${JSON.stringify(receipt)}\n`;
  assert.equal(text, `${canonicalRuntimeImageBuildReceiptJson(receipt)}\n`);
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runtime-format-test-"));
  fs.chmodSync(directory, 0o700);
  const paths = {
    receiptPath: path.join(directory, "receipt.json"),
    receiptBundlePath: path.join(directory, "receipt.bundle.json"),
    reticulumBundlePath: path.join(directory, "reticulum.bundle.json"),
    botOrchestratorBundlePath: path.join(directory, "bot-orchestrator.bundle.json"),
    botRunnerBundlePath: path.join(directory, "bot-runner.bundle.json")
  };
  try {
    for (const [key, filename] of Object.entries(paths)) {
      fs.writeFileSync(filename, key === "receiptPath" ? text :
        `${JSON.stringify({ unsignedFixture: key })}\n`, { flag: "wx", mode: 0o600 });
    }
    assert.equal(inspectRuntimeImageBuildProvenanceArtifacts({ ...paths, expectedSourceCommit: commit }), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt gate inputs own the producer bytes without invalidating unrelated Dialog", () => {
  const sources = [
    "cloud\t.github/scripts/runtime-image-build-receipt.mjs",
    "cloud\t.github/scripts/runtime-image-build-receipt.test.mjs",
    `cloud\t${RUNTIME_IMAGE_BUILD_WORKFLOW_PATH}`
  ];
  const inputs = section => {
    const result = spawnSync("bash", ["-c",
      'source "$1/scripts/verify-project.sh"; verification_section_inputs "$2"',
      "runtime-producer-gate", root, section], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", LC_ALL: "C" },
      encoding: "utf8", timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout.trimEnd().split("\n");
  };
  for (const section of ["security", "recovery", "h5"]) {
    const closure = inputs(section);
    for (const source of sources) assert.ok(closure.includes(source), `${section}: ${source}`);
  }
  const dialog = inputs("dialog");
  for (const source of sources) assert.equal(dialog.includes(source), false);
  assert.match(fs.readFileSync(path.join(root, "scripts/test-aud065.sh"), "utf8"),
    /node --test --test-concurrency=1 "\$ROOT_DIR\/hubs-cloud\/\.github\/scripts\/runtime-image-build-receipt\.test\.mjs" "\$ROOT_DIR\/tests\/scripts\/runtime-image-build-workflow\.test\.mjs"/u);
  const cloudSecurity = YAML.parse(fs.readFileSync(path.join(root, "hubs-cloud/.github/workflows/security-ci.yml"), "utf8"));
  assert.ok(cloudSecurity.jobs["static-security"].steps.some(step =>
    step.run === "node --test .github/scripts/runtime-image-build-receipt.test.mjs"));
});

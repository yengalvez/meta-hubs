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
  ProcessLocalCandidateValuesError,
  manageProcessLocalCandidateValues as manageProcessLocalCandidateValuesProduct,
  manageProcessLocalCandidateValuesForTest as manageProcessLocalCandidateValues
} from "../../deployment/manage-process-local-candidate-values-from-keychain.mjs";
import { parseLocalValuesSource } from "../../deployment/parse-local-values.mjs";
import { loadProcessLocalRotationProfile } from "../../deployment/process-local-rotation.mjs";
import { withPrivateDockerConfig } from "../../deployment/with-private-docker-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(
  ROOT,
  "deployment/manage-process-local-candidate-values-from-keychain.mjs"
);
const ACCOUNT = "info@virtualmente.com";
const PREFIX = "YenHubs-AUD065-NEW-Fixture";
const USERNAME = "yengalvez";
const NEW_TOKEN = `fixture-new-registry-${"N".repeat(40)}`;
const RUNNER_IMAGE = `ghcr.io/yengalvez/bot-runner@sha256:${"d".repeat(64)}`;
const RETICULUM_IMAGE = `ghcr.io/yengalvez/reticulum@sha256:${"e".repeat(64)}`;
const ORCHESTRATOR_IMAGE =
  `ghcr.io/yengalvez/bot-orchestrator@sha256:${"f".repeat(64)}`;
const profile = loadProcessLocalRotationProfile();

function privateKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey.replace(/\r?\n/gu, "\\n");
}

function pullConfig(token = NEW_TOKEN) {
  return Buffer.from(JSON.stringify({
    auths: {
      "ghcr.io": {
        auth: Buffer.from(`${USERNAME}:${token}`, "utf8").toString("base64")
      }
    }
  }), "utf8").toString("base64");
}

function pinnedImage(valueKey) {
  const contract = profile.image_pairs.find(pair => pair.value_key === valueKey);
  return `${contract.repositories[0]}@sha256:${
    createHash("sha256").update(`baseline-${valueKey}`).digest("hex")
  }`;
}

function baselineValues({ encodedPullConfig = pullConfig() } = {}) {
  const password = `New_Db_Password_${"z".repeat(48)}`;
  const values = {
    Namespace: "hcce",
    ADM_EMAIL: "admin@example.invalid",
    BOT_ACCESS_KEY: `new-bot-${"a".repeat(48)}`,
    BOT_RUNNER_ACCESS_KEY: `new-runner-${"b".repeat(48)}`,
    BOT_ORCHESTRATOR_ACCESS_KEY: `new-orchestrator-${"c".repeat(48)}`,
    DASHBOARD_ACCESS_KEY: `new-dashboard-${"d".repeat(48)}`,
    BOT_IMAGE_PULL_CONFIG_JSON_BASE64: encodedPullConfig,
    BOT_RUNNER_ACTIVATION_PHASE: "bootstrap",
    DB_HOST: "pgbouncer",
    DB_HOST_T: "pgbouncer-t",
    DB_NAME: "retdb",
    DB_PASS: password,
    DB_USER: "postgres",
    GUARDIAN_KEY: `new-guardian-${"e".repeat(48)}`,
    HUB_DOMAIN: "example.invalid",
    NODE_COOKIE: `new-cookie-${"f".repeat(48)}`,
    OPENAI_API_KEY: `new-openai-${"g".repeat(48)}`,
    PERMS_KEY: privateKey(),
    PGRST_DB_URI: `postgres://postgres:${password}@pgbouncer:5432/retdb`,
    PHX_KEY: `new-phx-${"h".repeat(48)}`,
    PSQL: `postgres://postgres:${password}@pgsql:5432/retdb`,
    SKETCHFAB_API_KEY: "",
    SMTP_PASS: `new-smtp-${"j".repeat(48)}`,
    SMTP_PORT: "2525",
    SMTP_SERVER: "smtp.example.invalid",
    SMTP_USER: "mailer@example.invalid",
    TENOR_API_KEY: "",
    UNRELATED_VALUE: "must-remain-byte-identical"
  };
  for (const pair of profile.image_pairs) values[pair.value_key] = pinnedImage(pair.value_key);
  values.OVERRIDE_BOT_RUNNER_IMAGE = RUNNER_IMAGE;
  return values;
}

function sourceBytes(values, lineEnding = "\n") {
  const lines = ["---", "# rotated canonical baseline fixture"];
  for (const [name, value] of Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`${name}: ${JSON.stringify(value)}`);
  }
  return Buffer.from(`${lines.join(lineEnding)}${lineEnding}`, "utf8");
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-candidate-"));
  fs.chmodSync(root, 0o700);
  const canonicalPath = path.join(root, "input-values.local.yaml");
  const candidatePath = path.join(root, "candidate-values.yaml");
  const receiptPath = path.join(root, "runtime-images-receipt.json");
  const receiptBundlePath = path.join(root, "runtime-images-receipt.sigstore.json");
  const botOrchestratorBundlePath = path.join(root, "bot-orchestrator.sigstore.json");
  const botRunnerBundlePath = path.join(root, "bot-runner.sigstore.json");
  const reticulumBundlePath = path.join(root, "reticulum.sigstore.json");
  const bytes = sourceBytes(baselineValues(options), options.lineEnding || "\n");
  fs.writeFileSync(canonicalPath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(canonicalPath, 0o600);
  for (const artifactPath of [
    receiptPath,
    receiptBundlePath,
    botOrchestratorBundlePath,
    botRunnerBundlePath,
    reticulumBundlePath
  ]) {
    fs.writeFileSync(artifactPath, "{}", { mode: 0o600, flag: "wx" });
    fs.chmodSync(artifactPath, 0o600);
  }
  return {
    root,
    canonicalPath,
    candidatePath,
    receiptPath,
    receiptBundlePath,
    botOrchestratorBundlePath,
    botRunnerBundlePath,
    reticulumBundlePath,
    bytes
  };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writePrivate(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}

function unlinkQuarantineNames(root) {
  return fs.readdirSync(root).filter(name =>
    name.startsWith(".yenhubs-unlink-quarantine-v2-")
  );
}

function fakeSecurityRunner(calls, { fail = false } = {}) {
  return invocation => {
    calls.push({
      executable: invocation.executable,
      args: [...invocation.args],
      env: { ...invocation.env }
    });
    return fail
      ? {
          status: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("fixed keychain failure\n", "utf8")
        }
      : {
          status: 0,
          signal: null,
          stdout: Buffer.from(`${NEW_TOKEN}\n`, "utf8"),
          stderr: Buffer.alloc(0)
        };
  };
}

function fakeRegistryFetch({ status = 200, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), authorizationPresent: Boolean(init?.headers?.Authorization) });
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

function fakeProvenanceVerifier(calls = [], {
  fail = false,
  images = {
    botOrchestrator: ORCHESTRATOR_IMAGE,
    botRunner: RUNNER_IMAGE,
    reticulum: RETICULUM_IMAGE
  }
} = {}) {
  return options => {
    const directory = fs.lstatSync(options.dockerConfigDirectory, { bigint: true });
    const configPath = path.join(options.dockerConfigDirectory, "config.json");
    const config = fs.lstatSync(configPath, { bigint: true });
    const configBytes = fs.readFileSync(configPath);
    calls.push({
      ...options,
      directoryMode: Number(directory.mode & 0o7777n),
      configMode: Number(config.mode & 0o7777n),
      configLinks: config.nlink,
      configBytes
    });
    if (fail) throw new Error("fixed invalid provenance receipt");
    return Object.freeze({
      sourceCommit: "a".repeat(40),
      invocationId: "https://github.com/yengalvez/hubs-cloud/actions/runs/1/attempts/1",
      images: Object.freeze({ ...images })
    });
  };
}

function invocation(input, command, phase, securityRunner, fetchImpl, extra = {}) {
  return {
    command,
    candidateValuesSource: input.candidatePath,
    receiptPath: input.receiptPath,
    receiptBundlePath: input.receiptBundlePath,
    botOrchestratorBundlePath: input.botOrchestratorBundlePath,
    botRunnerBundlePath: input.botRunnerBundlePath,
    reticulumBundlePath: input.reticulumBundlePath,
    expectedPhase: phase,
    keychainAccount: ACCOUNT,
    keychainPrefix: PREFIX,
    ghcrUsername: USERNAME,
    securityRunner,
    fetchImpl,
    requestTimeoutMs: 500,
    canonicalValuesSource: input.canonicalPath,
    provenanceVerifier: fakeProvenanceVerifier(),
    ...extra
  };
}

async function expectCode(factory, code) {
  let captured;
  await assert.rejects(factory, error => {
    captured = error;
    return error instanceof ProcessLocalCandidateValuesError;
  });
  assert.equal(captured.code, code);
}

test("create publishes a separate private candidate and leaves the rotated baseline exact", async () => {
  const input = fixture();
  const securityCalls = [];
  const registryCalls = [];
  const provenanceCalls = [];
  const materializerCalls = [];
  try {
    assert.equal(await manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner(securityCalls),
      fakeRegistryFetch({ calls: registryCalls }),
      {
        provenanceVerifier: fakeProvenanceVerifier(provenanceCalls),
        dockerConfigMaterializer(options) {
          materializerCalls.push({
            privateParentDirectory: options.privateParentDirectory,
            encodedPresent: typeof options.encodedDockerConfig === "string" &&
              options.encodedDockerConfig.length > 0
          });
          return withPrivateDockerConfig(options);
        }
      }
    )), "aud065_candidate_values_created");
    assert.equal(fs.readFileSync(input.canonicalPath).equals(input.bytes), true);
    assert.equal(fs.lstatSync(input.candidatePath).mode & 0o7777, 0o600);
    const candidate = parseLocalValuesSource(fs.readFileSync(input.candidatePath, "utf8"));
    assert.equal(candidate.get("OVERRIDE_RETICULUM_IMAGE"), RETICULUM_IMAGE);
    assert.equal(candidate.get("OVERRIDE_BOT_ORCHESTRATOR_IMAGE"), ORCHESTRATOR_IMAGE);
    assert.equal(candidate.get("OVERRIDE_BOT_RUNNER_IMAGE"), RUNNER_IMAGE);
    assert.equal(candidate.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"), pullConfig());
    assert.equal(candidate.get("BOT_RUNNER_ACTIVATION_PHASE"), "bootstrap");
    assert.equal(candidate.get("UNRELATED_VALUE"), "must-remain-byte-identical");
    assert.equal(registryCalls.length > 0, true);
    assert.equal(provenanceCalls.length, 1);
    assert.equal(provenanceCalls[0].receiptPath, input.receiptPath);
    assert.equal(provenanceCalls[0].receiptBundlePath, input.receiptBundlePath);
    assert.equal(
      provenanceCalls[0].botOrchestratorBundlePath,
      input.botOrchestratorBundlePath
    );
    assert.equal(provenanceCalls[0].botRunnerBundlePath, input.botRunnerBundlePath);
    assert.equal(provenanceCalls[0].reticulumBundlePath, input.reticulumBundlePath);
    assert.equal(provenanceCalls[0].directoryMode, 0o700);
    assert.equal(provenanceCalls[0].configMode, 0o600);
    assert.equal(provenanceCalls[0].configLinks, 1n);
    assert.equal(
      provenanceCalls[0].configBytes.equals(Buffer.from(pullConfig(), "base64")),
      true
    );
    assert.equal(fs.existsSync(provenanceCalls[0].dockerConfigDirectory), false);
    assert.deepEqual(materializerCalls, [{
      privateParentDirectory: input.root,
      encodedPresent: true
    }]);
    assert.deepEqual(securityCalls[0].args, [
      "find-generic-password",
      "-w",
      "-s",
      `${PREFIX}-GHCR_TOKEN`,
      "-a",
      ACCOUNT
    ]);
    const exposed = `${securityCalls[0].args.join("\0")}\0${
      Object.values(securityCalls[0].env).join("\0")
    }`;
    assert.equal(exposed.includes(NEW_TOKEN), false);
    provenanceCalls[0].configBytes.fill(0);
  } finally {
    cleanup(input.root);
  }
});

test("the materializer return cannot replace the provenance verifier result", async () => {
  const input = fixture();
  const maliciousImages = Object.freeze({
    botOrchestrator:
      `ghcr.io/yengalvez/bot-orchestrator@sha256:${"1".repeat(64)}`,
    botRunner: `ghcr.io/yengalvez/bot-runner@sha256:${"2".repeat(64)}`,
    reticulum: `ghcr.io/yengalvez/reticulum@sha256:${"3".repeat(64)}`
  });
  try {
    assert.equal(await manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch(),
      {
        async dockerConfigMaterializer(options) {
          await withPrivateDockerConfig(options);
          return Object.freeze({ images: maliciousImages });
        }
      }
    )), "aud065_candidate_values_created");
    const candidate = parseLocalValuesSource(fs.readFileSync(input.candidatePath, "utf8"));
    assert.equal(candidate.get("OVERRIDE_RETICULUM_IMAGE"), RETICULUM_IMAGE);
    assert.equal(candidate.get("OVERRIDE_BOT_ORCHESTRATOR_IMAGE"), ORCHESTRATOR_IMAGE);
    assert.equal(candidate.get("OVERRIDE_BOT_RUNNER_IMAGE"), RUNNER_IMAGE);
  } finally {
    cleanup(input.root);
  }
});

test("the Docker config materializer must invoke its verifier callback exactly once", async () => {
  const input = fixture();
  try {
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch(),
      {
        async dockerConfigMaterializer(options) {
          return withPrivateDockerConfig({
            ...options,
            async callback(directory) {
              const first = await options.callback(directory);
              try {
                await options.callback(directory);
              } catch (error) {
                assert.equal(error instanceof ProcessLocalCandidateValuesError, true);
              }
              return first;
            }
          });
        }
      }
    )), "candidate_provenance_invalid");
    assert.equal(fs.existsSync(input.candidatePath), false);
    assert.equal(fs.readFileSync(input.canonicalPath).equals(input.bytes), true);
  } finally {
    cleanup(input.root);
  }
});

test("invalid provenance fails before candidate mutation and removes DOCKER_CONFIG", async () => {
  const input = fixture();
  const provenanceCalls = [];
  try {
    fs.writeFileSync(input.receiptPath, "not-a-valid-receipt", { mode: 0o600 });
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch(),
      {
        provenanceVerifier: fakeProvenanceVerifier(provenanceCalls, { fail: true })
      }
    )), "candidate_provenance_invalid");
    assert.equal(provenanceCalls.length, 1);
    assert.equal(fs.existsSync(provenanceCalls[0].dockerConfigDirectory), false);
    assert.equal(fs.existsSync(input.candidatePath), false);
    assert.equal(fs.readFileSync(input.canonicalPath).equals(input.bytes), true);
    assert.equal(
      fs.readdirSync(input.root).some(name =>
        name.startsWith(".yenhubs-docker-config-")
      ),
      false
    );
    provenanceCalls[0].configBytes.fill(0);
  } finally {
    cleanup(input.root);
  }
});

test("create is reentrant and verify is restricted to the bootstrap candidate", async () => {
  const input = fixture({ lineEnding: "\r\n" });
  const security = () => fakeSecurityRunner([]);
  const registry = () => fakeRegistryFetch();
  try {
    await manageProcessLocalCandidateValues(invocation(
      input, "create", "bootstrap", security(), registry()
    ));
    const canonicalBefore = fs.readFileSync(input.canonicalPath);
    assert.equal(await manageProcessLocalCandidateValues(invocation(
      input, "verify", "bootstrap", security(), registry()
    )), "aud065_candidate_values_verified");
    const candidateBefore = fs.readFileSync(input.candidatePath);
    assert.equal(await manageProcessLocalCandidateValues(invocation(
      input, "create", "bootstrap", security(), registry()
    )), "aud065_candidate_values_created");
    assert.equal(fs.readFileSync(input.canonicalPath).equals(canonicalBefore), true);
    assert.equal(fs.readFileSync(input.candidatePath).equals(candidateBefore), true);
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input, "verify", "admission", security(), registry()
    )), "candidate_phase_receipt_required");
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input, "advance", "bootstrap", security(), registry()
    )), "command_invalid");
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input, "promote", "bootstrap", security(), registry()
    )), "command_invalid");
    assert.equal(fs.readFileSync(input.candidatePath).equals(candidateBefore), true);
    assert.equal(fs.readFileSync(input.canonicalPath).equals(canonicalBefore), true);
  } finally {
    cleanup(input.root);
  }
});

test("create reconciles a lost publication acknowledgement without changing canonical", async () => {
  const input = fixture();
  try {
    assert.equal(await manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch(),
      {
        publicationHooks: {
          afterLink() {
            throw new Error("simulated_ack_loss");
          }
        }
      }
    )), "aud065_candidate_values_created");
    assert.equal(fs.readFileSync(input.canonicalPath).equals(input.bytes), true);
    assert.equal(
      parseLocalValuesSource(fs.readFileSync(input.candidatePath, "utf8"))
        .get("BOT_RUNNER_ACTIVATION_PHASE"),
      "bootstrap"
    );
    assert.equal(await manageProcessLocalCandidateValues(invocation(
      input, "create", "bootstrap", fakeSecurityRunner([]), fakeRegistryFetch()
    )), "aud065_candidate_values_created");
  } finally {
    cleanup(input.root);
  }
});

test("baseline drift after publication rolls back only the newly published candidate", async () => {
  const input = fixture();
  const foreignBaseline = Buffer.from("FOREIGN_BASELINE: preserved\n", "utf8");
  const stagedBaseline = path.join(input.root, ".foreign-baseline.yaml");
  try {
    writePrivate(stagedBaseline, foreignBaseline);
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch(),
      {
        publicationHooks: {
          afterLink() {
            fs.renameSync(stagedBaseline, input.canonicalPath);
          }
        }
      }
    )), "canonical_source_changed");
    assert.equal(fs.existsSync(input.candidatePath), false);
    assert.equal(fs.readFileSync(input.canonicalPath).equals(foreignBaseline), true);
  } finally {
    cleanup(input.root);
  }
});

test("a new create reconciles an exact rollback quarantine before publishing", async () => {
  const input = fixture();
  const foreignBaseline = Buffer.from("FOREIGN_BASELINE: transient-drift\n", "utf8");
  const stagedBaseline = path.join(input.root, ".foreign-baseline.yaml");
  try {
    writePrivate(stagedBaseline, foreignBaseline);
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch(),
      {
        publicationHooks: {
          afterLink() {
            fs.renameSync(stagedBaseline, input.canonicalPath);
          }
        },
        candidateRollbackHooks: {
          helperCutAfterQuarantineForTest() {
            return true;
          },
          helperDisableRetryForTest() {
            return true;
          }
        }
      }
    )), "candidate_rollback_conflict");
    assert.equal(fs.existsSync(input.candidatePath), false);
    assert.equal(unlinkQuarantineNames(input.root).length, 1);

    fs.writeFileSync(input.canonicalPath, input.bytes, { mode: 0o600 });
    fs.chmodSync(input.canonicalPath, 0o600);
    const [quarantineName] = unlinkQuarantineNames(input.root);
    const quarantinedBytes = fs.readFileSync(path.join(input.root, quarantineName));
    writePrivate(input.candidatePath, quarantinedBytes);
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch()
    )), "candidate_rollback_reconciliation_required");
    assert.equal(fs.readFileSync(input.candidatePath).equals(quarantinedBytes), true);
    assert.equal(
      fs.readFileSync(path.join(input.root, quarantineName)).equals(quarantinedBytes),
      true
    );
    fs.unlinkSync(input.candidatePath);
    assert.equal(await manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch()
    )), "aud065_candidate_values_created");
    assert.equal(fs.existsSync(input.candidatePath), true);
    assert.deepEqual(unlinkQuarantineNames(input.root), []);
    assert.equal(fs.readFileSync(input.canonicalPath).equals(input.bytes), true);
  } finally {
    cleanup(input.root);
  }
});

test("a different attributed rollback quarantine blocks a new publication", async () => {
  const input = fixture();
  const foreignBaseline = Buffer.from("FOREIGN_BASELINE: transient-drift\n", "utf8");
  const stagedBaseline = path.join(input.root, ".foreign-baseline.yaml");
  try {
    writePrivate(stagedBaseline, foreignBaseline);
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch(),
      {
        publicationHooks: {
          afterLink() {
            fs.renameSync(stagedBaseline, input.canonicalPath);
          }
        },
        candidateRollbackHooks: {
          helperCutAfterQuarantineForTest() {
            return true;
          },
          helperDisableRetryForTest() {
            return true;
          }
        }
      }
    )), "candidate_rollback_conflict");
    const [quarantineName] = unlinkQuarantineNames(input.root);
    assert.equal(typeof quarantineName, "string");
    const quarantineBefore = fs.readFileSync(path.join(input.root, quarantineName));
    const differentBaseline = Buffer.from(
      input.bytes.toString("utf8").replace(
        "must-remain-byte-identical",
        "different-but-valid-baseline"
      ),
      "utf8"
    );
    fs.writeFileSync(input.canonicalPath, differentBaseline, { mode: 0o600 });
    fs.chmodSync(input.canonicalPath, 0o600);

    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch()
    )), "candidate_rollback_reconciliation_required");
    assert.equal(fs.existsSync(input.candidatePath), false);
    assert.deepEqual(unlinkQuarantineNames(input.root), [quarantineName]);
    assert.equal(
      fs.readFileSync(path.join(input.root, quarantineName)).equals(quarantineBefore),
      true
    );
    assert.equal(fs.readFileSync(input.canonicalPath).equals(differentBaseline), true);
  } finally {
    cleanup(input.root);
  }
});

test("rollback preserves a candidate substituted after publication and reports conflict", async () => {
  const input = fixture();
  const foreignBaseline = Buffer.from("FOREIGN_BASELINE: preserved\n", "utf8");
  const foreignCandidate = Buffer.from("FOREIGN_CANDIDATE: preserved\n", "utf8");
  const stagedBaseline = path.join(input.root, ".foreign-baseline.yaml");
  const stagedCandidate = path.join(input.root, ".foreign-candidate.yaml");
  try {
    writePrivate(stagedBaseline, foreignBaseline);
    writePrivate(stagedCandidate, foreignCandidate);
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch(),
      {
        publicationHooks: {
          afterLink() {
            fs.renameSync(stagedBaseline, input.canonicalPath);
          }
        },
        candidateRollbackHooks: {
          beforeUnlink() {
            fs.renameSync(stagedCandidate, input.candidatePath);
          }
        }
      }
    )), "candidate_rollback_conflict");
    assert.equal(fs.readFileSync(input.candidatePath).equals(foreignCandidate), true);
    assert.equal(fs.readFileSync(input.canonicalPath).equals(foreignBaseline), true);
  } finally {
    cleanup(input.root);
  }
});

test("wrong rotated credential, denied registry and skipped phase never mutate sources", async () => {
  const wrongCredential = fixture({
    encodedPullConfig: pullConfig(`different-${"D".repeat(32)}`)
  });
  try {
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      wrongCredential,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch()
    )), "rotated_baseline_contract_invalid");
    assert.equal(fs.existsSync(wrongCredential.candidatePath), false);
    assert.equal(fs.readFileSync(wrongCredential.canonicalPath).equals(wrongCredential.bytes), true);
  } finally {
    cleanup(wrongCredential.root);
  }

  const denied = fixture();
  try {
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      denied,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch({ status: 403 })
    )), "candidate_operation_failed");
    assert.equal(fs.existsSync(denied.candidatePath), false);
  } finally {
    cleanup(denied.root);
  }

  const skipped = fixture();
  try {
    await manageProcessLocalCandidateValues(invocation(
      skipped, "create", "bootstrap", fakeSecurityRunner([]), fakeRegistryFetch()
    ));
    const before = fs.readFileSync(skipped.candidatePath);
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      skipped, "advance", "active", fakeSecurityRunner([]), fakeRegistryFetch()
    )), "command_invalid");
    assert.equal(fs.readFileSync(skipped.candidatePath).equals(before), true);
  } finally {
    cleanup(skipped.root);
  }
});

test("candidate tamper, Keychain failure and an unsafe destination fail closed", async () => {
  const tampered = fixture();
  try {
    await manageProcessLocalCandidateValues(invocation(
      tampered, "create", "bootstrap", fakeSecurityRunner([]), fakeRegistryFetch()
    ));
    const bytes = fs.readFileSync(tampered.candidatePath, "utf8")
      .replace("must-remain-byte-identical", "unauthorized-change");
    fs.writeFileSync(tampered.candidatePath, bytes, { mode: 0o600 });
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      tampered, "verify", "bootstrap", fakeSecurityRunner([]), fakeRegistryFetch()
    )), "candidate_unauthorized_change");
  } finally {
    cleanup(tampered.root);
  }

  const keychain = fixture();
  try {
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      keychain,
      "create",
      "bootstrap",
      fakeSecurityRunner([], { fail: true }),
      fakeRegistryFetch()
    )), "keychain_lookup_failed");
    assert.equal(fs.existsSync(keychain.candidatePath), false);
  } finally {
    cleanup(keychain.root);
  }

  const unsafe = fixture();
  try {
    fs.chmodSync(unsafe.root, 0o755);
    await expectCode(() => manageProcessLocalCandidateValues(invocation(
      unsafe, "create", "bootstrap", fakeSecurityRunner([]), fakeRegistryFetch()
    )), "candidate_provenance_invalid");
    assert.equal(fs.existsSync(unsafe.candidatePath), false);
  } finally {
    cleanup(unsafe.root);
  }
});

test("the production wrapper rejects programmatic dependency overrides", async () => {
  const input = fixture();
  try {
    await expectCode(() => manageProcessLocalCandidateValuesProduct(invocation(
      input,
      "create",
      "bootstrap",
      fakeSecurityRunner([]),
      fakeRegistryFetch()
    )), "test_override_forbidden");
    assert.equal(fs.existsSync(input.candidatePath), false);
    assert.equal(fs.readFileSync(input.canonicalPath).equals(input.bytes), true);
  } finally {
    cleanup(input.root);
  }
});

test("CLI exposes only the fixed generic failure", () => {
  const result = spawnSync(process.execPath, [
    CLI,
    "create",
    "--candidate-values-source", "/tmp/candidate.yaml",
    "--receipt", "/tmp/runtime-images-receipt.json",
    "--receipt-bundle", "/tmp/runtime-images-receipt.sigstore.json",
    "--bot-orchestrator-bundle", "/tmp/bot-orchestrator.sigstore.json",
    "--bot-runner-bundle", "/tmp/bot-runner.sigstore.json",
    "--reticulum-bundle", "/tmp/reticulum.sigstore.json",
    "--expected-phase", "bootstrap",
    "--keychain-account", ACCOUNT,
    "--keychain-prefix", PREFIX,
    "--ghcr-username", `invalid-${NEW_TOKEN}`
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "AUD-065 candidate values operation failed closed\n");
  assert.equal(result.stderr.includes(NEW_TOKEN), false);
});

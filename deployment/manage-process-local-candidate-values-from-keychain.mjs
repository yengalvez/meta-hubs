#!/usr/bin/env node

// Build or verify a separate bootstrap candidate after AUD-065 has completed.
// Phase advancement and final promotion are deliberately unavailable here:
// those mutations require authenticated receipts from the guarded Cloud apply
// path and the final live/browser acceptance chain. Provider material is read
// from macOS Keychain and never accepted through argv or the environment.

import { timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLocalValuesSource } from "./parse-local-values.mjs";
import {
  publishPrivateArtifact
} from "./private-artifact-publication.mjs";
import {
  projectProcessLocalValuesMap,
  readPrivateProcessLocalValuesSource
} from "./project-process-local-values.mjs";
import {
  validateProcessLocalValuesSnapshot
} from "./process-local-rotation.mjs";
import {
  ProcessLocalSourceTransitionError,
  reconcilePrivateProcessLocalValuesSourceExactUnlink,
  unlinkPrivateProcessLocalValuesSourceExact
} from "./process-local-source-transition.mjs";
import {
  verifyRuntimeImageBuildProvenance
} from "./verify-runtime-image-build-provenance.mjs";
import {
  verifyBotPullConfig,
  verifyProcessLocalValuesGhcrAccess
} from "./verify-bot-image-pull-config.mjs";
import {
  withPrivateDockerConfig
} from "./with-private-docker-config.mjs";

const CANONICAL_VALUES = fileURLToPath(
  new URL("./input-values.local.yaml", import.meta.url)
);
const SECURITY = "/usr/bin/security";
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const GHCR_KEYCHAIN_NAME = "GHCR_TOKEN";
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u;
const GHCR_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const BOOTSTRAP_PHASE = "bootstrap";
const IMAGE_CONTRACTS = Object.freeze({
  OVERRIDE_RETICULUM_IMAGE: /^ghcr\.io\/yengalvez\/reticulum@sha256:[a-f0-9]{64}$/u,
  OVERRIDE_BOT_ORCHESTRATOR_IMAGE:
    /^ghcr\.io\/yengalvez\/bot-orchestrator@sha256:[a-f0-9]{64}$/u,
  OVERRIDE_BOT_RUNNER_IMAGE:
    /^ghcr\.io\/yengalvez\/bot-runner@sha256:[a-f0-9]{64}$/u
});
const AUTHORIZED_KEYS = Object.freeze([
  ...Object.keys(IMAGE_CONTRACTS),
  "BOT_IMAGE_PULL_CONFIG_JSON_BASE64",
  "BOT_RUNNER_ACTIVATION_PHASE"
]);
const SUCCESS_TOKENS = Object.freeze({
  create: "aud065_candidate_values_created",
  verify: "aud065_candidate_values_verified"
});
const GENERIC_ERROR = "AUD-065 candidate values operation failed closed\n";

export class ProcessLocalCandidateValuesError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalCandidateValuesError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalCandidateValuesError(code);
}

function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function safeBufferEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) &&
    left.length === right.length && timingSafeEqual(left, right);
}

function currentUidMatches(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function samePublicationNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.isFile() === right.isFile() &&
    left.isSymbolicLink() === right.isSymbolicLink();
}

function linkedPrivatePublication(stat, expectedBytes) {
  return stat?.isFile() && !stat.isSymbolicLink() && currentUidMatches(stat) &&
    Number(stat.mode & 0o7777n) === 0o600 && stat.nlink === 2n &&
    stat.size === BigInt(expectedBytes.length);
}

function captureCandidatePublicationIdentity({
  context,
  candidatePath,
  expectedBytes
}) {
  let descriptor;
  let readBack;
  try {
    if (!context || typeof context !== "object" ||
        path.resolve(context.outputPath) !== candidatePath ||
        typeof context.pendingPath !== "string" ||
        path.dirname(path.resolve(context.pendingPath)) !== path.dirname(candidatePath)) {
      fail("candidate_publication_identity_invalid");
    }
    const outputStat = fs.lstatSync(context.outputPath, { bigint: true });
    const pendingStat = fs.lstatSync(context.pendingPath, { bigint: true });
    if (!linkedPrivatePublication(outputStat, expectedBytes) ||
        !linkedPrivatePublication(pendingStat, expectedBytes) ||
        !samePublicationNode(outputStat, pendingStat)) {
      fail("candidate_publication_identity_invalid");
    }
    descriptor = fs.openSync(
      context.outputPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    readBack = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    if (!samePublicationNode(outputStat, opened) ||
        !samePublicationNode(opened, afterRead) ||
        !safeBufferEqual(readBack, expectedBytes)) {
      fail("candidate_publication_identity_invalid");
    }
    return Object.freeze({ dev: outputStat.dev, ino: outputStat.ino });
  } catch (error) {
    if (error instanceof ProcessLocalCandidateValuesError) throw error;
    fail("candidate_publication_identity_invalid");
  } finally {
    if (readBack) readBack.fill(0);
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve validation result. */ }
    }
  }
}

function candidatePublicationHooks({
  candidatePath,
  expectedBytes,
  hooks,
  recordIdentity
}) {
  if (hooks !== undefined &&
      (!hooks || typeof hooks !== "object" || Array.isArray(hooks))) {
    fail("candidate_publication_hook_invalid");
  }
  const suppliedAfterLink = hooks?.afterLink;
  return {
    ...(hooks || {}),
    afterLink(context) {
      recordIdentity(captureCandidatePublicationIdentity({
        context,
        candidatePath,
        expectedBytes
      }));
      if (suppliedAfterLink !== undefined) {
        if (typeof suppliedAfterLink !== "function") {
          fail("candidate_publication_hook_invalid");
        }
        suppliedAfterLink(context);
      }
    }
  };
}

function wipeMap(values) {
  if (!(values instanceof Map)) return;
  for (const key of values.keys()) values.set(key, "");
  values.clear();
}

function wipeRecord(values) {
  if (!values || typeof values !== "object") return;
  for (const key of Object.keys(values)) values[key] = "";
}

function checkedAbsolutePath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      /[\u0000\r\n]/u.test(value)) {
    fail(code);
  }
  return path.resolve(value);
}

function checkedLabel(value, code) {
  if (typeof value !== "string" || !LABEL.test(value)) fail(code);
  return value;
}

function checkedUsername(value) {
  if (typeof value !== "string" || !GHCR_USERNAME.test(value)) {
    fail("ghcr_username_invalid");
  }
  return value;
}

function checkedPhase(value) {
  if (value !== BOOTSTRAP_PHASE) fail("candidate_phase_receipt_required");
  return value;
}

function checkedImages({ reticulumImage, botOrchestratorImage, botRunnerImage }) {
  const values = {
    OVERRIDE_RETICULUM_IMAGE: reticulumImage,
    OVERRIDE_BOT_ORCHESTRATOR_IMAGE: botOrchestratorImage,
    OVERRIDE_BOT_RUNNER_IMAGE: botRunnerImage
  };
  for (const [key, pattern] of Object.entries(IMAGE_CONTRACTS)) {
    if (typeof values[key] !== "string" || !pattern.test(values[key])) {
      fail("candidate_image_invalid");
    }
  }
  return values;
}

function imagesFromProvenance(provenance) {
  const images = provenance?.images;
  if (!images || typeof images !== "object" || Array.isArray(images) ||
      JSON.stringify(Object.keys(images).sort()) !==
        JSON.stringify(["botOrchestrator", "botRunner", "reticulum"])) {
    fail("candidate_provenance_invalid");
  }
  return checkedImages({
    reticulumImage: images.reticulum,
    botOrchestratorImage: images.botOrchestrator,
    botRunnerImage: images.botRunner
  });
}

function minimalEnvironment() {
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  if (typeof process.env.HOME === "string" && process.env.HOME) {
    environment.HOME = process.env.HOME;
  }
  return environment;
}

export function runMacOsSecurityForCandidate(invocation) {
  return spawnSync(invocation.executable, invocation.args, {
    env: invocation.env,
    encoding: null,
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: MAX_SECRET_BYTES + 2,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function trimSecretTerminator(stdout) {
  let end = stdout.length;
  if (end >= 2 && stdout[end - 2] === 0x0d && stdout[end - 1] === 0x0a) {
    end -= 2;
  } else if (end >= 1 && stdout[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end < 1 || end > MAX_SECRET_BYTES) fail("keychain_secret_invalid");
  const secret = Buffer.from(stdout.subarray(0, end));
  if ([...secret].some(byte => byte < 0x21 || byte > 0x7e)) {
    secret.fill(0);
    fail("keychain_secret_invalid");
  }
  return secret;
}

function readGhcrToken({ account, prefix, securityRunner }) {
  const service = `${prefix}-${GHCR_KEYCHAIN_NAME}`;
  if (!LABEL.test(service) || service.length > 255) fail("keychain_service_invalid");
  let result;
  let stdout;
  let stderr;
  try {
    result = securityRunner({
      executable: SECURITY,
      args: ["find-generic-password", "-w", "-s", service, "-a", account],
      env: minimalEnvironment()
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stdout.length < 1 || stdout.length > MAX_SECRET_BYTES + 2 ||
        stderr.length !== 0) {
      fail("keychain_lookup_failed");
    }
    return trimSecretTerminator(stdout);
  } catch (error) {
    if (error instanceof ProcessLocalCandidateValuesError) throw error;
    fail("keychain_lookup_failed");
  } finally {
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

function buildPullConfig(username, token) {
  let usernameBytes;
  let credentialBytes;
  let configBytes;
  try {
    usernameBytes = Buffer.from(username, "utf8");
    credentialBytes = Buffer.concat([usernameBytes, Buffer.from(":"), token]);
    configBytes = Buffer.from(JSON.stringify({
      auths: {
        "ghcr.io": { auth: credentialBytes.toString("base64") }
      }
    }), "utf8");
    return configBytes.toString("base64");
  } finally {
    if (usernameBytes) usernameBytes.fill(0);
    if (credentialBytes) credentialBytes.fill(0);
    if (configBytes) configBytes.fill(0);
  }
}

function parseValues(bytes, code) {
  try {
    return parseLocalValuesSource(bytes.toString("utf8"));
  } catch {
    fail(code);
  }
}

function sourceText(bytes, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) {
    fail(code);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || !text.endsWith("\n")) fail(code);
  const endings = text.match(/\r?\n/gu) || [];
  if (endings.length < 1 || endings.some(ending => ending !== endings[0])) fail(code);
  return { text, ending: endings[0] };
}

function replaceScalarLines(bytes, replacements, code) {
  let { text } = sourceText(bytes, code);
  for (const [key, value] of replacements) {
    const pattern = new RegExp(`^${key}:[^\\r\\n]*(?:\\r?\\n)`, "gmu");
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) fail(code);
    const ending = matches[0][0].endsWith("\r\n") ? "\r\n" : "\n";
    const replacement = `${key}: ${JSON.stringify(value)}${ending}`;
    text = `${text.slice(0, matches[0].index)}${replacement}${
      text.slice(matches[0].index + matches[0][0].length)
    }`;
  }
  const result = Buffer.from(text, "utf8");
  if (result.length > MAX_SOURCE_BYTES) {
    result.fill(0);
    fail(code);
  }
  return result;
}

function normalizedAuthorizedSource(bytes, code) {
  const replacements = new Map(AUTHORIZED_KEYS.map(key => [key, "<authorized>"]));
  return replaceScalarLines(bytes, replacements, code);
}

function sameKeyset(left, right) {
  const leftKeys = [...left.keys()].sort();
  const rightKeys = [...right.keys()].sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index]);
}

function validateCandidate({
  baselineBytes,
  candidateBytes,
  expectedValues
}) {
  let baselineValues;
  let candidateValues;
  let baselineNormalized;
  let candidateNormalized;
  let snapshot;
  try {
    baselineValues = parseValues(baselineBytes, "baseline_source_invalid");
    candidateValues = parseValues(candidateBytes, "candidate_source_invalid");
    if (!sameKeyset(baselineValues, candidateValues)) fail("candidate_keyset_changed");
    for (const [key, value] of expectedValues) {
      if (!safeStringEqual(candidateValues.get(key), value)) {
        fail("candidate_value_mismatch");
      }
    }
    for (const key of baselineValues.keys()) {
      if (!AUTHORIZED_KEYS.includes(key) &&
          !safeStringEqual(baselineValues.get(key), candidateValues.get(key))) {
        fail("candidate_unauthorized_change");
      }
    }
    baselineNormalized = normalizedAuthorizedSource(
      baselineBytes,
      "baseline_source_layout_invalid"
    );
    candidateNormalized = normalizedAuthorizedSource(
      candidateBytes,
      "candidate_source_layout_invalid"
    );
    if (!safeBufferEqual(baselineNormalized, candidateNormalized)) {
      fail("candidate_source_structure_changed");
    }
    snapshot = projectProcessLocalValuesMap(candidateValues);
    validateProcessLocalValuesSnapshot(snapshot, { codePrefix: "candidate_source" });
    verifyBotPullConfig({
      encoded: snapshot.BOT_IMAGE_PULL_CONFIG_JSON_BASE64,
      botImage: snapshot.OVERRIDE_BOT_ORCHESTRATOR_IMAGE,
      runnerImage: snapshot.OVERRIDE_BOT_RUNNER_IMAGE
    });
    return snapshot;
  } catch (error) {
    wipeRecord(snapshot);
    if (error instanceof ProcessLocalCandidateValuesError) throw error;
    fail("candidate_contract_invalid");
  } finally {
    wipeMap(baselineValues);
    wipeMap(candidateValues);
    if (baselineNormalized) baselineNormalized.fill(0);
    if (candidateNormalized) candidateNormalized.fill(0);
  }
}

function expectedCandidateValues(images, encodedPullConfig, phase) {
  return new Map([
    ...Object.entries(images),
    ["BOT_IMAGE_PULL_CONFIG_JSON_BASE64", encodedPullConfig],
    ["BOT_RUNNER_ACTIVATION_PHASE", phase]
  ]);
}

function rollbackExactPublishedCandidate({
  candidatePath,
  desiredBytes,
  publishedIdentity,
  hooks
}) {
  if (!publishedIdentity) fail("candidate_rollback_conflict");
  try {
    unlinkPrivateProcessLocalValuesSourceExact({
      canonicalValuesPath: candidatePath,
      expectedBytes: desiredBytes,
      expectedIdentity: publishedIdentity,
      hooks
    });
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError && [
      "canonical_source_unlink_conflict",
      "canonical_source_path_invalid"
    ].includes(error.code)) {
      fail("candidate_rollback_conflict");
    }
    fail("candidate_rollback_failed");
  }
}

async function manageProcessLocalCandidateValuesCore({
  command,
  candidateValuesSource,
  receiptPath,
  receiptBundlePath,
  botOrchestratorBundlePath,
  botRunnerBundlePath,
  reticulumBundlePath,
  expectedPhase,
  keychainAccount,
  keychainPrefix,
  ghcrUsername,
  securityRunner = runMacOsSecurityForCandidate,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs,
  canonicalValuesSource = CANONICAL_VALUES,
  provenanceVerifier = verifyRuntimeImageBuildProvenance,
  dockerConfigMaterializer = withPrivateDockerConfig,
  publicationHooks,
  candidateRollbackHooks
}) {
  if (!Object.hasOwn(SUCCESS_TOKENS, command)) fail("command_invalid");
  const candidatePath = checkedAbsolutePath(
    candidateValuesSource,
    "candidate_source_path_invalid"
  );
  const canonicalPath = checkedAbsolutePath(
    canonicalValuesSource,
    "canonical_source_path_invalid"
  );
  if (candidatePath === canonicalPath) fail("source_paths_not_distinct");
  const provenanceInputs = {
    receiptPath: checkedAbsolutePath(receiptPath, "receipt_path_invalid"),
    receiptBundlePath: checkedAbsolutePath(
      receiptBundlePath,
      "receipt_bundle_path_invalid"
    ),
    botOrchestratorBundlePath: checkedAbsolutePath(
      botOrchestratorBundlePath,
      "bot_orchestrator_bundle_path_invalid"
    ),
    botRunnerBundlePath: checkedAbsolutePath(
      botRunnerBundlePath,
      "bot_runner_bundle_path_invalid"
    ),
    reticulumBundlePath: checkedAbsolutePath(
      reticulumBundlePath,
      "reticulum_bundle_path_invalid"
    )
  };
  const phase = checkedPhase(expectedPhase);
  const account = checkedLabel(keychainAccount, "keychain_account_invalid");
  const prefix = checkedLabel(keychainPrefix, "keychain_prefix_invalid");
  const username = checkedUsername(ghcrUsername);
  if (typeof securityRunner !== "function" || typeof fetchImpl !== "function" ||
      typeof provenanceVerifier !== "function" ||
      typeof dockerConfigMaterializer !== "function") {
    fail("runner_invalid");
  }

  let baselineBytes;
  let candidateBytes;
  let desiredBytes;
  let baselineRecheck;
  let candidateRecheck;
  let publishedBytes;
  let baselineAfterMutation;
  let token;
  let snapshot;
  let images;
  let publishedIdentity;
  try {
    baselineBytes = readPrivateProcessLocalValuesSource(canonicalPath);
    let candidateExists = false;
    try {
      fs.lstatSync(candidatePath);
      candidateExists = true;
    } catch (error) {
      if (error?.code !== "ENOENT") fail("candidate_source_invalid");
    }
    if (command === "verify" || candidateExists) {
      candidateBytes = readPrivateProcessLocalValuesSource(candidatePath);
    }
    token = readGhcrToken({ account, prefix, securityRunner });
    const encodedPullConfig = buildPullConfig(username, token);
    let verifierCallbackCount = 0;
    let verifierResultPromise;
    try {
      await dockerConfigMaterializer({
        encodedDockerConfig: encodedPullConfig,
        privateParentDirectory: path.dirname(candidatePath),
        callback(dockerConfigDirectory) {
          verifierCallbackCount += 1;
          if (verifierCallbackCount !== 1) fail("candidate_provenance_invalid");
          verifierResultPromise = Promise.resolve().then(() =>
            provenanceVerifier({
              ...provenanceInputs,
              dockerConfigDirectory
            })
          );
          return verifierResultPromise;
        }
      });
      if (verifierCallbackCount !== 1 || !verifierResultPromise) {
        fail("candidate_provenance_invalid");
      }
      const verifiedProvenance = await verifierResultPromise;
      if (verifierCallbackCount !== 1) fail("candidate_provenance_invalid");
      images = imagesFromProvenance(verifiedProvenance);
    } catch (error) {
      if (error instanceof ProcessLocalCandidateValuesError) throw error;
      fail("candidate_provenance_invalid");
    }
    const baselineValues = parseValues(baselineBytes, "baseline_source_invalid");
    try {
      if (!safeStringEqual(
        baselineValues.get("OVERRIDE_BOT_RUNNER_IMAGE"),
        images.OVERRIDE_BOT_RUNNER_IMAGE
      ) || !safeStringEqual(
        baselineValues.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"),
        encodedPullConfig
      )) {
        fail("rotated_baseline_contract_invalid");
      }
    } finally {
      wipeMap(baselineValues);
    }

    if (command === "create" && !candidateExists) {
      const replacements = expectedCandidateValues(images, encodedPullConfig, "bootstrap");
      desiredBytes = replaceScalarLines(
        baselineBytes,
        replacements,
        "candidate_source_layout_invalid"
      );
      snapshot = validateCandidate({
        baselineBytes,
        candidateBytes: desiredBytes,
        expectedValues: replacements
      });
    } else {
      const currentExpected = expectedCandidateValues(images, encodedPullConfig, phase);
      snapshot = validateCandidate({
        baselineBytes,
        candidateBytes,
        expectedValues: currentExpected
      });
    }

    await verifyProcessLocalValuesGhcrAccess({
      snapshot,
      fetchImpl,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs })
    });
    baselineRecheck = readPrivateProcessLocalValuesSource(canonicalPath);
    if (!safeBufferEqual(baselineBytes, baselineRecheck)) {
      fail("canonical_source_changed");
    }
    if (candidateBytes) {
      candidateRecheck = readPrivateProcessLocalValuesSource(candidatePath);
      if (!safeBufferEqual(candidateBytes, candidateRecheck)) {
        fail("candidate_source_changed");
      }
    }

    const reconciliationBytes = desiredBytes ?? candidateBytes;
    if (!Buffer.isBuffer(reconciliationBytes)) {
      fail("candidate_rollback_reconciliation_required");
    }
    try {
      reconcilePrivateProcessLocalValuesSourceExactUnlink({
        canonicalValuesPath: candidatePath,
        expectedBytes: reconciliationBytes
      });
    } catch {
      fail("candidate_rollback_reconciliation_required");
    }

    if (command === "create" && !candidateExists) {
      let publicationResult;
      try {
        publicationResult = publishPrivateArtifact({
          outputPath: candidatePath,
          bytes: desiredBytes,
          maximumBytes: MAX_SOURCE_BYTES,
          hooks: candidatePublicationHooks({
            candidatePath,
            expectedBytes: desiredBytes,
            hooks: publicationHooks,
            recordIdentity(identity) {
              if (publishedIdentity) fail("candidate_publication_identity_invalid");
              publishedIdentity = identity;
            }
          })
        });
      } catch {
        // Lost acknowledgements and concurrent identical publication are safe:
        // reconcile only the exact expected private bytes, never a foreign file.
        publishedBytes = readPrivateProcessLocalValuesSource(candidatePath);
        if (!safeBufferEqual(publishedBytes, desiredBytes)) {
          fail("candidate_publication_mismatch");
        }
      }
      if ((publicationResult === true && !publishedIdentity) ||
          (publicationResult === false && publishedIdentity)) {
        fail("candidate_publication_identity_invalid");
      }
      if (publishedBytes) {
        publishedBytes.fill(0);
        publishedBytes = undefined;
      }
      publishedBytes = readPrivateProcessLocalValuesSource(candidatePath);
      if (!safeBufferEqual(publishedBytes, desiredBytes)) {
        fail("candidate_publication_mismatch");
      }
      if (publishedIdentity) {
        let currentIdentity;
        try {
          currentIdentity = fs.lstatSync(candidatePath, { bigint: true });
        } catch {
          fail("candidate_publication_mismatch");
        }
        if (currentIdentity.dev !== publishedIdentity.dev ||
            currentIdentity.ino !== publishedIdentity.ino) {
          fail("candidate_publication_mismatch");
        }
      }
      let canonicalChanged = false;
      try {
        baselineAfterMutation = readPrivateProcessLocalValuesSource(canonicalPath);
        canonicalChanged = !safeBufferEqual(baselineAfterMutation, baselineBytes);
      } catch {
        canonicalChanged = true;
      }
      if (canonicalChanged) {
        rollbackExactPublishedCandidate({
          candidatePath,
          desiredBytes,
          publishedIdentity,
          hooks: candidateRollbackHooks
        });
        fail("canonical_source_changed");
      }
    }
    return SUCCESS_TOKENS[command];
  } catch (error) {
    if (error instanceof ProcessLocalCandidateValuesError) throw error;
    fail("candidate_operation_failed");
  } finally {
    for (const bytes of [
      baselineBytes,
      candidateBytes,
      desiredBytes,
      baselineRecheck,
      candidateRecheck,
      publishedBytes,
      baselineAfterMutation,
      token
    ]) {
      if (bytes) bytes.fill(0);
    }
    wipeRecord(snapshot);
  }
}

const PRODUCT_OPTION_KEYS = Object.freeze([
  "command",
  "candidateValuesSource",
  "receiptPath",
  "receiptBundlePath",
  "botOrchestratorBundlePath",
  "botRunnerBundlePath",
  "reticulumBundlePath",
  "expectedPhase",
  "keychainAccount",
  "keychainPrefix",
  "ghcrUsername"
]);

// This fixed-dependency wrapper is the production boundary used by the CLI.
// Dependency, path and race hooks exist only on the explicitly test-only API.
export async function manageProcessLocalCandidateValues(options) {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key =>
        typeof key !== "string" || !PRODUCT_OPTION_KEYS.includes(key)
      )) {
    fail("test_override_forbidden");
  }
  return manageProcessLocalCandidateValuesCore(Object.fromEntries(
    PRODUCT_OPTION_KEYS.map(key => [key, options[key]])
  ));
}

export function manageProcessLocalCandidateValuesForTest(options) {
  return manageProcessLocalCandidateValuesCore(options);
}

function parseArguments(argv) {
  const command = argv[0];
  const allowed = new Set([
    "--candidate-values-source",
    "--receipt",
    "--receipt-bundle",
    "--bot-orchestrator-bundle",
    "--bot-runner-bundle",
    "--reticulum-bundle",
    "--expected-phase",
    "--keychain-account",
    "--keychain-prefix",
    "--ghcr-username"
  ]);
  if (!Object.hasOwn(SUCCESS_TOKENS, command) || argv.length !== 1 + allowed.size * 2) {
    fail("arguments_invalid");
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || values.has(flag) || typeof value !== "string" || !value) {
      fail("arguments_invalid");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) fail("arguments_invalid");
  return { command, values };
}

async function main() {
  try {
    const { command, values } = parseArguments(process.argv.slice(2));
    const result = await manageProcessLocalCandidateValues({
      command,
      candidateValuesSource: values.get("--candidate-values-source"),
      receiptPath: values.get("--receipt"),
      receiptBundlePath: values.get("--receipt-bundle"),
      botOrchestratorBundlePath: values.get("--bot-orchestrator-bundle"),
      botRunnerBundlePath: values.get("--bot-runner-bundle"),
      reticulumBundlePath: values.get("--reticulum-bundle"),
      expectedPhase: values.get("--expected-phase"),
      keychainAccount: values.get("--keychain-account"),
      keychainPrefix: values.get("--keychain-prefix"),
      ghcrUsername: values.get("--ghcr-username")
    });
    process.stdout.write(`${result}\n`);
  } catch {
    process.stderr.write(GENERIC_ERROR);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

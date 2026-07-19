#!/usr/bin/env node

// Verify the non-secret receipt for the coordinated Reticulum, bot parent and
// bot runner build. The receipt is accepted only when its own Sigstore bundle
// and all three OCI provenance attestations resolve to the same GitHub-hosted
// workflow invocation, accepted Cloud commit and immutable image set.

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_GH_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;
const PYTHON = "python3";
const DIRFD_HELPER = fileURLToPath(new URL("./private-dirfd-ops.py", import.meta.url));
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;

export const RUNTIME_IMAGE_BUILD_REPOSITORY = "yengalvez/hubs-cloud";
export const RUNTIME_IMAGE_BUILD_REPOSITORY_ID = "1153407749";
export const RUNTIME_IMAGE_BUILD_SOURCE_REF = "refs/heads/master";
export const RUNTIME_IMAGE_BUILD_WORKFLOW_PATH =
  ".github/workflows/runtime-images-build-push.yml";
export const RUNTIME_IMAGE_BUILD_SIGNER_WORKFLOW =
  `${RUNTIME_IMAGE_BUILD_REPOSITORY}/${RUNTIME_IMAGE_BUILD_WORKFLOW_PATH}`;

export const RUNTIME_IMAGE_BUILD_REPOSITORIES = Object.freeze({
  botOrchestrator: "ghcr.io/yengalvez/bot-orchestrator",
  botRunner: "ghcr.io/yengalvez/bot-runner",
  reticulum: "ghcr.io/yengalvez/reticulum"
});

const RECEIPT_KEYS = Object.freeze([
  "images",
  "repository",
  "repositoryId",
  "runAttempt",
  "runId",
  "schemaVersion",
  "sourceCommit",
  "sourceRef",
  "workflowPath",
  "workflowSha"
]);
const IMAGE_KEYS = Object.freeze(Object.keys(RUNTIME_IMAGE_BUILD_REPOSITORIES).sort());
const GH_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh"
]);
const GIT_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
  "/usr/bin/git"
]);
const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT = "https://in-toto.io/Statement/v1";
const GITHUB_WORKFLOW_BUILD_TYPE = "https://actions.github.io/buildtypes/workflow/v1";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SUCCESS_TOKEN = "runtime_image_build_provenance_verified_v1";
const GENERIC_ERROR = "Runtime image build provenance verification failed closed\n";
const SNAPSHOT_DIRECTORY_MODE = 0o700;
const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_DIRECTORY_PREFIX = ".yenhubs-runtime-provenance-";
const SNAPSHOT_ATTEMPTS = 16;
const ARTIFACT_PATH_KEYS = Object.freeze([
  "botOrchestratorBundlePath",
  "botRunnerBundlePath",
  "receiptBundlePath",
  "receiptPath",
  "reticulumBundlePath"
]);
const ARTIFACT_IDENTITY_KEYS = Object.freeze([
  "ctimeNs", "dev", "gid", "ino", "mode", "mtimeNs", "nlink", "size", "uid"
]);
const DIRECTORY_IDENTITY_KEYS = Object.freeze(["dev", "gid", "ino", "mode", "uid"]);
const SNAPSHOT_HOOK_NAMES = new Set(["afterSnapshotReady", "afterCallback"]);

export class RuntimeImageBuildProvenanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "RuntimeImageBuildProvenanceError";
    this.code = code;
  }
}

function fail(code) {
  throw new RuntimeImageBuildProvenanceError(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return object(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
  );
}

export function canonicalRuntimeImageBuildReceiptJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedAbsolutePath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      /[\u0000\r\n]/u.test(value)) {
    fail(code);
  }
  return path.resolve(value);
}

function checkedExpectedCommit(value) {
  if (typeof value !== "string" || !SOURCE_COMMIT.test(value)) {
    fail("expected_source_commit_invalid");
  }
  return value;
}

function readExactDescriptor(descriptor, size, code) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) fail(code);
    offset += count;
  }
  const extra = Buffer.alloc(1);
  try {
    if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) fail(code);
  } finally {
    extra.fill(0);
  }
  return bytes;
}

function sameFileStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.isFile() === right.isFile();
}

function statIdentity(stat, keys) {
  return Object.freeze(Object.fromEntries(keys.map(key => [
    key,
    stat[key].toString(10)
  ])));
}

function artifactIdentity(stat) {
  return statIdentity(stat, ARTIFACT_IDENTITY_KEYS);
}

function directoryIdentity(stat) {
  return statIdentity(stat, DIRECTORY_IDENTITY_KEYS);
}

function exactIdentity(value, keys) {
  return object(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys) &&
    keys.every(key =>
      typeof value[key] === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value[key])
    );
}

function checkedArtifactBindings(value) {
  if (value === undefined) return undefined;
  if (!exactKeys(value, ARTIFACT_PATH_KEYS) ||
      ARTIFACT_PATH_KEYS.some(key =>
        !exactIdentity(value[key], ARTIFACT_IDENTITY_KEYS)
      )) {
    fail("artifact_binding_invalid");
  }
  return value;
}

function matchesIdentity(stat, expected, keys) {
  if (expected === undefined) return true;
  const actual = statIdentity(stat, keys);
  return keys.every(key => actual[key] === expected[key]);
}

function openStableArtifact(artifactPath, maximumBytes, pathCode, contentCode) {
  const resolved = checkedAbsolutePath(artifactPath, pathCode);
  let descriptor;
  try {
    const realBefore = fs.realpathSync(resolved);
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    const pathnameStat = fs.lstatSync(resolved, { bigint: true });
    const realAfter = fs.realpathSync(resolved);
    if (realBefore !== resolved || realAfter !== resolved ||
        !descriptorStat.isFile() || pathnameStat.isSymbolicLink() ||
        !sameFileStat(descriptorStat, pathnameStat) ||
        descriptorStat.size < 2n || descriptorStat.size > BigInt(maximumBytes)) {
      fail(pathCode);
    }
    const bytes = readExactDescriptor(descriptor, Number(descriptorStat.size), contentCode);
    return { resolved, descriptor, stat: descriptorStat, bytes };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the primary error. */ }
    }
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail(pathCode);
  }
}

function verifyStableArtifact(artifact, code) {
  let reread;
  try {
    const real = fs.realpathSync(artifact.resolved);
    const descriptorStat = fs.fstatSync(artifact.descriptor, { bigint: true });
    const pathnameStat = fs.lstatSync(artifact.resolved, { bigint: true });
    if (real !== artifact.resolved || pathnameStat.isSymbolicLink() ||
        !sameFileStat(artifact.stat, descriptorStat) ||
        !sameFileStat(artifact.stat, pathnameStat)) {
      fail(code);
    }
    reread = readExactDescriptor(artifact.descriptor, artifact.bytes.length, code);
    if (!reread.equals(artifact.bytes)) fail(code);
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail(code);
  } finally {
    if (reread) reread.fill(0);
  }
}

function closeArtifact(artifact) {
  if (!artifact) return;
  if (artifact.bytes) artifact.bytes.fill(0);
  try { fs.closeSync(artifact.descriptor); } catch { /* Nothing reusable is emitted. */ }
}

function requireDistinctArtifacts(artifacts) {
  for (let left = 0; left < artifacts.length; left += 1) {
    for (let right = left + 1; right < artifacts.length; right += 1) {
      if (artifacts[left].stat.dev === artifacts[right].stat.dev &&
          artifacts[left].stat.ino === artifacts[right].stat.ino) {
        fail("artifact_alias_invalid");
      }
    }
  }
}

function parseCanonicalReceipt(bytes, expectedSourceCommit) {
  let text;
  let receipt;
  try {
    text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail("receipt_invalid");
    receipt = JSON.parse(text);
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail("receipt_invalid");
  }
  if (!object(receipt) || text !== `${canonicalRuntimeImageBuildReceiptJson(receipt)}\n`) {
    fail("receipt_noncanonical");
  }
  if (!exactKeys(receipt, RECEIPT_KEYS) || receipt.schemaVersion !== 1 ||
      receipt.repository !== RUNTIME_IMAGE_BUILD_REPOSITORY ||
      receipt.repositoryId !== RUNTIME_IMAGE_BUILD_REPOSITORY_ID ||
      receipt.sourceCommit !== expectedSourceCommit ||
      receipt.sourceRef !== RUNTIME_IMAGE_BUILD_SOURCE_REF ||
      receipt.workflowPath !== RUNTIME_IMAGE_BUILD_WORKFLOW_PATH ||
      receipt.workflowSha !== expectedSourceCommit ||
      typeof receipt.runId !== "string" || !POSITIVE_DECIMAL.test(receipt.runId) ||
      typeof receipt.runAttempt !== "string" ||
      !POSITIVE_DECIMAL.test(receipt.runAttempt) ||
      !exactKeys(receipt.images, IMAGE_KEYS)) {
    fail("receipt_contract_invalid");
  }
  for (const key of IMAGE_KEYS) {
    const repository = RUNTIME_IMAGE_BUILD_REPOSITORIES[key];
    const value = receipt.images[key];
    if (typeof value !== "string" ||
        !new RegExp(`^${repository.replaceAll(".", "\\.")}@sha256:[a-f0-9]{64}$`, "u")
          .test(value)) {
      fail("receipt_image_contract_invalid");
    }
  }
  return receipt;
}

function parseBundle(bytes, code) {
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes) || !object(JSON.parse(text))) {
      fail(code);
    }
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail(code);
  }
}

function runtimeImageBundleInputs({
  botOrchestratorBundlePath,
  botRunnerBundlePath,
  reticulumBundlePath
}) {
  return {
    botOrchestrator: {
      path: botOrchestratorBundlePath,
      pathCode: "bot_orchestrator_bundle_path_invalid",
      contentCode: "bot_orchestrator_bundle_invalid",
      changedCode: "bot_orchestrator_bundle_changed"
    },
    botRunner: {
      path: botRunnerBundlePath,
      pathCode: "bot_runner_bundle_path_invalid",
      contentCode: "bot_runner_bundle_invalid",
      changedCode: "bot_runner_bundle_changed"
    },
    reticulum: {
      path: reticulumBundlePath,
      pathCode: "reticulum_bundle_path_invalid",
      contentCode: "reticulum_bundle_invalid",
      changedCode: "reticulum_bundle_changed"
    }
  };
}

// Keep the physical-file trust boundary in one implementation. The standalone
// inspector uses this without invoking gh; the full verifier keeps the same
// descriptors open while gh runs and revalidates every file before returning.
function withStableRuntimeImageBuildArtifacts({
  receiptPath,
  receiptBundlePath,
  botOrchestratorBundlePath,
  botRunnerBundlePath,
  reticulumBundlePath,
  artifactBindings,
  expectedSourceCommit
}, callback) {
  const expectedBindings = checkedArtifactBindings(artifactBindings);
  const imageBundleInputs = runtimeImageBundleInputs({
    botOrchestratorBundlePath,
    botRunnerBundlePath,
    reticulumBundlePath
  });
  let receiptArtifact;
  let receiptBundleArtifact;
  const imageBundleArtifacts = {};
  try {
    receiptArtifact = openStableArtifact(
      receiptPath,
      MAX_RECEIPT_BYTES,
      "receipt_path_invalid",
      "receipt_invalid"
    );
    receiptBundleArtifact = openStableArtifact(
      receiptBundlePath,
      MAX_BUNDLE_BYTES,
      "receipt_bundle_path_invalid",
      "receipt_bundle_invalid"
    );
    for (const key of IMAGE_KEYS) {
      const input = imageBundleInputs[key];
      imageBundleArtifacts[key] = openStableArtifact(
        input.path,
        MAX_BUNDLE_BYTES,
        input.pathCode,
        input.contentCode
      );
    }
    requireDistinctArtifacts([
      receiptArtifact,
      receiptBundleArtifact,
      ...IMAGE_KEYS.map(key => imageBundleArtifacts[key])
    ]);
    const artifactsByPathKey = {
      receiptPath: receiptArtifact,
      receiptBundlePath: receiptBundleArtifact,
      botOrchestratorBundlePath: imageBundleArtifacts.botOrchestrator,
      botRunnerBundlePath: imageBundleArtifacts.botRunner,
      reticulumBundlePath: imageBundleArtifacts.reticulum
    };
    if (expectedBindings && ARTIFACT_PATH_KEYS.some(key =>
      !matchesIdentity(
        artifactsByPathKey[key].stat,
        expectedBindings[key],
        ARTIFACT_IDENTITY_KEYS
      )
    )) {
      fail("artifact_binding_mismatch");
    }
    const expectedCommit = expectedSourceCommit();
    const receipt = parseCanonicalReceipt(receiptArtifact.bytes, expectedCommit);
    parseBundle(receiptBundleArtifact.bytes, "receipt_bundle_invalid");
    for (const key of IMAGE_KEYS) {
      parseBundle(imageBundleArtifacts[key].bytes, imageBundleInputs[key].contentCode);
    }

    const result = callback({
      expectedCommit,
      receipt,
      receiptArtifact,
      receiptBundleArtifact,
      imageBundleArtifacts,
      imageBundleInputs
    });

    verifyStableArtifact(receiptArtifact, "receipt_changed");
    verifyStableArtifact(receiptBundleArtifact, "receipt_bundle_changed");
    for (const key of IMAGE_KEYS) {
      verifyStableArtifact(
        imageBundleArtifacts[key],
        imageBundleInputs[key].changedCode
      );
    }
    return result;
  } finally {
    closeArtifact(receiptArtifact);
    closeArtifact(receiptBundleArtifact);
    for (const key of IMAGE_KEYS) closeArtifact(imageBundleArtifacts[key]);
  }
}

export function inspectRuntimeImageBuildProvenanceArtifacts({
  receiptPath,
  receiptBundlePath,
  botOrchestratorBundlePath,
  botRunnerBundlePath,
  reticulumBundlePath,
  expectedSourceCommit
}) {
  return withStableRuntimeImageBuildArtifacts({
    receiptPath,
    receiptBundlePath,
    botOrchestratorBundlePath,
    botRunnerBundlePath,
    reticulumBundlePath,
    expectedSourceCommit: () => expectedSourceCommit === undefined
      ? resolveRuntimeImageBuildSourceCommit()
      : checkedExpectedCommit(expectedSourceCommit)
  }, () => true);
}

function sameDirectoryStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.isDirectory() === right.isDirectory();
}

function openSnapshotParent(privateParentDirectory) {
  const resolved = checkedAbsolutePath(
    privateParentDirectory,
    "artifact_snapshot_parent_invalid"
  );
  let descriptor;
  try {
    if (path.resolve(resolved) !== resolved ||
        typeof fs.constants.O_DIRECTORY !== "number" ||
        typeof fs.constants.O_NOFOLLOW !== "number" ||
        typeof process.getuid !== "function") {
      fail("artifact_snapshot_parent_invalid");
    }
    const real = fs.realpathSync(resolved);
    const named = fs.lstatSync(resolved, { bigint: true });
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (real !== resolved || named.isSymbolicLink() || !named.isDirectory() ||
        !sameDirectoryStat(named, opened) ||
        opened.uid !== BigInt(process.getuid()) ||
        Number(opened.mode & 0o7777n) !== SNAPSHOT_DIRECTORY_MODE) {
      fail("artifact_snapshot_parent_invalid");
    }
    return { path: resolved, descriptor, stat: opened };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the primary error. */ }
    }
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail("artifact_snapshot_parent_invalid");
  }
}

function assertSnapshotParent(parent, code = "artifact_snapshot_parent_changed") {
  try {
    const real = fs.realpathSync(parent.path);
    const named = fs.lstatSync(parent.path, { bigint: true });
    const opened = fs.fstatSync(parent.descriptor, { bigint: true });
    if (real !== parent.path || named.isSymbolicLink() ||
        !sameDirectoryStat(parent.stat, named) ||
        !sameDirectoryStat(parent.stat, opened)) {
      fail(code);
    }
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail(code);
  }
}

function createSnapshotDirectory(parent, snapshot) {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    let suffix;
    try {
      suffix = randomBytes(16).toString("hex");
    } catch {
      fail("artifact_snapshot_random_failed");
    }
    const directoryPath = path.join(
      parent.path,
      `${SNAPSHOT_DIRECTORY_PREFIX}${suffix}`
    );
    try {
      assertSnapshotParent(parent);
      fs.mkdirSync(directoryPath, { mode: SNAPSHOT_DIRECTORY_MODE });
      snapshot.path = directoryPath;
      snapshot.stat = fs.lstatSync(directoryPath, { bigint: true });
      snapshot.descriptor = fs.openSync(
        directoryPath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      fs.fchmodSync(snapshot.descriptor, SNAPSHOT_DIRECTORY_MODE);
      const opened = fs.fstatSync(snapshot.descriptor, { bigint: true });
      const named = fs.lstatSync(directoryPath, { bigint: true });
      if (named.isSymbolicLink() || !opened.isDirectory() ||
          !sameDirectoryStat(opened, named) ||
          opened.uid !== BigInt(process.getuid()) ||
          Number(opened.mode & 0o7777n) !== SNAPSHOT_DIRECTORY_MODE) {
        fail("artifact_snapshot_directory_invalid");
      }
      snapshot.stat = opened;
      fs.fsyncSync(parent.descriptor);
      fs.fsyncSync(snapshot.descriptor);
      return snapshot;
    } catch (error) {
      if (error?.code === "EEXIST" && snapshot.path === undefined) continue;
      if (error instanceof RuntimeImageBuildProvenanceError) throw error;
      fail("artifact_snapshot_directory_invalid");
    }
  }
  fail("artifact_snapshot_directory_invalid");
}

function assertSnapshotDirectory(parent, snapshot, code = "artifact_snapshot_changed") {
  assertSnapshotParent(parent, code);
  try {
    const named = fs.lstatSync(snapshot.path, { bigint: true });
    const opened = fs.fstatSync(snapshot.descriptor, { bigint: true });
    if (named.isSymbolicLink() ||
        !sameDirectoryStat(snapshot.stat, named) ||
        !sameDirectoryStat(snapshot.stat, opened)) {
      fail(code);
    }
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail(code);
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) fail("artifact_snapshot_write_failed");
    offset += count;
  }
}

function uniqueSnapshotName(preferred, used) {
  let candidate = preferred;
  let suffix = 0;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `.artifact-${suffix}-${preferred}`;
  }
  used.add(candidate);
  return candidate;
}

function createSnapshotFile(parent, snapshot, fileName, sourceArtifact) {
  const filePath = path.join(snapshot.path, fileName);
  const bytes = Buffer.from(sourceArtifact.bytes);
  let descriptor;
  let state;
  let readBack;
  try {
    assertSnapshotDirectory(parent, snapshot);
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      SNAPSHOT_FILE_MODE
    );
    state = { path: filePath, descriptor, stat: undefined, bytes };
    snapshot.files.push(state);
    fs.fchmodSync(descriptor, SNAPSHOT_FILE_MODE);
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(filePath, { bigint: true });
    readBack = readExactDescriptor(descriptor, bytes.length, "artifact_snapshot_write_failed");
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    if (named.isSymbolicLink() || !opened.isFile() || opened.nlink !== 1n ||
        opened.uid !== BigInt(process.getuid()) ||
        Number(opened.mode & 0o7777n) !== SNAPSHOT_FILE_MODE ||
        !sameFileStat(opened, named) || !sameFileStat(opened, afterRead) ||
        !readBack.equals(bytes)) {
      fail("artifact_snapshot_write_failed");
    }
    state.stat = opened;
    fs.fsyncSync(snapshot.descriptor);
    return state;
  } catch (error) {
    if (descriptor !== undefined && state === undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the primary error. */ }
    }
    if (state === undefined) bytes.fill(0);
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail("artifact_snapshot_write_failed");
  } finally {
    if (readBack) readBack.fill(0);
  }
}

function createArtifactSnapshot(parent, snapshot, artifacts) {
  const usedNames = new Set();
  const preferredNames = {
    receiptPath: path.basename(artifacts.receiptPath.resolved),
    receiptBundlePath: ".receipt-bundle.sigstore.json",
    botOrchestratorBundlePath: ".bot-orchestrator-bundle.sigstore.json",
    botRunnerBundlePath: ".bot-runner-bundle.sigstore.json",
    reticulumBundlePath: ".reticulum-bundle.sigstore.json"
  };
  const paths = {};
  const bindings = {};
  for (const key of ARTIFACT_PATH_KEYS) {
    const file = createSnapshotFile(
      parent,
      snapshot,
      uniqueSnapshotName(preferredNames[key], usedNames),
      artifacts[key]
    );
    paths[key] = file.path;
    bindings[key] = artifactIdentity(file.stat);
  }
  snapshot.result = Object.freeze({
    artifactPaths: Object.freeze(paths),
    artifactBindings: Object.freeze(bindings),
    privateWorkDirectory: snapshot.path,
    privateWorkDirectoryIdentity: directoryIdentity(snapshot.stat)
  });
  return snapshot;
}

function checkedSnapshotHooks(hooks) {
  if (hooks === undefined) return undefined;
  if (!object(hooks) || Object.keys(hooks).some(name =>
    !SNAPSHOT_HOOK_NAMES.has(name) || typeof hooks[name] !== "function"
  )) {
    fail("artifact_snapshot_hooks_invalid");
  }
  return hooks;
}

async function runSnapshotHook(hooks, name, context) {
  if (hooks?.[name]) await hooks[name](context);
}

function verifySnapshotState(parent, snapshot) {
  assertSnapshotDirectory(parent, snapshot);
  for (const file of snapshot.files) {
    let readBack;
    try {
      const opened = fs.fstatSync(file.descriptor, { bigint: true });
      const named = fs.lstatSync(file.path, { bigint: true });
      readBack = readExactDescriptor(
        file.descriptor,
        file.bytes.length,
        "artifact_snapshot_changed"
      );
      if (named.isSymbolicLink() || !sameFileStat(file.stat, opened) ||
          !sameFileStat(file.stat, named) || !readBack.equals(file.bytes)) {
        fail("artifact_snapshot_changed");
      }
    } finally {
      if (readBack) readBack.fill(0);
    }
  }
}

function helperDirectoryIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    mode: String(Number(stat.mode & 0o7777n))
  };
}

function helperFileIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function anchoredUnlinkSnapshotFile(snapshot, file) {
  let currentBytes;
  let helperInput;
  let stdout;
  let stderr;
  try {
    if (snapshot.descriptor === undefined || !fs.existsSync(DIRFD_HELPER)) return false;
    const directoryStat = fs.fstatSync(snapshot.descriptor, { bigint: true });
    const before = fs.fstatSync(file.descriptor, { bigint: true });
    if (!sameDirectoryStat(snapshot.stat, directoryStat) || !before.isFile() ||
        before.uid !== BigInt(process.getuid()) || before.nlink !== 1n ||
        Number(before.mode & 0o7777n) !== SNAPSHOT_FILE_MODE ||
        before.size < 0n || before.size > BigInt(MAX_BUNDLE_BYTES)) {
      return false;
    }
    currentBytes = readExactDescriptor(
      file.descriptor,
      Number(before.size),
      "artifact_snapshot_cleanup_failed"
    );
    const after = fs.fstatSync(file.descriptor, { bigint: true });
    if (!sameFileStat(before, after)) return false;
    const identity = helperDirectoryIdentity(directoryStat);
    const request = JSON.stringify({
      action: "unlink-owned",
      args: {
        directory: "target",
        name: path.basename(file.path),
        expected: helperFileIdentity(after),
        maximum: MAX_BUNDLE_BYTES,
        expectedLength: currentBytes.length,
        expectedSha256: sha256(currentBytes)
      },
      target: identity,
      staging: identity
    });
    helperInput = Buffer.from(`${request}\n`, "utf8");
    // The helper operates relative to the already-open 0700 directory, moves
    // the exact inode to a no-replace quarantine and rechecks its full digest
    // before unlinking. As elsewhere in this local workflow, actively hostile
    // code running concurrently as this same UID is outside the security model.
    const result = spawnSync(PYTHON, ["-I", DIRFD_HELPER], {
      input: helperInput,
      encoding: null,
      maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe", snapshot.descriptor, snapshot.descriptor]
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    return !result?.error && !result?.signal && result?.status === 0 &&
      Buffer.isBuffer(stdout) && stdout.length === 0 &&
      Buffer.isBuffer(stderr) && stderr.length === 0;
  } catch {
    return false;
  } finally {
    if (currentBytes) currentBytes.fill(0);
    if (helperInput) helperInput.fill(0);
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

function cleanupArtifactSnapshot(parent, snapshot) {
  let clean = true;
  if (snapshot) {
    for (const file of [...snapshot.files].reverse()) {
      if (!anchoredUnlinkSnapshotFile(snapshot, file)) clean = false;
      try { fs.closeSync(file.descriptor); } catch { clean = false; }
      file.bytes.fill(0);
    }
    if (snapshot.descriptor !== undefined) {
      try { fs.fsyncSync(snapshot.descriptor); } catch { clean = false; }
      try { fs.closeSync(snapshot.descriptor); } catch { clean = false; }
    }
    if (snapshot.path !== undefined) {
      try {
        const named = fs.lstatSync(snapshot.path, { bigint: true });
        const knownDirectory = snapshot.stat === undefined
          ? named.isDirectory() && !named.isSymbolicLink() &&
            named.uid === BigInt(process.getuid()) &&
            Number(named.mode & 0o7777n) === SNAPSHOT_DIRECTORY_MODE
          : sameDirectoryStat(snapshot.stat, named);
        if (!knownDirectory || fs.readdirSync(snapshot.path).length !== 0) {
          clean = false;
        } else {
          fs.rmdirSync(snapshot.path);
        }
      } catch {
        clean = false;
      }
    }
  }
  if (parent) {
    try { fs.fsyncSync(parent.descriptor); } catch { clean = false; }
    try { fs.closeSync(parent.descriptor); } catch { clean = false; }
  }
  return clean;
}

export async function withRuntimeImageBuildProvenanceArtifactSnapshot({
  receiptPath,
  receiptBundlePath,
  botOrchestratorBundlePath,
  botRunnerBundlePath,
  reticulumBundlePath,
  privateParentDirectory,
  expectedSourceCommit,
  callback,
  hooks
}) {
  if (typeof callback !== "function") fail("artifact_snapshot_callback_invalid");
  const checkedHooks = checkedSnapshotHooks(hooks);
  let parent;
  let snapshot;
  let setupFailure;
  let callbackFailure;
  let result;
  try {
    parent = openSnapshotParent(privateParentDirectory);
    snapshot = { path: undefined, descriptor: undefined, stat: undefined, files: [] };
    createSnapshotDirectory(parent, snapshot);
    withStableRuntimeImageBuildArtifacts({
      receiptPath,
      receiptBundlePath,
      botOrchestratorBundlePath,
      botRunnerBundlePath,
      reticulumBundlePath,
      expectedSourceCommit: () => expectedSourceCommit === undefined
        ? resolveRuntimeImageBuildSourceCommit()
        : checkedExpectedCommit(expectedSourceCommit)
    }, ({ receiptArtifact, receiptBundleArtifact, imageBundleArtifacts }) =>
      createArtifactSnapshot(parent, snapshot, {
        receiptPath: receiptArtifact,
        receiptBundlePath: receiptBundleArtifact,
        botOrchestratorBundlePath: imageBundleArtifacts.botOrchestrator,
        botRunnerBundlePath: imageBundleArtifacts.botRunner,
        reticulumBundlePath: imageBundleArtifacts.reticulum
      })
    );
    verifySnapshotState(parent, snapshot);
    await runSnapshotHook(checkedHooks, "afterSnapshotReady", snapshot.result);
    verifySnapshotState(parent, snapshot);
  } catch (error) {
    setupFailure = error instanceof RuntimeImageBuildProvenanceError
      ? error
      : new RuntimeImageBuildProvenanceError("artifact_snapshot_failed");
  }

  if (!setupFailure) {
    try {
      result = await callback(snapshot.result);
    } catch (error) {
      callbackFailure = error;
    }
    try {
      await runSnapshotHook(checkedHooks, "afterCallback", snapshot.result);
      verifySnapshotState(parent, snapshot);
    } catch (error) {
      setupFailure = error instanceof RuntimeImageBuildProvenanceError
        ? error
        : new RuntimeImageBuildProvenanceError("artifact_snapshot_failed");
    }
  }

  const cleaned = cleanupArtifactSnapshot(parent, snapshot);
  if (!cleaned) fail("artifact_snapshot_cleanup_failed");
  if (setupFailure) throw setupFailure;
  if (callbackFailure) throw callbackFailure;
  return result;
}

function trustedExecutable(stat) {
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  return stat.isFile() && Number(stat.mode & 0o022n) === 0 &&
    (uid === null || stat.uid === 0n || stat.uid === uid);
}

export function resolveGhExecutable() {
  for (const candidate of GH_CANDIDATES) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved, { bigint: true });
      if (path.isAbsolute(resolved) && trustedExecutable(stat)) return resolved;
    } catch {
      // Continue through the fixed trusted installation locations.
    }
  }
  fail("gh_executable_invalid");
}

function resolveGitExecutable() {
  for (const candidate of GIT_CANDIDATES) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved, { bigint: true });
      if (path.isAbsolute(resolved) && trustedExecutable(stat)) return resolved;
    } catch {
      // Continue through the fixed trusted installation locations.
    }
  }
  fail("source_commit_resolution_failed");
}

function checkedPhysicalDirectory(value) {
  const resolved = checkedAbsolutePath(value, "source_commit_resolution_failed");
  try {
    const real = fs.realpathSync(resolved);
    const stat = fs.lstatSync(resolved, { bigint: true });
    if (real !== resolved || stat.isSymbolicLink() || !stat.isDirectory()) {
      fail("source_commit_resolution_failed");
    }
    return resolved;
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail("source_commit_resolution_failed");
  }
}

function gitEnvironment() {
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never"
  };
}

function runGit(executable, repositoryRoot, args) {
  let result;
  let stdout;
  let stderr;
  try {
    result = spawnSync(executable, ["-C", repositoryRoot, ...args], {
      env: gitEnvironment(),
      encoding: null,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"]
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stdout.length > MAX_GIT_OUTPUT_BYTES || stderr.length !== 0) {
      fail("source_commit_resolution_failed");
    }
    const text = stdout.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(stdout)) {
      fail("source_commit_resolution_failed");
    }
    return text;
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail("source_commit_resolution_failed");
  } finally {
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

function parseGitCommitOutput(output) {
  if (typeof output !== "string" || !/^[a-f0-9]{40}\n$/u.test(output)) {
    fail("source_commit_resolution_failed");
  }
  return output.slice(0, -1);
}

export function resolveRuntimeImageBuildSourceCommit(repositoryRoot = PROJECT_ROOT) {
  const root = checkedPhysicalDirectory(repositoryRoot);
  const cloudRoot = checkedPhysicalDirectory(path.join(root, "hubs-cloud"));
  const executable = resolveGitExecutable();
  if (runGit(executable, root, ["rev-parse", "--show-toplevel"]) !== `${root}\n` ||
      runGit(executable, root, ["symbolic-ref", "--quiet", "HEAD"]) !==
        "refs/heads/main\n") {
    fail("source_commit_resolution_failed");
  }
  const rootHead = parseGitCommitOutput(
    runGit(executable, root, ["rev-parse", "--verify", "HEAD^{commit}"])
  );
  const rootMain = parseGitCommitOutput(
    runGit(executable, root, ["rev-parse", "--verify", "refs/heads/main^{commit}"])
  );
  const rootOriginMain = parseGitCommitOutput(
    runGit(executable, root, [
      "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"
    ])
  );
  if (rootHead !== rootMain || rootHead !== rootOriginMain ||
      runGit(executable, root, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--ignore-submodules=none"
      ]) !== "") {
    fail("source_commit_resolution_failed");
  }

  const treeEntry = runGit(executable, root, ["ls-tree", "-z", "HEAD", "--", "hubs-cloud"]);
  const match = /^160000 commit ([a-f0-9]{40})\thubs-cloud\u0000$/u.exec(treeEntry);
  if (!match) fail("source_commit_resolution_failed");
  const gitlinkCommit = match[1];

  if (runGit(executable, cloudRoot, ["rev-parse", "--show-toplevel"]) !==
        `${cloudRoot}\n` ||
      parseGitCommitOutput(
        runGit(executable, cloudRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
      ) !== gitlinkCommit ||
      runGit(executable, cloudRoot, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--ignore-submodules=none"
      ]) !== "") {
    fail("source_commit_resolution_failed");
  }
  const cloudOriginMaster = parseGitCommitOutput(
    runGit(executable, cloudRoot, [
      "rev-parse", "--verify", "refs/remotes/origin/master^{commit}"
    ])
  );
  if (runGit(executable, cloudRoot, [
    "merge-base", "--is-ancestor", gitlinkCommit, cloudOriginMaster
  ]) !== "") {
    fail("source_commit_resolution_failed");
  }
  if (checkedPhysicalDirectory(root) !== root ||
      checkedPhysicalDirectory(cloudRoot) !== cloudRoot ||
      runGit(executable, root, ["rev-parse", "--show-toplevel"]) !== `${root}\n` ||
      runGit(executable, root, ["symbolic-ref", "--quiet", "HEAD"]) !==
        "refs/heads/main\n" ||
      parseGitCommitOutput(
        runGit(executable, root, ["rev-parse", "--verify", "HEAD^{commit}"])
      ) !== rootHead ||
      parseGitCommitOutput(
        runGit(executable, root, ["rev-parse", "--verify", "refs/heads/main^{commit}"])
      ) !== rootMain ||
      parseGitCommitOutput(runGit(executable, root, [
        "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"
      ])) !== rootOriginMain ||
      runGit(executable, root, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--ignore-submodules=none"
      ]) !== "" ||
      runGit(executable, root, ["ls-tree", "-z", "HEAD", "--", "hubs-cloud"]) !==
        treeEntry ||
      runGit(executable, cloudRoot, ["rev-parse", "--show-toplevel"]) !==
        `${cloudRoot}\n` ||
      parseGitCommitOutput(
        runGit(executable, cloudRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
      ) !== gitlinkCommit ||
      parseGitCommitOutput(runGit(executable, cloudRoot, [
        "rev-parse", "--verify", "refs/remotes/origin/master^{commit}"
      ])) !== cloudOriginMaster ||
      runGit(executable, cloudRoot, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--ignore-submodules=none"
      ]) !== "") {
    fail("source_commit_resolution_failed");
  }
  return gitlinkCommit;
}

function checkedDockerConfigDirectory(value) {
  if (value === undefined) return null;
  const resolved = checkedAbsolutePath(value, "docker_config_directory_invalid");
  try {
    const real = fs.realpathSync(resolved);
    const stat = fs.lstatSync(resolved, { bigint: true });
    if (real !== resolved || stat.isSymbolicLink() || !stat.isDirectory() ||
        typeof process.getuid !== "function" ||
        stat.uid !== BigInt(process.getuid()) || Number(stat.mode & 0o7777n) !== 0o700) {
      fail("docker_config_directory_invalid");
    }
    return { resolved, stat };
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail("docker_config_directory_invalid");
  }
}

function verifyDockerConfigDirectory(directory) {
  if (!directory) return;
  try {
    const real = fs.realpathSync(directory.resolved);
    const stat = fs.lstatSync(directory.resolved, { bigint: true });
    if (real !== directory.resolved || stat.isSymbolicLink() || !stat.isDirectory() ||
        !sameFileStat(directory.stat, stat) ||
        typeof process.getuid !== "function" ||
        stat.uid !== BigInt(process.getuid()) || Number(stat.mode & 0o7777n) !== 0o700) {
      fail("docker_config_directory_changed");
    }
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail("docker_config_directory_changed");
  }
}

function minimalEnvironment(dockerConfigDirectory) {
  const environment = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    GH_PAGER: "cat",
    GH_HOST: "github.com"
  };
  for (const name of ["HOME", "GH_CONFIG_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (typeof process.env[name] === "string" && process.env[name]) {
      environment[name] = process.env[name];
    }
  }
  if (dockerConfigDirectory) {
    environment.DOCKER_CONFIG = dockerConfigDirectory;
  } else if (typeof process.env.DOCKER_CONFIG === "string" && process.env.DOCKER_CONFIG) {
    environment.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  }
  return environment;
}

export function runGhAttestationVerification(invocation) {
  return spawnSync(invocation.executable, invocation.args, {
    env: invocation.env,
    encoding: null,
    timeout: GH_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: MAX_GH_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function invokeGh({
  executable,
  runner,
  subject,
  bundlePath,
  expectedSourceCommit,
  dockerConfigDirectory
}) {
  const args = [
    "attestation", "verify", subject,
    "--repo", RUNTIME_IMAGE_BUILD_REPOSITORY,
    "--bundle", bundlePath,
    "--signer-workflow", RUNTIME_IMAGE_BUILD_SIGNER_WORKFLOW,
    "--signer-digest", expectedSourceCommit,
    "--source-digest", expectedSourceCommit,
    "--source-ref", RUNTIME_IMAGE_BUILD_SOURCE_REF,
    "--cert-oidc-issuer", OIDC_ISSUER,
    "--predicate-type", SLSA_PREDICATE,
    "--deny-self-hosted-runners",
    "--hostname", "github.com",
    "--format", "json"
  ];
  let result;
  let stdout;
  let stderr;
  try {
    result = runner({
      executable,
      args,
      env: minimalEnvironment(dockerConfigDirectory)
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stdout.length > MAX_GH_OUTPUT_BYTES ||
        stderr.length !== 0) {
      fail("attestation_command_failed");
    }
    const text = stdout.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(stdout)) fail("attestation_output_invalid");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64) {
      fail("attestation_output_invalid");
    }
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeImageBuildProvenanceError) throw error;
    fail("attestation_output_invalid");
  } finally {
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

function expectedInvocation(receipt) {
  return `https://github.com/${RUNTIME_IMAGE_BUILD_REPOSITORY}/actions/runs/${
    receipt.runId
  }/attempts/${receipt.runAttempt}`;
}

function signerUri() {
  return `https://github.com/${RUNTIME_IMAGE_BUILD_SIGNER_WORKFLOW}@${
    RUNTIME_IMAGE_BUILD_SOURCE_REF
  }`;
}

function validateCommonAttestation(entry, receipt) {
  const verification = entry?.verificationResult;
  const statement = verification?.statement;
  const predicate = statement?.predicate;
  const buildDefinition = predicate?.buildDefinition;
  const runDetails = predicate?.runDetails;
  const certificate = verification?.signature?.certificate;
  const invocation = runDetails?.metadata?.invocationId;
  const expectedSigner = signerUri();
  const repositoryUri = `https://github.com/${RUNTIME_IMAGE_BUILD_REPOSITORY}`;
  const dependencyUri =
    `git+${repositoryUri}@${RUNTIME_IMAGE_BUILD_SOURCE_REF}`;
  const workflow = buildDefinition?.externalParameters?.workflow;
  const github = buildDefinition?.internalParameters?.github;
  const dependencies = buildDefinition?.resolvedDependencies;

  if (!object(verification) || !object(statement) || !object(predicate) ||
      statement._type !== IN_TOTO_STATEMENT ||
      statement.predicateType !== SLSA_PREDICATE ||
      buildDefinition?.buildType !== GITHUB_WORKFLOW_BUILD_TYPE ||
      workflow?.path !== RUNTIME_IMAGE_BUILD_WORKFLOW_PATH ||
      workflow?.ref !== RUNTIME_IMAGE_BUILD_SOURCE_REF ||
      workflow?.repository !== repositoryUri ||
      String(github?.repository_id || "") !== RUNTIME_IMAGE_BUILD_REPOSITORY_ID ||
      github?.event_name !== "workflow_dispatch" ||
      github?.runner_environment !== "github-hosted" ||
      !Array.isArray(dependencies) || dependencies.length !== 1 ||
      dependencies[0]?.uri !== dependencyUri ||
      dependencies[0]?.digest?.gitCommit !== receipt.sourceCommit ||
      runDetails?.builder?.id !== expectedSigner ||
      typeof invocation !== "string" ||
      !object(certificate) || certificate.issuer !== OIDC_ISSUER ||
      certificate.subjectAlternativeName !== expectedSigner ||
      certificate.buildSignerURI !== expectedSigner ||
      certificate.buildSignerDigest !== receipt.sourceCommit ||
      certificate.buildConfigURI !== expectedSigner ||
      certificate.buildConfigDigest !== receipt.sourceCommit ||
      certificate.runnerEnvironment !== "github-hosted" ||
      certificate.sourceRepositoryURI !== repositoryUri ||
      certificate.sourceRepositoryDigest !== receipt.sourceCommit ||
      certificate.sourceRepositoryRef !== RUNTIME_IMAGE_BUILD_SOURCE_REF ||
      String(certificate.sourceRepositoryIdentifier || "") !==
        RUNTIME_IMAGE_BUILD_REPOSITORY_ID ||
      certificate.buildTrigger !== "workflow_dispatch" ||
      certificate.runInvocationURI !== invocation) {
    fail("attestation_identity_invalid");
  }
  return { statement, invocation };
}

function exactSubject(statement, expectedName, expectedDigest) {
  const subjects = statement?.subject;
  return Array.isArray(subjects) && subjects.length === 1 &&
    exactKeys(subjects[0], ["digest", "name"]) &&
    subjects[0].name === expectedName &&
    exactKeys(subjects[0].digest, ["sha256"]) &&
    subjects[0].digest.sha256 === expectedDigest;
}

function verifyReceiptAttestation(entries, receipt, receiptArtifact) {
  if (entries.length !== 1) fail("receipt_attestation_invalid");
  const { statement, invocation } = validateCommonAttestation(entries[0], receipt);
  if (invocation !== expectedInvocation(receipt) ||
      !exactSubject(statement, path.basename(receiptArtifact.resolved), sha256(receiptArtifact.bytes))) {
    fail("receipt_attestation_invalid");
  }
}

function verifyImageAttestation(entries, receipt, imageReference) {
  const separator = imageReference.lastIndexOf("@sha256:");
  const expectedName = imageReference.slice(0, separator);
  const expectedDigest = imageReference.slice(separator + "@sha256:".length);
  const invocation = expectedInvocation(receipt);
  let matches = 0;
  for (const entry of entries) {
    const verified = validateCommonAttestation(entry, receipt);
    if (verified.invocation === invocation &&
        exactSubject(verified.statement, expectedName, expectedDigest)) {
      matches += 1;
    }
  }
  if (matches !== 1) fail("image_attestation_invalid");
  return `${expectedName}@sha256:${expectedDigest}`;
}

function executableForRunner(runner, suppliedExecutable) {
  if (suppliedExecutable !== undefined) {
    const executable = checkedAbsolutePath(suppliedExecutable, "gh_executable_invalid");
    if (runner === runGhAttestationVerification) {
      try {
        const resolved = fs.realpathSync(executable);
        const stat = fs.statSync(resolved, { bigint: true });
        if (!trustedExecutable(stat)) fail("gh_executable_invalid");
        return resolved;
      } catch (error) {
        if (error instanceof RuntimeImageBuildProvenanceError) throw error;
        fail("gh_executable_invalid");
      }
    }
    return executable;
  }
  return runner === runGhAttestationVerification ? resolveGhExecutable() : "/usr/bin/gh";
}

export function verifyRuntimeImageBuildProvenance({
  receiptPath,
  receiptBundlePath,
  botOrchestratorBundlePath,
  botRunnerBundlePath,
  reticulumBundlePath,
  artifactBindings,
  expectedSourceCommit,
  dockerConfigDirectory,
  runner = runGhAttestationVerification,
  ghExecutable
}) {
  if (typeof runner !== "function") fail("attestation_runner_invalid");
  const productionSourceTrust = runner === runGhAttestationVerification;
  let expectedCommit;
  if (productionSourceTrust) {
    if (expectedSourceCommit !== undefined) fail("expected_source_commit_override_forbidden");
    expectedCommit = resolveRuntimeImageBuildSourceCommit();
  } else {
    expectedCommit = checkedExpectedCommit(expectedSourceCommit);
  }
  const executable = executableForRunner(runner, ghExecutable);
  const dockerConfig = checkedDockerConfigDirectory(dockerConfigDirectory);
  return withStableRuntimeImageBuildArtifacts({
    receiptPath,
    receiptBundlePath,
    botOrchestratorBundlePath,
    botRunnerBundlePath,
    reticulumBundlePath,
    artifactBindings,
    expectedSourceCommit: () => expectedCommit
  }, ({
    receipt,
    receiptArtifact,
    receiptBundleArtifact,
    imageBundleArtifacts
  }) => {
    const receiptEntries = invokeGh({
      executable,
      runner,
      subject: receiptArtifact.resolved,
      bundlePath: receiptBundleArtifact.resolved,
      expectedSourceCommit: expectedCommit,
      dockerConfigDirectory: dockerConfig?.resolved
    });
    verifyReceiptAttestation(receiptEntries, receipt, receiptArtifact);

    const verifiedImages = {};
    for (const key of IMAGE_KEYS) {
      const imageReference = receipt.images[key];
      const entries = invokeGh({
        executable,
        runner,
        subject: `oci://${imageReference}`,
        bundlePath: imageBundleArtifacts[key].resolved,
        expectedSourceCommit: expectedCommit,
        dockerConfigDirectory: dockerConfig?.resolved
      });
      verifiedImages[key] = verifyImageAttestation(entries, receipt, imageReference);
    }
    if (!exactKeys(verifiedImages, IMAGE_KEYS) ||
        IMAGE_KEYS.some(key => verifiedImages[key] !== receipt.images[key])) {
      fail("image_attestation_set_invalid");
    }

    if (productionSourceTrust &&
        resolveRuntimeImageBuildSourceCommit() !== expectedCommit) {
      fail("source_commit_changed");
    }
    verifyDockerConfigDirectory(dockerConfig);
    return Object.freeze({
      sourceCommit: receipt.sourceCommit,
      invocationId: expectedInvocation(receipt),
      images: Object.freeze({ ...verifiedImages })
    });
  });
}

function parseFlags(argv) {
  const names = new Set([
    "--receipt",
    "--receipt-bundle",
    "--bot-orchestrator-bundle",
    "--bot-runner-bundle",
    "--reticulum-bundle"
  ]);
  if (argv.length !== names.size * 2) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.has(name) || values.has(name) || typeof value !== "string" ||
        value.length === 0 || value.startsWith("--")) {
      fail("arguments_invalid");
    }
    values.set(name, value);
  }
  return {
    receiptPath: values.get("--receipt"),
    receiptBundlePath: values.get("--receipt-bundle"),
    botOrchestratorBundlePath: values.get("--bot-orchestrator-bundle"),
    botRunnerBundlePath: values.get("--bot-runner-bundle"),
    reticulumBundlePath: values.get("--reticulum-bundle")
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyRuntimeImageBuildProvenance(parseFlags(process.argv.slice(2)));
    process.stdout.write(`${SUCCESS_TOKEN}\n`);
  } catch {
    process.stderr.write(GENERIC_ERROR);
    process.exitCode = 1;
  }
}

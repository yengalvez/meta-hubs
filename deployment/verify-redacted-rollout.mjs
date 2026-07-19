#!/usr/bin/env node

// Offline CLI for the strict AUD-065 redacted attestation. Every input is
// consumed from one owner-only, single-link regular file. The same verified
// bytes are parsed after two identical reads under stable pre/post metadata.

import {
  createHash,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  RedactedRolloutError,
  parseResourceListSource,
  parseStrictJsonSource,
  verifyReadyProcessLocalDeployments,
  verifyReleasedProcessLocalBaseline,
  verifyRedactedRollout
} from "./redacted-rollout-contract.mjs";
import {
  captureLiveProcessLocalResources
} from "./capture-process-local-baseline.mjs";
import { canonicalJson } from "./process-local-rotation.mjs";
import {
  PrivateArtifactPublicationError,
  publishPrivateArtifact
} from "./private-artifact-publication.mjs";
import {
  loadVerifiedProcessLocalRotationIntent,
  PROCESS_LOCAL_OPERATION_FILES
} from "./process-local-rotation-operation.mjs";

const MAX_PRIVATE_BYTES = 16 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;

function reject(code) {
  throw new RedactedRolloutError(code);
}

function requireNoFollowSupport() {
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_EXCL !== "number") {
    reject("private_filesystem_contract_unsupported");
  }
}

function resolvedTarget(target) {
  if (typeof target !== "string" || !target || target.includes("\0")) {
    reject("private_path_invalid");
  }
  return path.resolve(target);
}

function pathComponents(target, includeLeaf = true) {
  const resolved = resolvedTarget(target);
  const parsed = path.parse(resolved);
  const names = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const selected = includeLeaf ? names : names.slice(0, -1);
  let current = parsed.root;
  return selected.map((name, index) => {
    if (name === "." || name === "..") reject("private_path_invalid");
    current = path.join(current, name);
    const stat = fs.lstatSync(current, { bigint: true });
    const mustBeDirectory = !includeLeaf || index < selected.length - 1;
    if (stat.isSymbolicLink() || (mustBeDirectory && !stat.isDirectory())) {
      reject("private_path_invalid");
    }
    return { path: current, stat };
  });
}

function sameStat(left, right, { content = true } = {}) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink &&
    left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory() &&
    (!content || (
      left.size === right.size && left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    ));
}

function sameComponents(before, after, { leafContent = true } = {}) {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    if (entry.path !== current.path) return false;
    if (leafContent && index === before.length - 1) {
      return sameStat(entry.stat, current.stat);
    }
    return entry.stat.dev === current.stat.dev && entry.stat.ino === current.stat.ino &&
      entry.stat.mode === current.stat.mode && entry.stat.uid === current.stat.uid &&
      entry.stat.isFile() === current.stat.isFile() &&
      entry.stat.isDirectory() === current.stat.isDirectory();
  });
}

function ownerOnlyRegular(stat, maximumBytes, { allowEmpty = false } = {}) {
  const permissions = Number(stat.mode & 0o7777n);
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stat.uid;
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedUid &&
    stat.nlink === 1n && (permissions === 0o400 || permissions === 0o600) &&
    (allowEmpty ? stat.size >= 0n : stat.size >= 1n) &&
    stat.size <= BigInt(maximumBytes);
}

function ownerOnlyDirectory(stat) {
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stat.uid;
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === expectedUid &&
    Number(stat.mode & 0o7777n) === 0o700;
}

function readExact(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) reject("private_file_changed");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    reject("private_file_changed");
  }
  return bytes;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function readPrivateBytes(filePath, code, maximumBytes = MAX_PRIVATE_BYTES) {
  let descriptor;
  try {
    const beforeComponents = pathComponents(filePath);
    const before = beforeComponents.at(-1)?.stat;
    if (!before || !ownerOnlyRegular(before, maximumBytes)) reject(code);
    descriptor = fs.openSync(
      resolvedTarget(filePath),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!ownerOnlyRegular(opened, maximumBytes) || !sameStat(before, opened)) reject(code);
    const first = readExact(descriptor, Number(opened.size));
    const firstDigest = digest(first);
    const middle = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(opened, middle)) reject(code);
    const second = readExact(descriptor, Number(opened.size));
    const secondDigest = digest(second);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterComponents = pathComponents(filePath);
    if (!sameStat(opened, after) || !sameComponents(beforeComponents, afterComponents) ||
        firstDigest.length !== secondDigest.length ||
        !timingSafeEqual(firstDigest, secondDigest)) {
      reject(code);
    }
    return first;
  } catch (error) {
    if (error instanceof RedactedRolloutError) throw error;
    reject(code);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve value-free error. */ }
    }
  }
}

function privateUtf8(filePath, code, maximumBytes = MAX_PRIVATE_BYTES) {
  const bytes = readPrivateBytes(filePath, code, maximumBytes);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) reject(code);
  return text;
}

function canonicalArtifact(value) {
  return `${canonicalJson(value)}\n`;
}

function parseCanonicalResourceListSource(source, privateCode, jsonCode) {
  const resources = parseResourceListSource(source, jsonCode);
  if (source !== canonicalArtifact({ apiVersion: "v1", kind: "List", items: resources })) {
    reject(privateCode);
  }
  return resources;
}

function parseCanonicalJsonSource(source, privateCode, jsonCode) {
  const value = parseStrictJsonSource(source, jsonCode);
  if (source !== canonicalArtifact(value)) reject(privateCode);
  return value;
}

function assertOperationLayout(args) {
  const operationDirectory = resolvedTarget(args.get("--operation-directory"));
  const bundleDirectory = path.join(operationDirectory, "bundle");
  const expected = new Map([
    ["--original-baseline", path.join(
      operationDirectory, PROCESS_LOCAL_OPERATION_FILES.originalBaseline
    )],
    ["--baseline-resources", path.join(operationDirectory, "quiesced-baseline.json")],
    ["--old-values", path.join(
      operationDirectory, PROCESS_LOCAL_OPERATION_FILES.oldSnapshot
    )],
    ["--new-values", path.join(
      operationDirectory, PROCESS_LOCAL_OPERATION_FILES.newSnapshot
    )],
    ["--fingerprint-key", path.join(
      operationDirectory, PROCESS_LOCAL_OPERATION_FILES.operationKey
    )],
    ["--bundle", path.join(bundleDirectory, "bundle.json")],
    ["--bundle-binding", path.join(bundleDirectory, "binding.json")],
    ["--restart-contract", path.join(bundleDirectory, "restart-contract.json")]
  ]);
  if ([...expected].some(([name, expectedPath]) =>
    resolvedTarget(args.get(name)) !== expectedPath)) {
    reject("operation_layout_invalid");
  }
  try {
    if (!ownerOnlyDirectory(fs.lstatSync(bundleDirectory, { bigint: true }))) {
      reject("operation_layout_invalid");
    }
  } catch (error) {
    if (error instanceof RedactedRolloutError) throw error;
    reject("operation_layout_invalid");
  }
  return operationDirectory;
}

function writePrivateReport(filePath, report) {
  try {
    const body = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    publishPrivateArtifact({
      outputPath: filePath,
      bytes: body,
      maximumBytes: MAX_PRIVATE_BYTES
    });
  } catch (error) {
    if (error instanceof PrivateArtifactPublicationError) {
      if (error.code === "private_artifact_path_invalid") reject("private_path_invalid");
      if (error.code === "private_artifact_parent_invalid") {
        reject("private_report_parent_invalid");
      }
    }
    reject("private_report_write_failed");
  }
}

function parseArguments(argv) {
  const allowed = new Set([
    "--operation-directory",
    "--original-baseline",
    "--baseline-resources",
    "--old-values",
    "--new-values",
    "--bundle",
    "--bundle-binding",
    "--restart-contract",
    "--cas-responses",
    "--final-resources",
    "--operational-attestation",
    "--reticulum-jwk",
    "--dialog-public-key",
    "--fingerprint-key",
    "--report"
  ]);
  if (argv.length !== allowed.size * 2) reject("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name)) {
      reject("arguments_invalid");
    }
    values.set(name, value);
  }
  if ([...allowed].some(name => !values.has(name))) reject("arguments_invalid");
  return values;
}

function verifyRolloutMain(argv) {
  requireNoFollowSupport();
  const args = parseArguments(argv);
  const operationDirectory = assertOperationLayout(args);
  let operationIntent;
  try {
    operationIntent = loadVerifiedProcessLocalRotationIntent({ operationDirectory });
  } catch {
    reject("private_operation_intent_invalid");
  }
  const originalBaselineResources = parseCanonicalResourceListSource(privateUtf8(
    args.get("--original-baseline"), "private_original_baseline_invalid"
  ), "private_original_baseline_invalid", "original_baseline_json_invalid");
  const baselineResources = parseCanonicalResourceListSource(privateUtf8(
    args.get("--baseline-resources"), "private_baseline_invalid"
  ), "private_baseline_invalid", "baseline_resources_json_invalid");
  const oldValues = parseCanonicalJsonSource(privateUtf8(
    args.get("--old-values"), "private_old_values_invalid"
  ), "private_old_values_invalid", "old_values_json_invalid");
  const newValues = parseCanonicalJsonSource(privateUtf8(
    args.get("--new-values"), "private_new_values_invalid"
  ), "private_new_values_invalid", "new_values_json_invalid");
  const bundle = parseCanonicalJsonSource(privateUtf8(
    args.get("--bundle"), "private_bundle_invalid"
  ), "private_bundle_invalid", "bundle_json_invalid");
  const bundleBinding = parseCanonicalJsonSource(privateUtf8(
    args.get("--bundle-binding"), "private_bundle_binding_invalid"
  ), "private_bundle_binding_invalid", "bundle_binding_json_invalid");
  const restartContract = parseCanonicalJsonSource(privateUtf8(
    args.get("--restart-contract"), "private_restart_contract_invalid"
  ), "private_restart_contract_invalid", "restart_contract_json_invalid");
  const casResponseResources = parseResourceListSource(privateUtf8(
    args.get("--cas-responses"), "private_cas_responses_invalid"
  ), "cas_responses_json_invalid");
  const finalResources = parseResourceListSource(privateUtf8(
    args.get("--final-resources"), "private_final_resources_invalid"
  ), "final_resources_json_invalid");
  const operationalAttestation = parseStrictJsonSource(privateUtf8(
    args.get("--operational-attestation"), "private_operational_attestation_invalid"
  ), "operational_attestation_json_invalid");
  const reticulumRuntimeJwkSource = privateUtf8(
    args.get("--reticulum-jwk"), "private_reticulum_jwk_invalid", MAX_KEY_BYTES
  );
  const dialogRuntimePublicKeySource = privateUtf8(
    args.get("--dialog-public-key"), "private_dialog_public_key_invalid", MAX_KEY_BYTES
  );
  const fingerprintKey = readPrivateBytes(
    args.get("--fingerprint-key"), "private_fingerprint_key_invalid", MAX_KEY_BYTES
  );

  const report = verifyRedactedRollout({
    originalBaselineResources,
    baselineResources,
    oldValues,
    newValues,
    bundle,
    bundleBinding,
    operationIntent,
    restartContract,
    casResponseResources,
    finalResources,
    operationalAttestation,
    reticulumRuntimeJwkSource,
    dialogRuntimePublicKeySource,
    fingerprintKey
  });
  writePrivateReport(args.get("--report"), report);
  process.stdout.write("redacted_rollout_verified\n");
}

function parseReleaseArguments(argv) {
  const allowed = new Set([
    "--verified-baseline",
    "--released-baseline",
    "--namespace",
    "--initial-policy-resource-version"
  ]);
  if (argv.length !== allowed.size * 2) reject("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || values.has(name) ||
        typeof value !== "string" || value.length === 0) {
      reject("arguments_invalid");
    }
    values.set(name, value);
  }
  if ([...allowed].some(name => !values.has(name))) reject("arguments_invalid");
  return values;
}

function verifyReleaseMain(argv) {
  requireNoFollowSupport();
  const args = parseReleaseArguments(argv);
  const verifiedResources = parseCanonicalResourceListSource(privateUtf8(
    args.get("--verified-baseline"),
    "private_verified_release_baseline_invalid"
  ), "private_verified_release_baseline_invalid", "verified_release_baseline_json_invalid");
  const releasedResources = parseCanonicalResourceListSource(privateUtf8(
    args.get("--released-baseline"),
    "private_released_baseline_invalid"
  ), "private_released_baseline_invalid", "released_baseline_json_invalid");
  verifyReleasedProcessLocalBaseline({
    verifiedResources,
    releasedResources,
    namespace: args.get("--namespace"),
    initialPolicyResourceVersion: args.get("--initial-policy-resource-version")
  });
  process.stdout.write("process_local_release_verified\n");
}

function parseLiveReleaseArguments(argv) {
  const allowed = new Set([
    "--verified-baseline",
    "--released-baseline",
    "--namespace",
    "--initial-policy-resource-version",
    "--context"
  ]);
  if (argv.length !== allowed.size * 2) reject("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || values.has(name) ||
        typeof value !== "string" || value.length === 0) {
      reject("arguments_invalid");
    }
    values.set(name, value);
  }
  if ([...allowed].some(name => !values.has(name))) reject("arguments_invalid");
  return values;
}

function verifyLiveReleaseMain(argv) {
  requireNoFollowSupport();
  const args = parseLiveReleaseArguments(argv);
  const verifiedResources = parseCanonicalResourceListSource(privateUtf8(
    args.get("--verified-baseline"),
    "private_verified_release_baseline_invalid"
  ), "private_verified_release_baseline_invalid", "verified_release_baseline_json_invalid");
  const releasedResources = parseCanonicalResourceListSource(privateUtf8(
    args.get("--released-baseline"),
    "private_released_baseline_invalid"
  ), "private_released_baseline_invalid", "released_baseline_json_invalid");
  const contract = {
    verifiedResources,
    namespace: args.get("--namespace"),
    initialPolicyResourceVersion: args.get("--initial-policy-resource-version")
  };
  verifyReleasedProcessLocalBaseline({ ...contract, releasedResources });
  let liveResources;
  try {
    liveResources = captureLiveProcessLocalResources({
      context: args.get("--context"),
      namespace: contract.namespace
    });
  } catch {
    reject("live_release_capture_failed");
  }
  verifyReleasedProcessLocalBaseline({
    ...contract,
    releasedResources: liveResources
  });
  verifyReadyProcessLocalDeployments({
    resources: liveResources,
    namespace: contract.namespace
  });
  process.stdout.write("process_local_live_audit_verified\n");
}

function main(argv) {
  if (argv[0] === "verify-release") {
    verifyReleaseMain(argv.slice(1));
  } else if (argv[0] === "verify-live-release") {
    verifyLiveReleaseMain(argv.slice(1));
  } else {
    verifyRolloutMain(argv);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const code = error instanceof RedactedRolloutError ? error.code : "unexpected";
  process.stderr.write(`redacted_rollout_verification_failed:${code}\n`);
  process.exitCode = 1;
}

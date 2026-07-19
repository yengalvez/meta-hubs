#!/usr/bin/env node

// Build the AUD-065 operational attestation exclusively from authenticated,
// value-free capabilities.  The bundle binding is never reopened by this
// module and the final pathname is published atomically and idempotently.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadVerifiedProcessLocalOperationalAttestationInputs
} from "./materialize-process-local-replacements.mjs";
import {
  loadVerifiedProcessLocalBarrierBinding
} from "./process-local-rotation-operation.mjs";
import { canonicalJson } from "./process-local-rotation.mjs";
import { publishPrivateArtifact } from "./private-artifact-publication.mjs";

const MAX_ATTESTATION_BYTES = 1024 * 1024;

export class ProcessLocalOperationalAttestationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalOperationalAttestationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalOperationalAttestationError(code);
}

function safeEqual(left, right) {
  return typeof left === "string" && typeof right === "string" && left === right;
}

export function writeProcessLocalOperationalAttestation(options) {
  try {
    const inputs = loadVerifiedProcessLocalOperationalAttestationInputs(options);
    const barrier = loadVerifiedProcessLocalBarrierBinding({
      operationDirectory: options.operationDirectory
    });
    if (!safeEqual(barrier.operationId, inputs.operationId) ||
        !safeEqual(barrier.operationBindingSha256, inputs.operationBindingSha256)) {
      fail("operational_attestation_operation_mismatch");
    }
    const value = {
      schemaVersion: 1,
      expectedKubeContext: inputs.expectedKubeContext,
      namespaceName: inputs.namespaceName,
      namespaceUid: inputs.namespaceUid,
      retPvcName: inputs.retPvcName,
      retPvcUid: inputs.retPvcUid,
      checkpointStamp: inputs.checkpointStamp,
      checkpointDumpSha256: inputs.checkpointDumpSha256,
      checkpointStorageSha256: inputs.checkpointStorageSha256,
      checkpointInventorySha256: inputs.checkpointInventorySha256,
      lockName: "yenhubs-recovery-operation-lock",
      lockUid: barrier.lockUid,
      operationId: inputs.operationId,
      authenticatedContractState: "bundle-and-barrier-authenticated",
      operationBindingSha256: inputs.operationBindingSha256,
      bundleBindingHmacSha256: inputs.bundleBindingHmacSha256
    };
    const body = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
    publishPrivateArtifact({
      outputPath: options.outputPath,
      bytes: body,
      maximumBytes: MAX_ATTESTATION_BYTES
    });
    return true;
  } catch (error) {
    if (error instanceof ProcessLocalOperationalAttestationError) throw error;
    fail("operational_attestation_write_failed");
  }
}

function parseFlags(argv) {
  const names = new Set([
    "--operation-directory",
    "--quiesced-baseline",
    "--bundle",
    "--binding",
    "--operation-key",
    "--expected-operation-id",
    "--expected-operation-binding-sha256",
    "--output"
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
  if (values.size !== names.size) fail("arguments_invalid");
  return {
    operationDirectory: values.get("--operation-directory"),
    quiescedBaselinePath: values.get("--quiesced-baseline"),
    bundlePath: values.get("--bundle"),
    bindingPath: values.get("--binding"),
    operationKeyPath: values.get("--operation-key"),
    expectedOperationId: values.get("--expected-operation-id"),
    expectedOperationBindingSha256:
      values.get("--expected-operation-binding-sha256"),
    outputPath: values.get("--output")
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeProcessLocalOperationalAttestation(parseFlags(process.argv.slice(2)));
  } catch {
    process.stderr.write("process-local operational attestation failed closed\n");
    process.exitCode = 1;
  }
}

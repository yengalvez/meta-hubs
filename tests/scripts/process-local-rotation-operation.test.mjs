import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalOperationJson,
  emitVerifiedProcessLocalBaselineCapability,
  emitVerifiedProcessLocalRuntime,
  initProcessLocalRotationOperation,
  loadVerifiedProcessLocalBarrierBinding,
  loadVerifiedProcessLocalRotationIntent,
  sealProcessLocalRotationOperation,
  verifyProcessLocalBarrierBinding,
  verifyProcessLocalRotationOperation,
  verifyProcessLocalTerminalRecord,
  verifyProcessLocalTerminalRecordFromArtifacts,
  writeProcessLocalBarrierBinding,
  writeProcessLocalTerminalRecord,
  writeProcessLocalTerminalRecordFromArtifacts
} from "../../deployment/process-local-rotation-operation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "deployment/process-local-rotation-operation.mjs");
const REVISION = "aud065-operation-fixture";
const PGSQL_IMAGE = `registry.example.invalid/postgres@sha256:${"a".repeat(64)}`;

const metadata = Object.freeze({
  expectedKubeContext: "fixture-context",
  namespaceName: "hcce",
  namespaceUid: "namespace-uid-fixture",
  retPvcName: "ret-pvc",
  retPvcUid: "ret-pvc-uid-fixture",
  checkpointStamp: "20260718-170405",
  checkpointDumpSha256: "1".repeat(64),
  checkpointStorageSha256: "2".repeat(64),
  checkpointInventorySha256: "3".repeat(64),
  profileId: "yenhubs-process-local-credential-rotation-v1",
  profileSha256: "4".repeat(64)
});

const barrier = Object.freeze({
  policyUid: "pgsql-ingress-policy-uid",
  policyResourceVersion: "7392",
  policyMetadataSha256: "5".repeat(64),
  normalSpecSha256: "6".repeat(64),
  lockUid: "operation-lock-uid"
});

const terminal = Object.freeze({
  verifiedBaselineSha256: "7".repeat(64),
  releasedBaselineSha256: "8".repeat(64),
  reportSha256: "9".repeat(64),
  previousLockUid: barrier.lockUid
});

function deterministicRandom() {
  let next = 1;
  return size => Buffer.alloc(size, next++);
}

function operationBaseline() {
  const deployments = [
    "bot-orchestrator", "coturn", "dialog", "pgbouncer", "pgbouncer-t",
    "pgsql", "reticulum"
  ].map((name, index) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: "hcce",
      resourceVersion: String(100 + index),
      uid: `deployment-uid-${name}`
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      strategy: { type: "Recreate" },
      template: {
        metadata: {
          labels: {
            "z-fixture-order": "last",
            app: name,
            "a-fixture-order": "first"
          }
        },
        spec: {
          containers: [{
            image: name === "pgsql" ? PGSQL_IMAGE :
              `registry.example.invalid/${name}@sha256:${"b".repeat(64)}`,
            name: name === "pgsql" ? "postgresql" : name
          }]
        }
      }
    }
  }));
  const policy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "pgsql-ingress",
      namespace: "hcce",
      resourceVersion: "7392",
      uid: "pgsql-ingress-policy-uid"
    },
    spec: { podSelector: { matchLabels: { app: "pgsql" } }, policyTypes: ["Ingress"] }
  };
  const fillers = Array.from({ length: 34 }, (_, index) => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `fixture-${String(index).padStart(2, "0")}`,
      namespace: "hcce"
    }
  }));
  return { apiVersion: "v1", kind: "List", items: [...deployments, policy, ...fillers] };
}

function fixture({ seal = true, bind = false } = {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-operation-"));
  fs.chmodSync(parent, 0o700);
  const operationDirectory = path.join(parent, "operation");
  initProcessLocalRotationOperation({
    parentDirectory: parent,
    operationDirectory,
    rotationRevision: REVISION,
    randomBytes: deterministicRandom()
  });
  writePrivate(
    path.join(operationDirectory, "original-baseline.json"),
    `${canonicalOperationJson(operationBaseline())}\n`
  );
  writePrivate(path.join(operationDirectory, "old-snapshot.json"),
    `${canonicalOperationJson({
      DB_NAME: "ret",
      DB_PASS: "old-secret-never-print",
      DB_USER: "ret"
    })}\n`);
  writePrivate(path.join(operationDirectory, "new-snapshot.json"),
    `${canonicalOperationJson({
      DB_NAME: "ret",
      DB_PASS: "new-secret-never-print",
      DB_USER: "ret"
    })}\n`);
  writePrivate(
    path.join(operationDirectory, "old-values-source.yaml"),
    "FIXTURE_SOURCE: old-private-value\n"
  );
  writePrivate(
    path.join(operationDirectory, "new-values-source.yaml"),
    "FIXTURE_SOURCE: new-private-value\n"
  );
  if (seal) {
    sealProcessLocalRotationOperation({ operationDirectory, metadata });
  }
  if (bind) {
    writeProcessLocalBarrierBinding({ operationDirectory, barrier });
  }
  return { parent, operationDirectory };
}

function writePrivate(filePath, value) {
  fs.writeFileSync(filePath, value, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function rewriteCanonical(filePath, value) {
  fs.writeFileSync(filePath, `${canonicalOperationJson(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function terminalReport(overrides = {}) {
  return {
    schema_version: 2,
    verdict: "pass",
    inventories: {
      original_baseline_resources: 42,
      baseline_resources: 42,
      intermediate_cas_resources: 7,
      final_resources: 42,
      final_secrets: 1,
      final_deployments: 12,
      exact: true
    },
    ...overrides
  };
}

function writeTerminalArtifacts(input, {
  verifiedBaseline = operationBaseline(),
  releasedBaseline = operationBaseline(),
  report = terminalReport()
} = {}) {
  const verifiedBaselinePath = path.join(input.operationDirectory, "final-baseline.json");
  const releasedBaselinePath = path.join(
    input.operationDirectory,
    "released-baseline.json"
  );
  const reportPath = path.join(input.operationDirectory, "redacted-report.json");
  writePrivate(
    verifiedBaselinePath,
    `${canonicalOperationJson(verifiedBaseline)}\n`
  );
  writePrivate(
    releasedBaselinePath,
    `${canonicalOperationJson(releasedBaseline)}\n`
  );
  writePrivate(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {
    verifiedBaseline: verifiedBaselinePath,
    releasedBaseline: releasedBaselinePath,
    report: reportPath,
    previousLockUid: barrier.lockUid
  };
}

function cliMetadataArgs() {
  return [
    "--expected-kube-context", metadata.expectedKubeContext,
    "--namespace-name", metadata.namespaceName,
    "--namespace-uid", metadata.namespaceUid,
    "--ret-pvc-name", metadata.retPvcName,
    "--ret-pvc-uid", metadata.retPvcUid,
    "--checkpoint-stamp", metadata.checkpointStamp,
    "--checkpoint-dump-sha256", metadata.checkpointDumpSha256,
    "--checkpoint-storage-sha256", metadata.checkpointStorageSha256,
    "--checkpoint-inventory-sha256", metadata.checkpointInventorySha256,
    "--profile-id", metadata.profileId,
    "--profile-sha256", metadata.profileSha256
  ];
}

function cliBarrierArgs() {
  return [
    "--policy-uid", barrier.policyUid,
    "--policy-resource-version", barrier.policyResourceVersion,
    "--policy-metadata-sha256", barrier.policyMetadataSha256,
    "--normal-spec-sha256", barrier.normalSpecSha256,
    "--lock-uid", barrier.lockUid
  ];
}

function cliContinuityArgs(operationDirectory) {
  const intent = readJson(path.join(operationDirectory, "intent.json"));
  return [
    "--expected-operation-id", intent.operationId,
    "--expected-operation-binding-sha256", intent.operationBindingSha256
  ];
}

test("init creates a durable canonical private identity, revision and 32-byte key", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-init-"));
  fs.chmodSync(parent, 0o700);
  const operationDirectory = path.join(parent, "operation");
  try {
    assert.equal(initProcessLocalRotationOperation({
      parentDirectory: parent,
      operationDirectory,
      rotationRevision: REVISION,
      randomBytes: deterministicRandom()
    }), true);
    assert.deepEqual(fs.readdirSync(operationDirectory).sort(), [
      "identity.json", "operation.key", "revision.json"
    ]);
    const key = fs.readFileSync(path.join(operationDirectory, "operation.key"));
    const identityPath = path.join(operationDirectory, "identity.json");
    const revisionPath = path.join(operationDirectory, "revision.json");
    assert.equal(key.length, 32);
    assert.equal(key.equals(Buffer.alloc(32, 1)), true);
    const identity = readJson(identityPath);
    assert.match(identity.operationToken, /^[a-f0-9]{32}$/u);
    assert.match(identity.operationId, /^[a-f0-9]{32}$/u);
    assert.notEqual(identity.operationToken, identity.operationId);
    assert.equal(identity.rotationRevision, REVISION);
    assert.deepEqual(readJson(revisionPath), { rotationRevision: REVISION });
    assert.equal(fs.readFileSync(identityPath, "utf8"),
      `${canonicalOperationJson(identity)}\n`);
    for (const name of fs.readdirSync(operationDirectory)) {
      const stat = fs.lstatSync(path.join(operationDirectory, name));
      assert.equal(stat.mode & 0o7777, 0o600);
      assert.equal(stat.nlink, 1);
    }
    assert.equal(fs.lstatSync(operationDirectory).mode & 0o7777, 0o700);
  } finally {
    cleanup(parent);
  }
});

test("seal and verify bind metadata, identity and all five stable inputs", () => {
  const input = fixture();
  try {
    assert.equal(verifyProcessLocalRotationOperation({
      operationDirectory: input.operationDirectory,
      metadata
    }), true);
    const intentPath = path.join(input.operationDirectory, "intent.json");
    const intent = readJson(intentPath);
    const identity = readJson(path.join(input.operationDirectory, "identity.json"));
    assert.equal(intent.operationId, identity.operationId);
    assert.equal(intent.operationToken, identity.operationToken);
    assert.equal(intent.retPvcName, "ret-pvc");
    assert.equal(fs.readFileSync(intentPath, "utf8"),
      `${canonicalOperationJson(intent)}\n`);
    const body = structuredClone(intent);
    delete body.operationBindingSha256;
    delete body.hmacSha256;
    assert.equal(intent.operationBindingSha256,
      createHash("sha256").update(canonicalOperationJson(body)).digest("hex"));
    const authenticated = structuredClone(intent);
    delete authenticated.hmacSha256;
    assert.equal(intent.hmacSha256, createHmac(
      "sha256", fs.readFileSync(path.join(input.operationDirectory, "operation.key"))
    ).update(canonicalOperationJson(authenticated)).digest("hex"));

    writePrivate(path.join(input.operationDirectory, "coordinator-later.json"), "{}\n");
    assert.equal(verifyProcessLocalRotationOperation({
      operationDirectory: input.operationDirectory
    }), true);
    const loaded = loadVerifiedProcessLocalRotationIntent({
      operationDirectory: input.operationDirectory,
      metadata
    });
    assert.equal(loaded.operationId, intent.operationId);
    loaded.operationId = "f".repeat(32);
    assert.equal(readJson(intentPath).operationId, intent.operationId);
  } finally {
    cleanup(input.parent);
  }
});

test("terminal record is O_EXCL, durable and bound to the verified operation", () => {
  const input = fixture({ bind: true });
  try {
    assert.equal(writeProcessLocalTerminalRecord({
      operationDirectory: input.operationDirectory,
      terminal
    }), true);
    assert.equal(verifyProcessLocalTerminalRecord({
      operationDirectory: input.operationDirectory,
      terminal
    }), true);
    const filePath = path.join(input.operationDirectory, "terminal.json");
    const record = readJson(filePath);
    const intent = readJson(path.join(input.operationDirectory, "intent.json"));
    const binding = readJson(path.join(input.operationDirectory, "barrier-binding.json"));
    assert.equal(record.completed, true);
    assert.equal(record.operationId, intent.operationId);
    assert.equal(record.operationBindingSha256, intent.operationBindingSha256);
    assert.equal(
      record.barrierBindingSha256,
      createHash("sha256").update(canonicalOperationJson(binding)).digest("hex")
    );
    assert.equal(record.previousLockUid, barrier.lockUid);
    assert.equal(fs.lstatSync(filePath).mode & 0o7777, 0o600);
    assert.throws(() => writeProcessLocalTerminalRecord({
      operationDirectory: input.operationDirectory,
      terminal
    }));
    assert.throws(() => verifyProcessLocalTerminalRecord({
      operationDirectory: input.operationDirectory
    }));
  } finally {
    cleanup(input.parent);
  }
});

test("artifact terminal API derives all hashes and reconfirms exact private artifacts", () => {
  const input = fixture({ bind: true });
  try {
    const artifacts = writeTerminalArtifacts(input);
    assert.equal(writeProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: input.operationDirectory,
      ...artifacts
    }), true);
    const record = readJson(path.join(input.operationDirectory, "terminal.json"));
    assert.equal(
      record.verifiedBaselineSha256,
      createHash("sha256").update(fs.readFileSync(artifacts.verifiedBaseline)).digest("hex")
    );
    assert.equal(
      record.releasedBaselineSha256,
      createHash("sha256").update(fs.readFileSync(artifacts.releasedBaseline)).digest("hex")
    );
    assert.equal(
      record.reportSha256,
      createHash("sha256").update(fs.readFileSync(artifacts.report)).digest("hex")
    );
    assert.equal(verifyProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: input.operationDirectory,
      ...artifacts
    }), true);
    assert.throws(() => verifyProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: input.operationDirectory,
      ...artifacts,
      reportSha256: record.reportSha256
    }));
  } finally {
    cleanup(input.parent);
  }
});

test("artifact terminal CLI requires paths plus operation continuity and is silent", () => {
  const input = fixture({ bind: true });
  try {
    const artifacts = writeTerminalArtifacts(input);
    const pathArgs = [
      "--operation-directory", input.operationDirectory,
      "--verified-baseline", artifacts.verifiedBaseline,
      "--released-baseline", artifacts.releasedBaseline,
      "--report", artifacts.report,
      "--previous-lock-uid", artifacts.previousLockUid
    ];
    for (const command of [
      "write-terminal-from-artifacts",
      "verify-terminal-from-artifacts"
    ]) {
      const missingContinuity = spawnSync(
        process.execPath,
        [CLI, command, ...pathArgs],
        { encoding: "utf8" }
      );
      assert.equal(missingContinuity.status, 1, command);
      assert.equal(missingContinuity.stdout, "", command);
      assert.equal(
        missingContinuity.stderr,
        "process-local rotation operation failed closed\n",
        command
      );
    }
    assert.equal(
      fs.existsSync(path.join(input.operationDirectory, "terminal.json")),
      false
    );
    const args = [...pathArgs, ...cliContinuityArgs(input.operationDirectory)];
    for (const command of [
      "write-terminal-from-artifacts",
      "verify-terminal-from-artifacts"
    ]) {
      const result = spawnSync(process.execPath, [CLI, command, ...args], {
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
    const rejected = spawnSync(process.execPath, [
      CLI,
      "verify-terminal-from-artifacts",
      ...args,
      "--report-sha256", "a".repeat(64)
    ], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr, "process-local rotation operation failed closed\n");

    const intent = readJson(path.join(input.operationDirectory, "intent.json"));
    const wrongId = `${intent.operationId[0] === "a" ? "b" : "a"}${
      intent.operationId.slice(1)}`;
    const wrongBinding = `${
      intent.operationBindingSha256[0] === "a" ? "b" : "a"
    }${intent.operationBindingSha256.slice(1)}`;
    for (const continuity of [
      [
        "--expected-operation-id", wrongId,
        "--expected-operation-binding-sha256", intent.operationBindingSha256
      ],
      [
        "--expected-operation-id", intent.operationId,
        "--expected-operation-binding-sha256", wrongBinding
      ]
    ]) {
      const mismatch = spawnSync(process.execPath, [
        CLI,
        "verify-terminal-from-artifacts",
        ...pathArgs,
        ...continuity
      ], { encoding: "utf8" });
      assert.equal(mismatch.status, 1);
      assert.equal(mismatch.stdout, "");
      assert.equal(
        mismatch.stderr,
        "process-local rotation operation failed closed\n"
      );
    }
  } finally {
    cleanup(input.parent);
  }
});

test("artifact terminal rejects external, noncanonical and semantically invalid inputs", () => {
  const external = fixture({ bind: true });
  try {
    const artifacts = writeTerminalArtifacts(external);
    const externalPath = path.join(external.parent, "external-final-baseline.json");
    writePrivate(externalPath, fs.readFileSync(artifacts.verifiedBaseline));
    assert.throws(() => writeProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: external.operationDirectory,
      ...artifacts,
      verifiedBaseline: externalPath
    }));
    assert.equal(fs.existsSync(path.join(external.operationDirectory, "terminal.json")), false);
  } finally {
    cleanup(external.parent);
  }

  const loose = fixture({ bind: true });
  try {
    const artifacts = writeTerminalArtifacts(loose);
    fs.chmodSync(artifacts.report, 0o640);
    assert.throws(() => writeProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: loose.operationDirectory,
      ...artifacts
    }));
  } finally {
    cleanup(loose.parent);
  }

  const noncanonical = fixture({ bind: true });
  try {
    const artifacts = writeTerminalArtifacts(noncanonical);
    fs.writeFileSync(
      artifacts.verifiedBaseline,
      `${JSON.stringify(operationBaseline(), null, 2)}\n`,
      { mode: 0o600 }
    );
    assert.throws(() => writeProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: noncanonical.operationDirectory,
      ...artifacts
    }));
  } finally {
    cleanup(noncanonical.parent);
  }

  const noncanonicalReport = fixture({ bind: true });
  try {
    const artifacts = writeTerminalArtifacts(noncanonicalReport);
    fs.writeFileSync(
      artifacts.report,
      `${canonicalOperationJson(terminalReport())}\n`,
      { mode: 0o600 }
    );
    assert.throws(() => writeProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: noncanonicalReport.operationDirectory,
      ...artifacts
    }));
  } finally {
    cleanup(noncanonicalReport.parent);
  }

  const duplicate = fixture({ bind: true });
  try {
    const invalidReleased = operationBaseline();
    invalidReleased.items[41] = structuredClone(invalidReleased.items[0]);
    const artifacts = writeTerminalArtifacts(duplicate, {
      releasedBaseline: invalidReleased
    });
    assert.throws(() => writeProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: duplicate.operationDirectory,
      ...artifacts
    }));
  } finally {
    cleanup(duplicate.parent);
  }

  const report = fixture({ bind: true });
  try {
    const artifacts = writeTerminalArtifacts(report, {
      report: terminalReport({
        inventories: {
          ...terminalReport().inventories,
          final_resources: 41
        }
      })
    });
    assert.throws(() => writeProcessLocalTerminalRecordFromArtifacts({
      operationDirectory: report.operationDirectory,
      ...artifacts
    }));
  } finally {
    cleanup(report.parent);
  }
});

for (const hookName of ["beforePrivateFileOpen", "afterPrivateFileOpen"]) {
  test(`artifact terminal detects substitution at ${hookName}`, () => {
    const input = fixture({ bind: true });
    try {
      const artifacts = writeTerminalArtifacts(input);
      const originalBytes = fs.readFileSync(artifacts.verifiedBaseline);
      let substituted = false;
      assert.throws(() => writeProcessLocalTerminalRecordFromArtifacts({
        operationDirectory: input.operationDirectory,
        ...artifacts,
        hooks: {
          [hookName]({ name }) {
            if (name !== "final-baseline.json" || substituted) return;
            substituted = true;
            fs.renameSync(
              artifacts.verifiedBaseline,
              `${artifacts.verifiedBaseline}.original`
            );
            writePrivate(artifacts.verifiedBaseline, originalBytes);
          }
        }
      }));
      assert.equal(substituted, true);
      assert.equal(fs.existsSync(path.join(input.operationDirectory, "terminal.json")), false);
    } finally {
      cleanup(input.parent);
    }
  });
}

test("artifact terminal detects same-byte substitution after terminal publication", () => {
  const input = fixture({ bind: true });
  try {
    const artifacts = writeTerminalArtifacts(input);
    const originalBytes = fs.readFileSync(artifacts.verifiedBaseline);
    let substituted = false;
    assert.throws(
      () => writeProcessLocalTerminalRecordFromArtifacts({
        operationDirectory: input.operationDirectory,
        ...artifacts,
        hooks: {
          afterOwnedFileLinked({ name }) {
            if (name !== "terminal.json" || substituted) return;
            substituted = true;
            fs.renameSync(
              artifacts.verifiedBaseline,
              `${artifacts.verifiedBaseline}.pre-terminal`
            );
            writePrivate(artifacts.verifiedBaseline, originalBytes);
          }
        }
      }),
      error => error?.code === "terminal_artifact_changed"
    );
    assert.equal(substituted, true);
    assert.equal(fs.existsSync(path.join(input.operationDirectory, "terminal.json")), true);
  } finally {
    cleanup(input.parent);
  }
});

test("barrier binding is durable, HMAC-bound and verified against exact public inputs", () => {
  const input = fixture({ bind: true });
  try {
    assert.equal(verifyProcessLocalBarrierBinding({
      operationDirectory: input.operationDirectory,
      barrier
    }), true);
    const loaded = loadVerifiedProcessLocalBarrierBinding({
      operationDirectory: input.operationDirectory,
      barrier
    });
    const filePath = path.join(input.operationDirectory, "barrier-binding.json");
    const binding = readJson(filePath);
    const intent = readJson(path.join(input.operationDirectory, "intent.json"));
    assert.equal(binding.operationId, intent.operationId);
    assert.equal(binding.operationBindingSha256, intent.operationBindingSha256);
    assert.deepEqual(loaded, binding);
    loaded.lockUid = "mutated-clone";
    assert.equal(readJson(filePath).lockUid, barrier.lockUid);
    assert.equal(fs.lstatSync(filePath).mode & 0o7777, 0o600);
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    assert.equal(fs.readFileSync(filePath, "utf8"),
      `${canonicalOperationJson(binding)}\n`);
  } finally {
    cleanup(input.parent);
  }
});

test("verification reconciles the durable temp-plus-final publication cut", () => {
  const input = fixture({ bind: true });
  try {
    const finalPath = path.join(input.operationDirectory, "barrier-binding.json");
    const pendingPath = path.join(
      input.operationDirectory,
      `.barrier-binding.json.pending-${"a".repeat(32)}`
    );
    fs.linkSync(finalPath, pendingPath);
    assert.equal(fs.lstatSync(finalPath).nlink, 2);
    assert.equal(verifyProcessLocalBarrierBinding({
      operationDirectory: input.operationDirectory,
      barrier
    }), true);
    assert.equal(fs.existsSync(pendingPath), false);
    assert.equal(fs.lstatSync(finalPath).nlink, 1);
  } finally {
    cleanup(input.parent);
  }
});

test("rejects non-private parents, invalid revisions and existing operation outputs", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-reject-"));
  const operationDirectory = path.join(parent, "operation");
  try {
    fs.chmodSync(parent, 0o755);
    assert.throws(() => initProcessLocalRotationOperation({
      parentDirectory: parent,
      operationDirectory,
      rotationRevision: REVISION
    }));
    assert.equal(fs.existsSync(operationDirectory), false);
    fs.chmodSync(parent, 0o700);
    assert.throws(() => initProcessLocalRotationOperation({
      parentDirectory: parent,
      operationDirectory,
      rotationRevision: "AUD065-not-canonical"
    }));
    fs.mkdirSync(operationDirectory, { mode: 0o700 });
    writePrivate(path.join(operationDirectory, "preserve"), "preserve\n");
    assert.throws(() => initProcessLocalRotationOperation({
      parentDirectory: parent,
      operationDirectory,
      rotationRevision: REVISION
    }));
    assert.equal(fs.readFileSync(path.join(operationDirectory, "preserve"), "utf8"),
      "preserve\n");
  } finally {
    fs.chmodSync(parent, 0o700);
    cleanup(parent);
  }
});

test("rejects loose, hardlinked and symlinked owned inputs", () => {
  const loose = fixture({ seal: false });
  try {
    fs.chmodSync(path.join(loose.operationDirectory, "old-snapshot.json"), 0o640);
    assert.throws(() => sealProcessLocalRotationOperation({
      operationDirectory: loose.operationDirectory, metadata
    }));
    assert.equal(fs.existsSync(path.join(loose.operationDirectory, "intent.json")), false);
  } finally {
    cleanup(loose.parent);
  }

  const linked = fixture({ seal: false });
  try {
    fs.linkSync(
      path.join(linked.operationDirectory, "new-snapshot.json"),
      path.join(linked.operationDirectory, "new-snapshot-hardlink.json")
    );
    assert.throws(() => sealProcessLocalRotationOperation({
      operationDirectory: linked.operationDirectory, metadata
    }));
  } finally {
    cleanup(linked.parent);
  }

  const symlinked = fixture({ seal: false });
  const alias = `${symlinked.operationDirectory}-alias`;
  try {
    fs.symlinkSync(symlinked.operationDirectory, alias);
    assert.throws(() => sealProcessLocalRotationOperation({
      operationDirectory: alias, metadata
    }));
  } finally {
    try { fs.unlinkSync(alias); } catch {}
    cleanup(symlinked.parent);
  }
});

test("rejects setuid, setgid and sticky bits on owner-private operation paths", () => {
  for (const mode of [0o4600, 0o2600]) {
    const input = fixture({ seal: false });
    try {
      const snapshotPath = path.join(input.operationDirectory, "old-snapshot.json");
      fs.chmodSync(snapshotPath, mode);
      assert.equal(fs.lstatSync(snapshotPath).mode & 0o7777, mode);
      assert.throws(() => sealProcessLocalRotationOperation({
        operationDirectory: input.operationDirectory,
        metadata
      }));
      assert.equal(fs.existsSync(path.join(input.operationDirectory, "intent.json")), false);
    } finally {
      cleanup(input.parent);
    }
  }

  const sticky = fixture();
  try {
    fs.chmodSync(sticky.operationDirectory, 0o1700);
    assert.equal(fs.lstatSync(sticky.operationDirectory).mode & 0o7777, 0o1700);
    assert.throws(() => verifyProcessLocalRotationOperation({
      operationDirectory: sticky.operationDirectory
    }));
  } finally {
    fs.chmodSync(sticky.operationDirectory, 0o700);
    cleanup(sticky.parent);
  }
});

test("double reads fail closed when a snapshot changes between reads", () => {
  const input = fixture({ seal: false });
  let changed = false;
  try {
    assert.throws(() => sealProcessLocalRotationOperation({
      operationDirectory: input.operationDirectory,
      metadata,
      hooks: {
        afterPrivateFileFirstRead({ name }) {
          if (name === "old-snapshot.json" && !changed) {
            changed = true;
            fs.writeFileSync(
              path.join(input.operationDirectory, name),
              '{"DB_PASS":"replacement-never-print"}\n',
              { mode: 0o600 }
            );
          }
        }
      }
    }));
    assert.equal(changed, true);
    assert.equal(fs.existsSync(path.join(input.operationDirectory, "intent.json")), false);
  } finally {
    cleanup(input.parent);
  }
});

test("operation-directory substitution is detected without deleting the replacement", () => {
  const input = fixture({ seal: false });
  const moved = `${input.operationDirectory}-owned`;
  let substituted = false;
  try {
    assert.throws(() => sealProcessLocalRotationOperation({
      operationDirectory: input.operationDirectory,
      metadata,
      hooks: {
        afterOperationDirectoryValidated({ phase }) {
          if (phase === "seal" && !substituted) {
            substituted = true;
            fs.renameSync(input.operationDirectory, moved);
            fs.mkdirSync(input.operationDirectory, { mode: 0o700 });
            writePrivate(path.join(input.operationDirectory, "preserve"), "replacement\n");
          }
        }
      }
    }));
    assert.equal(fs.readFileSync(path.join(input.operationDirectory, "preserve"), "utf8"),
      "replacement\n");
    assert.equal(fs.existsSync(path.join(moved, "intent.json")), false);
  } finally {
    cleanup(input.parent);
  }
});

test("existing intent and barrier outputs are never overwritten or removed", () => {
  const intent = fixture({ seal: false });
  try {
    writePrivate(path.join(intent.operationDirectory, "intent.json"), "preserve-intent\n");
    assert.throws(() => sealProcessLocalRotationOperation({
      operationDirectory: intent.operationDirectory, metadata
    }));
    assert.equal(fs.readFileSync(path.join(intent.operationDirectory, "intent.json"), "utf8"),
      "preserve-intent\n");
  } finally {
    cleanup(intent.parent);
  }

  const sidecar = fixture();
  try {
    writePrivate(path.join(sidecar.operationDirectory, "barrier-binding.json"),
      "preserve-barrier\n");
    assert.throws(() => writeProcessLocalBarrierBinding({
      operationDirectory: sidecar.operationDirectory, barrier
    }));
    assert.equal(
      fs.readFileSync(path.join(sidecar.operationDirectory, "barrier-binding.json"), "utf8"),
      "preserve-barrier\n"
    );
  } finally {
    cleanup(sidecar.parent);
  }
});

test("partial init removes only its own complete inodes", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-partial-"));
  fs.chmodSync(parent, 0o700);
  const operationDirectory = path.join(parent, "operation");
  try {
    assert.throws(() => initProcessLocalRotationOperation({
      parentDirectory: parent,
      operationDirectory,
      rotationRevision: REVISION,
      randomBytes: deterministicRandom(),
      hooks: {
        afterOwnedFileFsync({ name }) {
          if (name === "identity.json") throw new Error("fixture interruption");
        }
      }
    }));
    assert.equal(fs.existsSync(operationDirectory), false);

    let substituted = false;
    let substitutedPath;
    assert.throws(() => initProcessLocalRotationOperation({
      parentDirectory: parent,
      operationDirectory,
      rotationRevision: REVISION,
      randomBytes: deterministicRandom(),
      hooks: {
        afterOwnedFileCreated({ name, path: pendingPath }) {
          if (name === "operation.key" && !substituted) {
            substituted = true;
            substitutedPath = pendingPath;
            fs.renameSync(
              pendingPath,
              path.join(operationDirectory, "owned-key-moved")
            );
            writePrivate(pendingPath, "unknown-replacement\n");
          }
        }
      }
    }));
    assert.equal(fs.readFileSync(substitutedPath, "utf8"),
      "unknown-replacement\n");
  } finally {
    cleanup(parent);
  }
});

test("noncanonical revision JSON and metadata mismatch fail verification", () => {
  const revision = fixture({ seal: false });
  try {
    fs.writeFileSync(
      path.join(revision.operationDirectory, "revision.json"),
      `{\n  "rotationRevision": "${REVISION}"\n}\n`,
      { mode: 0o600 }
    );
    assert.throws(() => sealProcessLocalRotationOperation({
      operationDirectory: revision.operationDirectory, metadata
    }));
  } finally {
    cleanup(revision.parent);
  }

  const mismatch = fixture();
  try {
    assert.throws(() => verifyProcessLocalRotationOperation({
      operationDirectory: mismatch.operationDirectory,
      metadata: { ...metadata, namespaceUid: "different-namespace-uid" }
    }));
  } finally {
    cleanup(mismatch.parent);
  }
});

for (const target of ["identity", "intent", "old-snapshot", "operation.key"]) {
  test(`tamper of ${target} fails closed`, () => {
    const input = fixture();
    try {
      if (target === "identity") {
        const filePath = path.join(input.operationDirectory, "identity.json");
        const value = readJson(filePath);
        value.operationId = "a".repeat(32);
        rewriteCanonical(filePath, value);
      } else if (target === "intent") {
        const filePath = path.join(input.operationDirectory, "intent.json");
        const value = readJson(filePath);
        value.namespaceUid = "tampered-namespace-uid";
        rewriteCanonical(filePath, value);
      } else if (target === "old-snapshot") {
        fs.writeFileSync(
          path.join(input.operationDirectory, "old-snapshot.json"),
          '{"DB_PASS":"tampered-secret-never-print"}\n',
          { mode: 0o600 }
        );
      } else {
        fs.writeFileSync(
          path.join(input.operationDirectory, "operation.key"),
          Buffer.alloc(32, 9),
          { mode: 0o600 }
        );
      }
      assert.throws(() => verifyProcessLocalRotationOperation({
        operationDirectory: input.operationDirectory
      }));
    } finally {
      cleanup(input.parent);
    }
  });
}

test("barrier rejects unsafe resource versions and exact lock mismatches", () => {
  const input = fixture();
  try {
    for (const policyResourceVersion of ["", "with whitespace", "x".repeat(257)]) {
      assert.throws(() => writeProcessLocalBarrierBinding({
        operationDirectory: input.operationDirectory,
        barrier: { ...barrier, policyResourceVersion }
      }));
    }
    assert.equal(fs.existsSync(path.join(input.operationDirectory, "barrier-binding.json")),
      false);
    writeProcessLocalBarrierBinding({ operationDirectory: input.operationDirectory, barrier });
    assert.throws(() => verifyProcessLocalBarrierBinding({
      operationDirectory: input.operationDirectory,
      barrier: { ...barrier, lockUid: "different-lock-uid" }
    }));
  } finally {
    cleanup(input.parent);
  }
});

test("barrier tamper and a validly re-HMACed wrong operation remain rejected", () => {
  const tampered = fixture({ bind: true });
  try {
    const filePath = path.join(tampered.operationDirectory, "barrier-binding.json");
    const value = readJson(filePath);
    value.policyResourceVersion = "7393";
    rewriteCanonical(filePath, value);
    assert.throws(() => verifyProcessLocalBarrierBinding({
      operationDirectory: tampered.operationDirectory
    }));
  } finally {
    cleanup(tampered.parent);
  }

  const operation = fixture({ bind: true });
  try {
    const filePath = path.join(operation.operationDirectory, "barrier-binding.json");
    const value = readJson(filePath);
    value.operationId = "f".repeat(32);
    const body = structuredClone(value);
    delete body.hmacSha256;
    value.hmacSha256 = createHmac(
      "sha256", fs.readFileSync(path.join(operation.operationDirectory, "operation.key"))
    ).update(canonicalOperationJson(body)).digest("hex");
    rewriteCanonical(filePath, value);
    assert.throws(() => verifyProcessLocalBarrierBinding({
      operationDirectory: operation.operationDirectory
    }));
  } finally {
    cleanup(operation.parent);
  }
});

test("terminal tamper and expected completion bindings fail closed", () => {
  const input = fixture({ bind: true });
  try {
    assert.throws(() => writeProcessLocalTerminalRecord({
      operationDirectory: input.operationDirectory,
      terminal: { ...terminal, previousLockUid: "lock uid with spaces" }
    }));
    writeProcessLocalTerminalRecord({ operationDirectory: input.operationDirectory, terminal });
    assert.throws(() => verifyProcessLocalTerminalRecord({
      operationDirectory: input.operationDirectory,
      terminal: { ...terminal, reportSha256: "a".repeat(64) }
    }));
    const filePath = path.join(input.operationDirectory, "terminal.json");
    const value = readJson(filePath);
    value.completed = false;
    rewriteCanonical(filePath, value);
    assert.throws(() => verifyProcessLocalTerminalRecord({
      operationDirectory: input.operationDirectory,
      terminal
    }));
  } finally {
    cleanup(input.parent);
  }
});

test("terminal cannot be written without the authenticated barrier chain", () => {
  const input = fixture();
  try {
    assert.throws(() => writeProcessLocalTerminalRecord({
      operationDirectory: input.operationDirectory,
      terminal
    }));
    assert.equal(fs.existsSync(path.join(input.operationDirectory, "terminal.json")), false);
  } finally {
    cleanup(input.parent);
  }
});

test("baseline emitter exposes only authenticated CAS and image capabilities", () => {
  const input = fixture();
  try {
    const capture = options => {
      let value;
      assert.equal(emitVerifiedProcessLocalBaselineCapability({
        operationDirectory: input.operationDirectory,
        ...options,
        write(bytes) { value = Buffer.from(bytes); }
      }), true);
      return value.toString("utf8");
    };
    assert.equal(capture({ mode: "pgsql-image" }), `${PGSQL_IMAGE}\n`);
    assert.equal(
      capture({ mode: "pgsql-policy-binding" }),
      "pgsql-ingress-policy-uid\t7392\n"
    );
    const baselineDeployment = operationBaseline().items.find(item =>
      item.kind === "Deployment" && item.metadata.name === "reticulum"
    );
    const fingerprint = Buffer.from(canonicalOperationJson({
      selector: baselineDeployment.spec.selector,
      strategy: baselineDeployment.spec.strategy,
      template: baselineDeployment.spec.template
    }), "utf8").toString("base64");
    assert.equal(
      capture({ mode: "deployment-contract", name: "reticulum" }),
      ["deployment-uid-reticulum", "106", "1", "reticulum", fingerprint]
        .join("\t") + "\n"
    );

    let called = false;
    assert.throws(() => emitVerifiedProcessLocalBaselineCapability({
      operationDirectory: input.operationDirectory,
      mode: "deployment-contract",
      name: "foreign",
      write() { called = true; }
    }));
    assert.equal(called, false);

    const cli = spawnSync(process.execPath, [
      CLI, "emit-baseline",
      "--operation-directory", input.operationDirectory,
      "--mode", "pgsql-policy-binding",
      ...cliContinuityArgs(input.operationDirectory)
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, "pgsql-ingress-policy-uid\t7392\n");
    assert.equal(cli.stderr, "");
  } finally {
    cleanup(input.parent);
  }
});

test("runtime emitter returns only authenticated identifiers and credential capabilities", () => {
  const input = fixture();
  try {
    const expected = new Map([
      ["db-identifiers", "ret\tret\n"],
      ["db-password-pair", "old-secret-never-print\nnew-secret-never-print\n"],
      ["old-password", "old-secret-never-print\n"],
      ["new-password", "new-secret-never-print\n"]
    ]);
    for (const [mode, value] of expected) {
      let captured;
      assert.equal(emitVerifiedProcessLocalRuntime({
        operationDirectory: input.operationDirectory,
        mode,
        write(bytes) {
          captured = Buffer.from(bytes);
        }
      }), true);
      assert.equal(captured.toString("utf8"), value);
      captured.fill(0);
    }
  } finally {
    cleanup(input.parent);
  }
});

test("runtime emitter fails before calling its writer when a bound snapshot changes", () => {
  const input = fixture();
  try {
    fs.writeFileSync(
      path.join(input.operationDirectory, "new-snapshot.json"),
      `${canonicalOperationJson({
        DB_NAME: "ret",
        DB_PASS: "tampered-secret-never-print",
        DB_USER: "ret"
      })}\n`,
      { mode: 0o600 }
    );
    let called = false;
    assert.throws(() => emitVerifiedProcessLocalRuntime({
      operationDirectory: input.operationDirectory,
      mode: "new-password",
      write() { called = true; }
    }));
    assert.equal(called, false);
  } finally {
    cleanup(input.parent);
  }
});

test("CLI emit-runtime writes exact capabilities and fails closed before stdout", () => {
  const input = fixture();
  try {
    const emitted = spawnSync(process.execPath, [
      CLI, "emit-runtime",
      "--operation-directory", input.operationDirectory,
      "--mode", "db-identifiers",
      ...cliContinuityArgs(input.operationDirectory)
    ], { encoding: "utf8" });
    assert.equal(emitted.status, 0, emitted.stderr);
    assert.equal(emitted.stdout, "ret\tret\n");
    assert.equal(emitted.stderr, "");

    const rejected = spawnSync(process.execPath, [
      CLI, "emit-runtime",
      "--operation-directory", input.operationDirectory,
      "--mode", "untrusted-mode",
      ...cliContinuityArgs(input.operationDirectory)
    ], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr, "process-local rotation operation failed closed\n");
  } finally {
    cleanup(input.parent);
  }
});

test("CLI continuity rejects wrong operations before stdout or barrier publication", () => {
  const input = fixture();
  try {
    const intent = readJson(path.join(input.operationDirectory, "intent.json"));
    const wrongId = `${intent.operationId[0] === "a" ? "b" : "a"}${
      intent.operationId.slice(1)}`;
    const wrongBinding = `${
      intent.operationBindingSha256[0] === "a" ? "b" : "a"
    }${intent.operationBindingSha256.slice(1)}`;
    const rejectedCommands = [
      [
        "verify",
        "--operation-directory", input.operationDirectory,
        "--expected-operation-id", wrongId,
        "--expected-operation-binding-sha256", intent.operationBindingSha256
      ],
      [
        "emit-runtime",
        "--operation-directory", input.operationDirectory,
        "--mode", "new-password",
        "--expected-operation-id", wrongId,
        "--expected-operation-binding-sha256", intent.operationBindingSha256
      ],
      [
        "emit-baseline",
        "--operation-directory", input.operationDirectory,
        "--mode", "pgsql-image",
        "--expected-operation-id", intent.operationId,
        "--expected-operation-binding-sha256", wrongBinding
      ],
      [
        "bind-barrier",
        "--operation-directory", input.operationDirectory,
        "--expected-operation-id", wrongId,
        "--expected-operation-binding-sha256", intent.operationBindingSha256,
        ...cliBarrierArgs()
      ],
      [
        "verify-barrier",
        "--operation-directory", input.operationDirectory
      ]
    ];
    for (const args of rejectedCommands) {
      const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      assert.equal(result.status, 1, args[0]);
      assert.equal(result.stdout, "", args[0]);
      assert.equal(
        result.stderr,
        "process-local rotation operation failed closed\n",
        args[0]
      );
    }
    assert.equal(
      fs.existsSync(path.join(input.operationDirectory, "barrier-binding.json")),
      false
    );
  } finally {
    cleanup(input.parent);
  }
});

test("CLI init, seal, verify, bind-barrier and verify-barrier are silent on success", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-cli-"));
  fs.chmodSync(parent, 0o700);
  const operationDirectory = path.join(parent, "operation");
  try {
    const init = spawnSync(process.execPath, [
      CLI, "init",
      "--parent-directory", parent,
      "--operation-directory", operationDirectory,
      "--rotation-revision", REVISION
    ], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    assert.equal(init.stdout, "");
    assert.equal(init.stderr, "");
    writePrivate(path.join(operationDirectory, "original-baseline.json"), '{"items":[]}\n');
    writePrivate(path.join(operationDirectory, "old-snapshot.json"), '{"old":"secret"}\n');
    writePrivate(path.join(operationDirectory, "new-snapshot.json"), '{"new":"secret"}\n');
    writePrivate(path.join(operationDirectory, "old-values-source.yaml"), "SOURCE: old\n");
    writePrivate(path.join(operationDirectory, "new-values-source.yaml"), "SOURCE: new\n");
    const seal = spawnSync(process.execPath, [
      CLI,
      "seal",
      "--operation-directory", operationDirectory,
      ...cliMetadataArgs()
    ], { encoding: "utf8" });
    assert.equal(seal.status, 0, seal.stderr);
    assert.equal(seal.stdout, "");
    assert.equal(seal.stderr, "");
    const continuity = cliContinuityArgs(operationDirectory);
    const commands = [
      [
        "verify", "--operation-directory", operationDirectory,
        ...continuity, ...cliMetadataArgs()
      ],
      [
        "bind-barrier", "--operation-directory", operationDirectory,
        ...continuity, ...cliBarrierArgs()
      ],
      [
        "verify-barrier", "--operation-directory", operationDirectory,
        ...continuity, ...cliBarrierArgs()
      ]
    ];
    for (const args of commands) {
      const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  } finally {
    cleanup(parent);
  }
});

test("CLI failures have one generic value-free stderr and no stdout", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-cli-fail-"));
  fs.chmodSync(parent, 0o700);
  const operationDirectory = path.join(parent, "operation");
  try {
    const invalidRevision = "INVALID-secret-looking-revision";
    const result = spawnSync(process.execPath, [
      CLI, "init",
      "--parent-directory", parent,
      "--operation-directory", operationDirectory,
      "--rotation-revision", invalidRevision
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "process-local rotation operation failed closed\n");
    assert.equal(result.stderr.includes(invalidRevision), false);

    const sealed = fixture();
    try {
      const rawTerminal = spawnSync(process.execPath, [
        CLI,
        "write-terminal",
        "--operation-directory", sealed.operationDirectory,
        "--verified-baseline-sha256", terminal.verifiedBaselineSha256,
        "--released-baseline-sha256", terminal.releasedBaselineSha256,
        "--report-sha256", terminal.reportSha256,
        "--previous-lock-uid", terminal.previousLockUid
      ], { encoding: "utf8" });
      assert.equal(rawTerminal.status, 1);
      assert.equal(rawTerminal.stdout, "");
      assert.equal(
        rawTerminal.stderr,
        "process-local rotation operation failed closed\n"
      );

      const secret = "snapshot-secret-that-must-never-be-diagnostic";
      fs.writeFileSync(
        path.join(sealed.operationDirectory, "new-snapshot.json"),
        `${secret}\n`,
        { mode: 0o600 }
      );
      const verify = spawnSync(process.execPath, [
        CLI, "verify", "--operation-directory", sealed.operationDirectory
      ], { encoding: "utf8" });
      assert.equal(verify.status, 1);
      assert.equal(verify.stdout, "");
      assert.equal(verify.stderr, "process-local rotation operation failed closed\n");
      assert.equal(verify.stderr.includes(secret), false);
      assert.equal(verify.stderr.includes(metadata.checkpointDumpSha256), false);
    } finally {
      cleanup(sealed.parent);
    }
  } finally {
    cleanup(parent);
  }
});

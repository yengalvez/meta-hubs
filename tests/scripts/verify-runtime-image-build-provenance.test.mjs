#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RuntimeImageBuildProvenanceError,
  RUNTIME_IMAGE_BUILD_REPOSITORIES,
  RUNTIME_IMAGE_BUILD_REPOSITORY,
  RUNTIME_IMAGE_BUILD_REPOSITORY_ID,
  RUNTIME_IMAGE_BUILD_SIGNER_WORKFLOW,
  RUNTIME_IMAGE_BUILD_SOURCE_REF,
  RUNTIME_IMAGE_BUILD_WORKFLOW_PATH,
  canonicalRuntimeImageBuildReceiptJson,
  inspectRuntimeImageBuildProvenanceArtifacts,
  resolveRuntimeImageBuildSourceCommit,
  runGhAttestationVerification,
  withRuntimeImageBuildProvenanceArtifactSnapshot,
  verifyRuntimeImageBuildProvenance
} from "../../deployment/verify-runtime-image-build-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "deployment/verify-runtime-image-build-provenance.mjs");
const COMMIT = "a".repeat(40);
const RUN_ID = "31234567890";
const RUN_ATTEMPT = "2";
const RECEIPT_NAME = "runtime-image-build-receipt-v1.json";
const IMAGES = Object.freeze({
  botOrchestrator:
    `${RUNTIME_IMAGE_BUILD_REPOSITORIES.botOrchestrator}@sha256:${"b".repeat(64)}`,
  botRunner: `${RUNTIME_IMAGE_BUILD_REPOSITORIES.botRunner}@sha256:${"c".repeat(64)}`,
  reticulum: `${RUNTIME_IMAGE_BUILD_REPOSITORIES.reticulum}@sha256:${"d".repeat(64)}`
});

function receiptValue(overrides = {}) {
  return {
    images: { ...IMAGES, ...(overrides.images || {}) },
    repository: RUNTIME_IMAGE_BUILD_REPOSITORY,
    repositoryId: RUNTIME_IMAGE_BUILD_REPOSITORY_ID,
    runAttempt: RUN_ATTEMPT,
    runId: RUN_ID,
    schemaVersion: 1,
    sourceCommit: COMMIT,
    sourceRef: RUNTIME_IMAGE_BUILD_SOURCE_REF,
    workflowPath: RUNTIME_IMAGE_BUILD_WORKFLOW_PATH,
    workflowSha: COMMIT,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "images"))
  };
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalRuntimeImageBuildReceiptJson(value)}\n`, "utf8");
}

function bundleBytes(role) {
  return Buffer.from(JSON.stringify({ mediaType: "fixture/sigstore-bundle", role }), "utf8");
}

function fixture({
  receipt = receiptValue(),
  receiptBytes,
  receiptBundleBytes,
  botOrchestratorBundleBytes,
  botRunnerBundleBytes,
  reticulumBundleBytes
} = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runtime-provenance-"));
  const receiptPath = path.join(root, RECEIPT_NAME);
  const receiptBundlePath = path.join(root, "receipt.sigstore.json");
  const botOrchestratorBundlePath = path.join(root, "bot-orchestrator.sigstore.json");
  const botRunnerBundlePath = path.join(root, "bot-runner.sigstore.json");
  const reticulumBundlePath = path.join(root, "reticulum.sigstore.json");
  fs.writeFileSync(receiptPath, receiptBytes || canonicalBytes(receipt), { flag: "wx" });
  const bundles = [
    [receiptBundlePath, receiptBundleBytes || bundleBytes("receipt")],
    [botOrchestratorBundlePath,
      botOrchestratorBundleBytes || bundleBytes("botOrchestrator")],
    [botRunnerBundlePath, botRunnerBundleBytes || bundleBytes("botRunner")],
    [reticulumBundlePath, reticulumBundleBytes || bundleBytes("reticulum")]
  ];
  for (const [bundlePath, bytes] of bundles) {
    fs.writeFileSync(bundlePath, bytes, { flag: "wx" });
  }
  return {
    root,
    receipt,
    receiptPath,
    receiptBundlePath,
    botOrchestratorBundlePath,
    botRunnerBundlePath,
    reticulumBundlePath
  };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function fixtureGit(repositoryRoot, args) {
  const executable = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
    .find(candidate => fs.existsSync(candidate));
  assert.ok(executable, "git fixture executable missing");
  const result = spawnSync(executable, ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null"
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function integratedRepositoryFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runtime-gitlink-"));
  const cloudRoot = path.join(root, "hubs-cloud");
  fs.mkdirSync(cloudRoot);
  fixtureGit(root, ["init", "--initial-branch=main", "."]);
  fixtureGit(root, ["config", "user.name", "Runtime Test"]);
  fixtureGit(root, ["config", "user.email", "runtime-test@example.invalid"]);
  fixtureGit(cloudRoot, ["init", "--initial-branch=master", "."]);
  fixtureGit(cloudRoot, ["config", "user.name", "Runtime Test"]);
  fixtureGit(cloudRoot, ["config", "user.email", "runtime-test@example.invalid"]);
  fs.writeFileSync(path.join(cloudRoot, "tracked.txt"), "cloud\n", { flag: "wx" });
  fixtureGit(cloudRoot, ["add", "--", "tracked.txt"]);
  fixtureGit(cloudRoot, ["commit", "--quiet", "-m", "cloud fixture"]);
  const cloudCommit = fixtureGit(cloudRoot, ["rev-parse", "HEAD"]).trim();
  fixtureGit(cloudRoot, ["update-ref", "refs/remotes/origin/master", cloudCommit]);
  fixtureGit(cloudRoot, ["checkout", "--quiet", "--detach", cloudCommit]);
  fixtureGit(root, [
    "update-index", "--add", "--cacheinfo",
    `160000,${cloudCommit},hubs-cloud`
  ]);
  fixtureGit(root, ["commit", "--quiet", "-m", "root fixture"]);
  const rootCommit = fixtureGit(root, ["rev-parse", "HEAD"]).trim();
  fixtureGit(root, ["update-ref", "refs/remotes/origin/main", rootCommit]);
  return { root, cloudRoot, cloudCommit };
}

function dockerConfigDirectory(input, mode = 0o700) {
  const directory = path.join(input.root, "docker-config");
  fs.mkdirSync(directory, { mode });
  fs.chmodSync(directory, mode);
  fs.writeFileSync(path.join(directory, "config.json"), "{}\n", {
    mode: 0o600,
    flag: "wx"
  });
  return directory;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function invocation(receipt = receiptValue()) {
  return `https://github.com/${RUNTIME_IMAGE_BUILD_REPOSITORY}/actions/runs/${
    receipt.runId
  }/attempts/${receipt.runAttempt}`;
}

function signerUri() {
  return `https://github.com/${RUNTIME_IMAGE_BUILD_SIGNER_WORKFLOW}@${
    RUNTIME_IMAGE_BUILD_SOURCE_REF
  }`;
}

function verification({
  receipt,
  subjectName,
  subjectDigest,
  invocationId = invocation(receipt),
  mutate
}) {
  const repositoryUri = `https://github.com/${RUNTIME_IMAGE_BUILD_REPOSITORY}`;
  const signer = signerUri();
  const entry = {
    attestation: { fixture: true },
    verificationResult: {
      signature: {
        certificate: {
          buildConfigDigest: receipt.sourceCommit,
          buildConfigURI: signer,
          buildSignerDigest: receipt.sourceCommit,
          buildSignerURI: signer,
          buildTrigger: "workflow_dispatch",
          githubWorkflowRef: RUNTIME_IMAGE_BUILD_SOURCE_REF,
          githubWorkflowRepository: RUNTIME_IMAGE_BUILD_REPOSITORY,
          githubWorkflowSHA: receipt.sourceCommit,
          githubWorkflowTrigger: "workflow_dispatch",
          issuer: "https://token.actions.githubusercontent.com",
          runInvocationURI: invocationId,
          runnerEnvironment: "github-hosted",
          sourceRepositoryDigest: receipt.sourceCommit,
          sourceRepositoryIdentifier: RUNTIME_IMAGE_BUILD_REPOSITORY_ID,
          sourceRepositoryRef: RUNTIME_IMAGE_BUILD_SOURCE_REF,
          sourceRepositoryURI: repositoryUri,
          subjectAlternativeName: signer
        }
      },
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{ name: subjectName, digest: { sha256: subjectDigest } }],
        predicate: {
          buildDefinition: {
            buildType: "https://actions.github.io/buildtypes/workflow/v1",
            externalParameters: {
              workflow: {
                path: RUNTIME_IMAGE_BUILD_WORKFLOW_PATH,
                ref: RUNTIME_IMAGE_BUILD_SOURCE_REF,
                repository: repositoryUri
              }
            },
            internalParameters: {
              github: {
                event_name: "workflow_dispatch",
                repository_id: RUNTIME_IMAGE_BUILD_REPOSITORY_ID,
                runner_environment: "github-hosted"
              }
            },
            resolvedDependencies: [{
              uri: `git+${repositoryUri}@${RUNTIME_IMAGE_BUILD_SOURCE_REF}`,
              digest: { gitCommit: receipt.sourceCommit }
            }]
          },
          runDetails: {
            builder: { id: signer },
            metadata: { invocationId }
          }
        }
      }
    }
  };
  if (mutate) mutate(entry);
  return entry;
}

function subjectForInvocation(call, input, initialReceiptBytes) {
  const rawSubject = call.args[2];
  if (!rawSubject.startsWith("oci://")) {
    return {
      name: path.basename(input.receiptPath),
      digest: digest(initialReceiptBytes)
    };
  }
  const image = rawSubject.slice("oci://".length);
  const marker = image.lastIndexOf("@sha256:");
  return {
    name: image.slice(0, marker),
    digest: image.slice(marker + "@sha256:".length)
  };
}

function successfulRunner(input, {
  mutateEntry,
  entriesForCall,
  afterCall
} = {}) {
  const calls = [];
  const initialReceiptBytes = fs.readFileSync(input.receiptPath);
  const runner = call => {
    const index = calls.length;
    calls.push({
      executable: call.executable,
      args: [...call.args],
      env: { ...call.env }
    });
    const subject = subjectForInvocation(call, input, initialReceiptBytes);
    let entries = [verification({
      receipt: input.receipt,
      subjectName: subject.name,
      subjectDigest: subject.digest,
      mutate: entry => mutateEntry?.(entry, index, call)
    })];
    if (entriesForCall) entries = entriesForCall(entries, index, call, subject);
    const stdout = Buffer.from(JSON.stringify(entries), "utf8");
    afterCall?.(index, call);
    return {
      status: 0,
      signal: null,
      stdout,
      stderr: Buffer.alloc(0)
    };
  };
  return { runner, calls };
}

function options(input, runner, extra = {}) {
  return {
    receiptPath: input.receiptPath,
    receiptBundlePath: input.receiptBundlePath,
    botOrchestratorBundlePath: input.botOrchestratorBundlePath,
    botRunnerBundlePath: input.botRunnerBundlePath,
    reticulumBundlePath: input.reticulumBundlePath,
    expectedSourceCommit: COMMIT,
    runner,
    ghExecutable: "/fixture/gh",
    ...extra
  };
}

function expectCode(factory, code) {
  let captured;
  assert.throws(factory, error => {
    captured = error;
    return error instanceof RuntimeImageBuildProvenanceError;
  });
  assert.equal(captured.code, code);
}

test("production source trust comes only from an integrated clean root gitlink", async t => {
  await t.test("accepts clean root main and detached Cloud at the pinned commit", () => {
    const repository = integratedRepositoryFixture();
    try {
      assert.equal(
        resolveRuntimeImageBuildSourceCommit(repository.root),
        repository.cloudCommit
      );
    } finally {
      cleanup(repository.root);
    }
  });

  await t.test("rejects root worktree drift", () => {
    const repository = integratedRepositoryFixture();
    fs.writeFileSync(path.join(repository.root, "untracked.txt"), "drift\n", { flag: "wx" });
    try {
      expectCode(
        () => resolveRuntimeImageBuildSourceCommit(repository.root),
        "source_commit_resolution_failed"
      );
    } finally {
      cleanup(repository.root);
    }
  });

  await t.test("rejects a Cloud gitlink outside origin master ancestry", () => {
    const repository = integratedRepositoryFixture();
    const tree = fixtureGit(repository.cloudRoot, ["rev-parse", "HEAD^{tree}"]).trim();
    const unrelated = fixtureGit(repository.cloudRoot, [
      "commit-tree", tree, "-m", "unrelated remote fixture"
    ]).trim();
    fixtureGit(repository.cloudRoot, [
      "update-ref", "refs/remotes/origin/master", unrelated
    ]);
    try {
      expectCode(
        () => resolveRuntimeImageBuildSourceCommit(repository.root),
        "source_commit_resolution_failed"
      );
    } finally {
      cleanup(repository.root);
    }
  });

  await t.test("real runner forbids caller-provided commit overrides", () => {
    const input = fixture();
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(
        options(input, runGhAttestationVerification)
      ), "expected_source_commit_override_forbidden");
    } finally {
      cleanup(input.root);
    }
  });
});

test("local artifact inspection validates the complete physical set without invoking gh", () => {
  const input = fixture();
  try {
    assert.equal(inspectRuntimeImageBuildProvenanceArtifacts({
      receiptPath: input.receiptPath,
      receiptBundlePath: input.receiptBundlePath,
      botOrchestratorBundlePath: input.botOrchestratorBundlePath,
      botRunnerBundlePath: input.botRunnerBundlePath,
      reticulumBundlePath: input.reticulumBundlePath,
      expectedSourceCommit: COMMIT
    }), true);
  } finally {
    cleanup(input.root);
  }
});

test("private artifact snapshot is the verifier's sole bound input and is cleaned", async () => {
  const input = fixture();
  let snapshotDirectory;
  let snapshotReceiptPath;
  try {
    await assert.rejects(
      withRuntimeImageBuildProvenanceArtifactSnapshot({
        receiptPath: input.receiptPath,
        receiptBundlePath: input.receiptBundlePath,
        botOrchestratorBundlePath: input.botOrchestratorBundlePath,
        botRunnerBundlePath: input.botRunnerBundlePath,
        reticulumBundlePath: input.reticulumBundlePath,
        privateParentDirectory: input.root,
        expectedSourceCommit: COMMIT,
        callback(snapshot) {
          snapshotDirectory = snapshot.privateWorkDirectory;
          snapshotReceiptPath = snapshot.artifactPaths.receiptPath;
          assert.notEqual(snapshotReceiptPath, input.receiptPath);
          assert.equal(path.basename(snapshotReceiptPath), path.basename(input.receiptPath));
          assert.equal(fs.lstatSync(snapshotDirectory).mode & 0o7777, 0o700);
          for (const artifactPath of Object.values(snapshot.artifactPaths)) {
            assert.equal(fs.lstatSync(artifactPath).mode & 0o7777, 0o600);
          }

          const fake = successfulRunner(input);
          const verified = verifyRuntimeImageBuildProvenance(options(
            input,
            fake.runner,
            {
              ...snapshot.artifactPaths,
              artifactBindings: snapshot.artifactBindings
            }
          ));
          assert.deepEqual(verified.images, IMAGES);
          assert.equal(fake.calls.length, 4);
          assert.equal(fake.calls[0].args[2], snapshotReceiptPath);

          const moved = `${snapshotReceiptPath}.bound`;
          fs.renameSync(snapshotReceiptPath, moved);
          fs.copyFileSync(input.receiptPath, snapshotReceiptPath);
          const swapped = successfulRunner(input);
          try {
            expectCode(() => verifyRuntimeImageBuildProvenance(options(
              input,
              swapped.runner,
              {
                ...snapshot.artifactPaths,
                artifactBindings: snapshot.artifactBindings
              }
            )), "artifact_binding_mismatch");
            assert.equal(swapped.calls.length, 0);
          } finally {
            fs.unlinkSync(snapshotReceiptPath);
            fs.renameSync(moved, snapshotReceiptPath);
          }
          return "snapshot-ok";
        }
      }),
      error => error?.code === "artifact_snapshot_changed"
    );
    assert.equal(fs.existsSync(snapshotDirectory), false);
    assert.equal(fs.existsSync(snapshotReceiptPath), false);
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

test("partial snapshot setup failures leave no private directory or artifact", async t => {
  await t.test("directory open fails after mkdir", async () => {
    const input = fixture();
    const originalOpen = fs.openSync;
    let injected = false;
    try {
      fs.openSync = function (target, flags, ...rest) {
        if (!injected && typeof target === "string" &&
            path.basename(target).startsWith(".yenhubs-runtime-provenance-") &&
            (flags & fs.constants.O_DIRECTORY) !== 0) {
          injected = true;
          const error = new Error("injected snapshot directory open failure");
          error.code = "EACCES";
          throw error;
        }
        return originalOpen.call(this, target, flags, ...rest);
      };
      await assert.rejects(
        withRuntimeImageBuildProvenanceArtifactSnapshot({
          receiptPath: input.receiptPath,
          receiptBundlePath: input.receiptBundlePath,
          botOrchestratorBundlePath: input.botOrchestratorBundlePath,
          botRunnerBundlePath: input.botRunnerBundlePath,
          reticulumBundlePath: input.reticulumBundlePath,
          privateParentDirectory: input.root,
          expectedSourceCommit: COMMIT,
          callback() {
            assert.fail("callback must not run");
          }
        }),
        error => error?.code === "artifact_snapshot_directory_invalid"
      );
      assert.equal(injected, true);
      assert.deepEqual(
        fs.readdirSync(input.root).filter(name =>
          name.startsWith(".yenhubs-runtime-provenance-")
        ),
        []
      );
    } finally {
      fs.openSync = originalOpen;
      cleanup(input.root);
    }
  });

  await t.test("file chmod fails immediately after O_EXCL", async () => {
    const input = fixture();
    const originalFchmod = fs.fchmodSync;
    let injected = false;
    try {
      fs.fchmodSync = function (descriptor, mode) {
        if (!injected && mode === 0o600) {
          injected = true;
          const error = new Error("injected snapshot file chmod failure");
          error.code = "EIO";
          throw error;
        }
        return originalFchmod.call(this, descriptor, mode);
      };
      await assert.rejects(
        withRuntimeImageBuildProvenanceArtifactSnapshot({
          receiptPath: input.receiptPath,
          receiptBundlePath: input.receiptBundlePath,
          botOrchestratorBundlePath: input.botOrchestratorBundlePath,
          botRunnerBundlePath: input.botRunnerBundlePath,
          reticulumBundlePath: input.reticulumBundlePath,
          privateParentDirectory: input.root,
          expectedSourceCommit: COMMIT,
          callback() {
            assert.fail("callback must not run");
          }
        }),
        error => error?.code === "artifact_snapshot_write_failed"
      );
      assert.equal(injected, true);
      assert.deepEqual(
        fs.readdirSync(input.root).filter(name =>
          name.startsWith(".yenhubs-runtime-provenance-")
        ),
        []
      );
    } finally {
      fs.fchmodSync = originalFchmod;
      cleanup(input.root);
    }
  });
});

test("snapshot cleanup never unlinks a substituted foreign leaf", async () => {
  const input = fixture();
  let foreignPath;
  let displacedPath;
  let originalBytes;
  const foreignBytes = Buffer.from("foreign-file-must-survive", "utf8");
  try {
    await assert.rejects(
      withRuntimeImageBuildProvenanceArtifactSnapshot({
        receiptPath: input.receiptPath,
        receiptBundlePath: input.receiptBundlePath,
        botOrchestratorBundlePath: input.botOrchestratorBundlePath,
        botRunnerBundlePath: input.botRunnerBundlePath,
        reticulumBundlePath: input.reticulumBundlePath,
        privateParentDirectory: input.root,
        expectedSourceCommit: COMMIT,
        callback(snapshot) {
          foreignPath = snapshot.artifactPaths.receiptPath;
          displacedPath = `${foreignPath}.displaced`;
          originalBytes = fs.readFileSync(foreignPath);
          fs.renameSync(foreignPath, displacedPath);
          fs.writeFileSync(foreignPath, foreignBytes, { flag: "wx", mode: 0o600 });
        }
      }),
      error => error?.code === "artifact_snapshot_cleanup_failed"
    );
    assert.deepEqual(fs.readFileSync(foreignPath), foreignBytes);
    assert.deepEqual(fs.readFileSync(displacedPath), originalBytes);
  } finally {
    if (originalBytes) originalBytes.fill(0);
    foreignBytes.fill(0);
    cleanup(input.root);
  }
});

test("accepts one canonical receipt and four attestations from the exact same run", () => {
  const input = fixture();
  const dockerConfig = dockerConfigDirectory(input);
  const fake = successfulRunner(input);
  try {
    const result = verifyRuntimeImageBuildProvenance(options(input, fake.runner, {
      dockerConfigDirectory: dockerConfig
    }));
    assert.equal(result.sourceCommit, COMMIT);
    assert.equal(result.invocationId, invocation(input.receipt));
    assert.deepEqual(result.images, IMAGES);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.images), true);
    assert.equal(fake.calls.length, 4);
    assert.equal(fake.calls[0].args[2], input.receiptPath);
    assert.deepEqual(
      fake.calls.slice(1).map(call => call.args[2]).sort(),
      Object.values(IMAGES).map(image => `oci://${image}`).sort()
    );
    const expectedBundleBySubject = new Map([
      [input.receiptPath, input.receiptBundlePath],
      [`oci://${IMAGES.botOrchestrator}`, input.botOrchestratorBundlePath],
      [`oci://${IMAGES.botRunner}`, input.botRunnerBundlePath],
      [`oci://${IMAGES.reticulum}`, input.reticulumBundlePath]
    ]);
    for (const call of fake.calls) {
      assert.equal(call.args.includes("--deny-self-hosted-runners"), true);
      assert.equal(
        call.args.filter(argument => argument === "--bundle").length,
        1
      );
      assert.equal(call.args.includes("--bundle-from-oci"), false);
      assert.equal(
        call.args[call.args.indexOf("--bundle") + 1],
        expectedBundleBySubject.get(call.args[2])
      );
      assert.equal(call.args[call.args.indexOf("--signer-workflow") + 1],
        RUNTIME_IMAGE_BUILD_SIGNER_WORKFLOW);
      assert.equal(call.args[call.args.indexOf("--source-digest") + 1], COMMIT);
      assert.equal(call.args[call.args.indexOf("--source-ref") + 1],
        RUNTIME_IMAGE_BUILD_SOURCE_REF);
      assert.equal(call.args[call.args.indexOf("--cert-oidc-issuer") + 1],
        "https://token.actions.githubusercontent.com");
      assert.equal(call.args[call.args.indexOf("--predicate-type") + 1],
        "https://slsa.dev/provenance/v1");
      assert.equal(call.env.DOCKER_CONFIG, dockerConfig);
      assert.equal(call.args.includes(dockerConfig), false);
      assert.equal(Object.hasOwn(call.env, "GH_TOKEN"), false);
      assert.equal(Object.hasOwn(call.env, "GITHUB_TOKEN"), false);
    }
  } finally {
    cleanup(input.root);
  }
});

test("all five artifacts must be exact physical files without aliases", async t => {
  await t.test("relative image bundle path", () => {
    const input = fixture();
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => null, {
        botRunnerBundlePath: "relative/bot-runner.sigstore.json"
      })), "bot_runner_bundle_path_invalid");
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("leaf symlink", () => {
    const input = fixture();
    const link = path.join(input.root, "reticulum-link.sigstore.json");
    fs.symlinkSync(input.reticulumBundlePath, link);
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => null, {
        reticulumBundlePath: link
      })), "reticulum_bundle_path_invalid");
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("symlinked parent directory", () => {
    const input = fixture();
    const link = path.join(input.root, "artifact-directory-link");
    fs.symlinkSync(input.root, link, "dir");
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => null, {
        reticulumBundlePath: path.join(link, path.basename(input.reticulumBundlePath))
      })), "reticulum_bundle_path_invalid");
    } finally {
      cleanup(input.root);
    }
  });

  for (const field of [
    "receiptBundlePath",
    "botOrchestratorBundlePath",
    "botRunnerBundlePath",
    "reticulumBundlePath"
  ]) {
    await t.test(`${field} hard-links the receipt inode`, () => {
      const input = fixture();
      fs.rmSync(input[field]);
      fs.linkSync(input.receiptPath, input[field]);
      let calls = 0;
      try {
        expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => {
          calls += 1;
          return null;
        })), "artifact_alias_invalid");
        assert.equal(calls, 0);
      } finally {
        cleanup(input.root);
      }
    });
  }

  await t.test("two bundles hard-link the same inode", () => {
    const input = fixture();
    fs.rmSync(input.botRunnerBundlePath);
    fs.linkSync(input.botOrchestratorBundlePath, input.botRunnerBundlePath);
    let calls = 0;
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => {
        calls += 1;
        return null;
      })), "artifact_alias_invalid");
      assert.equal(calls, 0);
    } finally {
      cleanup(input.root);
    }
  });
});

test("Docker auth configuration is explicit, private and stable when supplied", async t => {
  await t.test("relative path", () => {
    const input = fixture();
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => null, {
        dockerConfigDirectory: "relative/docker-config"
      })), "docker_config_directory_invalid");
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("group-readable directory", () => {
    const input = fixture();
    const dockerConfig = dockerConfigDirectory(input, 0o750);
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => null, {
        dockerConfigDirectory: dockerConfig
      })), "docker_config_directory_invalid");
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("symlink directory", () => {
    const input = fixture();
    const target = dockerConfigDirectory(input);
    const link = path.join(input.root, "docker-config-link");
    fs.symlinkSync(target, link, "dir");
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => null, {
        dockerConfigDirectory: link
      })), "docker_config_directory_invalid");
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("global fallback remains available for CLI callers", () => {
    const input = fixture();
    const fake = successfulRunner(input);
    const originalDockerConfig = process.env.DOCKER_CONFIG;
    process.env.DOCKER_CONFIG = "/global/docker-config-fallback";
    try {
      verifyRuntimeImageBuildProvenance(options(input, fake.runner));
      assert.equal(fake.calls.length, 4);
      for (const call of fake.calls) {
        assert.equal(call.env.DOCKER_CONFIG, process.env.DOCKER_CONFIG);
        assert.equal(call.args.includes(process.env.DOCKER_CONFIG), false);
      }
    } finally {
      if (originalDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = originalDockerConfig;
      cleanup(input.root);
    }
  });
});

test("rejects noncanonical receipt bytes and exact-key drift before invoking gh", async t => {
  const cases = [
    {
      name: "pretty JSON",
      bytes: Buffer.from(`${JSON.stringify(receiptValue(), null, 2)}\n`, "utf8"),
      code: "receipt_noncanonical"
    },
    {
      name: "missing terminal newline",
      bytes: Buffer.from(canonicalRuntimeImageBuildReceiptJson(receiptValue()), "utf8"),
      code: "receipt_noncanonical"
    },
    {
      name: "CRLF",
      bytes: Buffer.from(`${canonicalRuntimeImageBuildReceiptJson(receiptValue())}\r\n`, "utf8"),
      code: "receipt_noncanonical"
    },
    {
      name: "extra key",
      bytes: canonicalBytes({ ...receiptValue(), unexpected: true }),
      code: "receipt_contract_invalid"
    }
  ];
  for (const sample of cases) {
    await t.test(sample.name, () => {
      const input = fixture({ receiptBytes: sample.bytes });
      let calls = 0;
      try {
        expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => {
          calls += 1;
          throw new Error("must not run");
        })), sample.code);
        assert.equal(calls, 0);
      } finally {
        cleanup(input.root);
      }
    });
  }
});

test("rejects receipt source, workflow, run and image-role substitutions", async t => {
  const cases = [
    {
      name: "source mismatch",
      receipt: receiptValue({ sourceCommit: "e".repeat(40) }),
      code: "receipt_contract_invalid"
    },
    {
      name: "workflow mismatch",
      receipt: receiptValue({ workflowPath: ".github/workflows/custom-docker-build-push.yml" }),
      code: "receipt_contract_invalid"
    },
    {
      name: "numeric run id",
      receipt: receiptValue({ runId: 31234567890 }),
      code: "receipt_contract_invalid"
    },
    {
      name: "runner bound to parent repository",
      receipt: receiptValue({ images: { botRunner: IMAGES.botOrchestrator } }),
      code: "receipt_image_contract_invalid"
    },
    {
      name: "uppercase digest",
      receipt: receiptValue({
        images: {
          reticulum:
            `${RUNTIME_IMAGE_BUILD_REPOSITORIES.reticulum}@sha256:${"A".repeat(64)}`
        }
      }),
      code: "receipt_image_contract_invalid"
    }
  ];
  for (const sample of cases) {
    await t.test(sample.name, () => {
      const input = fixture({ receipt: sample.receipt });
      try {
        expectCode(
          () => verifyRuntimeImageBuildProvenance(options(input, () => null)),
          sample.code
        );
      } finally {
        cleanup(input.root);
      }
    });
  }
});

test("requires all four local bundles to contain bounded JSON objects", async t => {
  const cases = [
    ["receipt bundle", "receiptBundleBytes", "receipt_bundle_invalid"],
    ["bot parent bundle", "botOrchestratorBundleBytes", "bot_orchestrator_bundle_invalid"],
    ["bot runner bundle", "botRunnerBundleBytes", "bot_runner_bundle_invalid"],
    ["reticulum bundle", "reticulumBundleBytes", "reticulum_bundle_invalid"]
  ];
  for (const [name, field, code] of cases) {
    await t.test(name, () => {
      const input = fixture({ [field]: Buffer.from("not-json", "utf8") });
      let calls = 0;
      try {
        expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => {
          calls += 1;
          return null;
        })), code);
        assert.equal(calls, 0);
      } finally {
        cleanup(input.root);
      }
    });
  }

  await t.test("oversized OCI bundle", () => {
    const input = fixture({
      reticulumBundleBytes: Buffer.alloc((16 * 1024 * 1024) + 1, 0x20)
    });
    let calls = 0;
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => {
        calls += 1;
        return null;
      })), "reticulum_bundle_path_invalid");
      assert.equal(calls, 0);
    } finally {
      cleanup(input.root);
    }
  });
});

test("the signed receipt must bind its exact bytes and expected invocation", async t => {
  await t.test("wrong receipt invocation", () => {
    const input = fixture();
    const fake = successfulRunner(input, {
      mutateEntry: (entry, index) => {
        if (index !== 0) return;
        const other = `${invocation(input.receipt)}-other`;
        entry.verificationResult.signature.certificate.runInvocationURI = other;
        entry.verificationResult.statement.predicate.runDetails.metadata.invocationId = other;
      }
    });
    try {
      expectCode(
        () => verifyRuntimeImageBuildProvenance(options(input, fake.runner)),
        "receipt_attestation_invalid"
      );
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("wrong receipt subject digest", () => {
    const input = fixture();
    const fake = successfulRunner(input, {
      mutateEntry: (entry, index) => {
        if (index === 0) {
          entry.verificationResult.statement.subject[0].digest.sha256 = "f".repeat(64);
        }
      }
    });
    try {
      expectCode(
        () => verifyRuntimeImageBuildProvenance(options(input, fake.runner)),
        "receipt_attestation_invalid"
      );
    } finally {
      cleanup(input.root);
    }
  });
});

test("every OCI attestation must use the signed source and exact common invocation", async t => {
  await t.test("one image belongs to another run", () => {
    const input = fixture();
    const fake = successfulRunner(input, {
      mutateEntry: (entry, index) => {
        if (index !== 2) return;
        const other = `${invocation(input.receipt)}9`;
        entry.verificationResult.signature.certificate.runInvocationURI = other;
        entry.verificationResult.statement.predicate.runDetails.metadata.invocationId = other;
      }
    });
    try {
      expectCode(
        () => verifyRuntimeImageBuildProvenance(options(input, fake.runner)),
        "image_attestation_invalid"
      );
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("one certificate names another source digest", () => {
    const input = fixture();
    const fake = successfulRunner(input, {
      mutateEntry: (entry, index) => {
        if (index === 3) {
          entry.verificationResult.signature.certificate.sourceRepositoryDigest =
            "e".repeat(40);
        }
      }
    });
    try {
      expectCode(
        () => verifyRuntimeImageBuildProvenance(options(input, fake.runner)),
        "attestation_identity_invalid"
      );
    } finally {
      cleanup(input.root);
    }
  });
});

test("rejects missing, extra and duplicate subjects instead of accepting a partial matrix", async t => {
  await t.test("extra subject in one statement", () => {
    const input = fixture();
    const fake = successfulRunner(input, {
      mutateEntry: (entry, index) => {
        if (index === 1) {
          entry.verificationResult.statement.subject.push({
            name: RUNTIME_IMAGE_BUILD_REPOSITORIES.reticulum,
            digest: { sha256: "e".repeat(64) }
          });
        }
      }
    });
    try {
      expectCode(
        () => verifyRuntimeImageBuildProvenance(options(input, fake.runner)),
        "image_attestation_invalid"
      );
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("duplicate matching attestations", () => {
    const input = fixture();
    const fake = successfulRunner(input, {
      entriesForCall: (entries, index) => index === 2 ? [entries[0], structuredClone(entries[0])] : entries
    });
    try {
      expectCode(
        () => verifyRuntimeImageBuildProvenance(options(input, fake.runner)),
        "image_attestation_invalid"
      );
    } finally {
      cleanup(input.root);
    }
  });
});

test("runner failures and malformed output are reduced to value-free error codes", async t => {
  await t.test("nonzero command output is wiped", () => {
    const input = fixture();
    const stdout = Buffer.from("sensitive-stdout", "utf8");
    const stderr = Buffer.from("sensitive-stderr", "utf8");
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => ({
        status: 1,
        signal: null,
        stdout,
        stderr
      }))), "attestation_command_failed");
      assert.equal(stdout.every(byte => byte === 0), true);
      assert.equal(stderr.every(byte => byte === 0), true);
    } finally {
      cleanup(input.root);
    }
  });

  await t.test("malformed JSON", () => {
    const input = fixture();
    try {
      expectCode(() => verifyRuntimeImageBuildProvenance(options(input, () => ({
        status: 0,
        signal: null,
        stdout: Buffer.from("{", "utf8"),
        stderr: Buffer.alloc(0)
      }))), "attestation_output_invalid");
    } finally {
      cleanup(input.root);
    }
  });
});

test("detects a receipt pathname mutation during external verification", () => {
  const input = fixture();
  let changed = false;
  const fake = successfulRunner(input, {
    afterCall: index => {
      if (index === 0 && !changed) {
        changed = true;
        const mutated = receiptValue({ runAttempt: "3" });
        fs.writeFileSync(input.receiptPath, canonicalBytes(mutated));
      }
    }
  });
  try {
    expectCode(
      () => verifyRuntimeImageBuildProvenance(options(input, fake.runner)),
      "receipt_changed"
    );
  } finally {
    cleanup(input.root);
  }
});

test("detects local bundle tampering during external verification", async t => {
  const cases = [
    ["receiptBundlePath", "receipt_bundle_changed"],
    ["botOrchestratorBundlePath", "bot_orchestrator_bundle_changed"],
    ["botRunnerBundlePath", "bot_runner_bundle_changed"],
    ["reticulumBundlePath", "reticulum_bundle_changed"]
  ];
  for (const [field, code] of cases) {
    await t.test(field, () => {
      const input = fixture();
      let changed = false;
      const fake = successfulRunner(input, {
        afterCall: index => {
          if (index === 0 && !changed) {
            changed = true;
            fs.writeFileSync(input[field], JSON.stringify({ tampered: true }));
          }
        }
      });
      try {
        expectCode(
          () => verifyRuntimeImageBuildProvenance(options(input, fake.runner)),
          code
        );
      } finally {
        cleanup(input.root);
      }
    });
  }
});

test("detects explicit Docker config directory mutation during verification", () => {
  const input = fixture();
  const dockerConfig = dockerConfigDirectory(input);
  let changed = false;
  const fake = successfulRunner(input, {
    afterCall: index => {
      if (index === 0 && !changed) {
        changed = true;
        fs.chmodSync(dockerConfig, 0o750);
      }
    }
  });
  try {
    expectCode(() => verifyRuntimeImageBuildProvenance(options(input, fake.runner, {
      dockerConfigDirectory: dockerConfig
    })), "docker_config_directory_changed");
  } finally {
    cleanup(input.root);
  }
});

test("CLI failures emit only one generic line and never echo arguments", () => {
  const sentinel = "DO-NOT-ECHO-RUNTIME-PROVENANCE-SENTINEL";
  const result = spawnSync(process.execPath, [CLI, "--receipt", sentinel], {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Runtime image build provenance verification failed closed\n"
  );
  assert.equal(result.stderr.includes(sentinel), false);
});

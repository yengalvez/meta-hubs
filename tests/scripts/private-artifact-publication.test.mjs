import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PrivateArtifactPublicationError,
  publishPrivateArtifact,
  readPublishedPrivateArtifact
} from "../../deployment/private-artifact-publication.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "deployment/private-artifact-publication.mjs");
const MAXIMUM = 4096;

function fixture(t, suffix) {
  const root = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    `yenhubs-private-publish-${suffix}-`
  ));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, outputPath: path.join(root, "artifact.json") };
}

function expectCode(callback, code) {
  assert.throws(
    callback,
    error => error instanceof PrivateArtifactPublicationError && error.code === code
  );
}

function crashAfterPendingFsync({ outputPath, stagingPath, bytes }) {
  const child = String.raw`
    const fs = await import("node:fs");
    const publication = await import(process.env.PUBLICATION_MODULE);
    publication.publishPrivateArtifact({
      outputPath: process.env.OUTPUT_PATH,
      stagingDirectoryPath: process.env.STAGING_PATH,
      bytes: fs.readFileSync(0),
      maximumBytes: 4096,
      hooks: {
        afterFileFsync() {
          process.kill(process.pid, "SIGKILL");
        }
      }
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    env: {
      ...process.env,
      PUBLICATION_MODULE: new URL(
        "../../deployment/private-artifact-publication.mjs",
        import.meta.url
      ).href,
      OUTPUT_PATH: outputPath,
      STAGING_PATH: stagingPath
    },
    input: bytes,
    encoding: "utf8"
  });
}

test("publishes complete owner-private bytes and adopts an exact retry", t => {
  const state = fixture(t, "basic");
  const bytes = Buffer.from('{"safe":"fixture"}\n', "utf8");
  assert.equal(publishPrivateArtifact({
    outputPath: state.outputPath,
    bytes,
    maximumBytes: MAXIMUM
  }), true);
  const stat = fs.lstatSync(state.outputPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  assert.deepEqual(readPublishedPrivateArtifact({
    outputPath: state.outputPath,
    maximumBytes: MAXIMUM
  }), bytes);
  assert.equal(publishPrivateArtifact({
    outputPath: state.outputPath,
    bytes,
    maximumBytes: MAXIMUM
  }), false);
  assert.deepEqual(fs.readdirSync(state.root), ["artifact.json"]);
});

test("an existing mismatch, hard link, symlink and loose parent fail closed", t => {
  const mismatch = fixture(t, "mismatch");
  const original = Buffer.from("original-private-bytes\n", "utf8");
  publishPrivateArtifact({
    outputPath: mismatch.outputPath,
    bytes: original,
    maximumBytes: MAXIMUM
  });
  expectCode(() => publishPrivateArtifact({
    outputPath: mismatch.outputPath,
    bytes: Buffer.from("replacement-private-bytes\n", "utf8"),
    maximumBytes: MAXIMUM
  }), "private_artifact_exists_mismatch");
  assert.deepEqual(fs.readFileSync(mismatch.outputPath), original);

  const hardlink = fixture(t, "hardlink");
  fs.writeFileSync(hardlink.outputPath, original, { mode: 0o600 });
  fs.linkSync(hardlink.outputPath, path.join(hardlink.root, "second-link"));
  expectCode(() => readPublishedPrivateArtifact({
    outputPath: hardlink.outputPath,
    maximumBytes: MAXIMUM
  }), "private_artifact_invalid");

  const symlink = fixture(t, "symlink");
  fs.writeFileSync(path.join(symlink.root, "target"), original, { mode: 0o600 });
  fs.symlinkSync(path.join(symlink.root, "target"), symlink.outputPath);
  expectCode(() => readPublishedPrivateArtifact({
    outputPath: symlink.outputPath,
    maximumBytes: MAXIMUM
  }), "private_artifact_invalid");

  const loose = fixture(t, "loose");
  fs.chmodSync(loose.root, 0o755);
  expectCode(() => publishPrivateArtifact({
    outputPath: loose.outputPath,
    bytes: original,
    maximumBytes: MAXIMUM
  }), "private_artifact_parent_invalid");
});

test("reconciles a durable temp-plus-final hard-link cut", t => {
  const state = fixture(t, "reconcile");
  const bytes = Buffer.from("durable-private-bytes\n", "utf8");
  publishPrivateArtifact({
    outputPath: state.outputPath,
    bytes,
    maximumBytes: MAXIMUM
  });
  const pending = path.join(
    state.root,
    `.artifact.json.pending-${"a".repeat(32)}`
  );
  fs.linkSync(state.outputPath, pending);
  assert.equal(fs.lstatSync(state.outputPath).nlink, 2);
  assert.deepEqual(readPublishedPrivateArtifact({
    outputPath: state.outputPath,
    maximumBytes: MAXIMUM
  }), bytes);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.lstatSync(state.outputPath).nlink, 1);
});

test("stages outside the final inventory and preserves unknown pre-link orphans", t => {
  const state = fixture(t, "external-stage");
  const staging = path.join(state.root, "staging");
  const output = path.join(state.root, "final");
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.mkdirSync(output, { mode: 0o700 });
  const outputPath = path.join(output, "artifact.json");
  const orphan = path.join(staging, `.artifact.json.pending-${"b".repeat(32)}`);
  const bytes = Buffer.from("externally-staged-private-bytes\n", "utf8");
  fs.writeFileSync(orphan, "unknown-private-bytes\n", { mode: 0o600 });

  assert.equal(publishPrivateArtifact({
    outputPath,
    bytes,
    maximumBytes: MAXIMUM,
    stagingDirectoryPath: staging
  }), true);
  assert.deepEqual(fs.readdirSync(output), ["artifact.json"]);
  assert.equal(fs.readFileSync(orphan, "utf8"), "unknown-private-bytes\n");

  const linked = path.join(staging, `.artifact.json.pending-${"c".repeat(32)}`);
  fs.linkSync(outputPath, linked);
  assert.equal(fs.lstatSync(outputPath).nlink, 2);
  assert.deepEqual(readPublishedPrivateArtifact({
    outputPath,
    maximumBytes: MAXIMUM,
    stagingDirectoryPath: staging
  }), bytes);
  assert.equal(fs.existsSync(linked), false);
  assert.equal(fs.existsSync(orphan), true);
  assert.equal(fs.lstatSync(outputPath).nlink, 1);
});

test("rejects special mode bits on private files and directories", t => {
  const file = fixture(t, "special-file");
  fs.writeFileSync(file.outputPath, "private\n", { mode: 0o600 });
  fs.chmodSync(file.outputPath, 0o4600);
  expectCode(() => readPublishedPrivateArtifact({
    outputPath: file.outputPath,
    maximumBytes: MAXIMUM
  }), "private_artifact_invalid");

  const directory = fixture(t, "special-directory");
  fs.chmodSync(directory.root, 0o1700);
  expectCode(() => publishPrivateArtifact({
    outputPath: directory.outputPath,
    bytes: Buffer.from("private\n", "utf8"),
    maximumBytes: MAXIMUM
  }), "private_artifact_parent_invalid");
});

test("a cut immediately after link leaves a recoverable complete final", t => {
  const state = fixture(t, "after-link");
  const bytes = Buffer.from("linked-private-bytes\n", "utf8");
  expectCode(() => publishPrivateArtifact({
    outputPath: state.outputPath,
    bytes,
    maximumBytes: MAXIMUM,
    hooks: {
      afterLink() {
        throw new Error("simulated abrupt cut");
      }
    }
  }), "private_artifact_publish_failed");
  assert.deepEqual(readPublishedPrivateArtifact({
    outputPath: state.outputPath,
    maximumBytes: MAXIMUM
  }), bytes);
  assert.equal(fs.lstatSync(state.outputPath).nlink, 1);
});

test("a real SIGKILL after pending fsync is authenticated and adopted on reentry", t => {
  const state = fixture(t, "sigkill-before-link");
  const staging = path.join(state.root, "staging");
  const output = path.join(state.root, "output");
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.mkdirSync(output, { mode: 0o700 });
  const outputPath = path.join(output, "artifact.json");
  const bytes = Buffer.from("sigkill-recoverable-private-bytes\n", "utf8");
  const killed = crashAfterPendingFsync({ outputPath, stagingPath: staging, bytes });
  assert.equal(killed.status, null);
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.readdirSync(staging).length, 1);

  assert.equal(publishPrivateArtifact({
    outputPath,
    stagingDirectoryPath: staging,
    bytes,
    maximumBytes: MAXIMUM
  }), false);
  assert.deepEqual(fs.readFileSync(outputPath), bytes);
  assert.deepEqual(fs.readdirSync(staging), []);
  assert.equal(fs.lstatSync(outputPath).nlink, 1);
});

test("reentry preserves and rejects a complete authenticated pending for other bytes", t => {
  const state = fixture(t, "sigkill-mismatch");
  const staging = path.join(state.root, "staging");
  const output = path.join(state.root, "output");
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.mkdirSync(output, { mode: 0o700 });
  const outputPath = path.join(output, "artifact.json");
  const first = Buffer.from("first-private-intent\n", "utf8");
  const second = Buffer.from("different-private-intent\n", "utf8");
  const killed = crashAfterPendingFsync({
    outputPath,
    stagingPath: staging,
    bytes: first
  });
  assert.equal(killed.status, null);
  assert.equal(killed.signal, "SIGKILL");
  const pending = fs.readdirSync(staging);
  assert.equal(pending.length, 1);

  expectCode(() => publishPrivateArtifact({
    outputPath,
    stagingDirectoryPath: staging,
    bytes: second,
    maximumBytes: MAXIMUM
  }), "private_artifact_exists_mismatch");
  assert.equal(fs.existsSync(outputPath), false);
  assert.deepEqual(fs.readdirSync(staging), pending);
  assert.deepEqual(readPublishedPrivateArtifact({
    outputPath,
    stagingDirectoryPath: staging,
    maximumBytes: MAXIMUM
  }), first);
  assert.deepEqual(fs.readdirSync(staging), []);
  assert.deepEqual(fs.readFileSync(outputPath), first);
});

test("reentry removes only an attributable strict-prefix partial pending", t => {
  const state = fixture(t, "sigkill-partial-prefix");
  const staging = path.join(state.root, "staging");
  const output = path.join(state.root, "output");
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.mkdirSync(output, { mode: 0o700 });
  const outputPath = path.join(output, "artifact.json");
  const bytes = Buffer.from("prefix-authenticated-private-intent\n", "utf8");
  const killed = crashAfterPendingFsync({ outputPath, stagingPath: staging, bytes });
  assert.equal(killed.status, null);
  assert.equal(killed.signal, "SIGKILL");
  const [pending] = fs.readdirSync(staging);
  fs.truncateSync(path.join(staging, pending), 7);

  assert.equal(publishPrivateArtifact({
    outputPath,
    stagingDirectoryPath: staging,
    bytes,
    maximumBytes: MAXIMUM
  }), true);
  assert.deepEqual(fs.readdirSync(staging), []);
  assert.deepEqual(fs.readFileSync(outputPath), bytes);
});

test("a parent swap before link cannot redirect publication or strand a pending", t => {
  const state = fixture(t, "parent-swap");
  const displaced = `${state.root}-opened-inode`;
  t.after(() => fs.rmSync(displaced, { recursive: true, force: true }));
  const bytes = Buffer.from("parent-anchored-private-bytes\n", "utf8");
  expectCode(() => publishPrivateArtifact({
    outputPath: state.outputPath,
    bytes,
    maximumBytes: MAXIMUM,
    hooks: {
      beforeLink() {
        fs.renameSync(state.root, displaced);
        fs.mkdirSync(state.root, { mode: 0o700 });
        fs.writeFileSync(path.join(state.root, "replacement-sentinel"), "untouched\n", {
          mode: 0o600
        });
      }
    }
  }), "private_artifact_parent_changed");

  assert.deepEqual(fs.readdirSync(state.root), ["replacement-sentinel"]);
  assert.equal(fs.existsSync(state.outputPath), false);
  assert.deepEqual(fs.readdirSync(displaced), ["artifact.json"]);
  assert.deepEqual(fs.readFileSync(path.join(displaced, "artifact.json")), bytes);
  assert.equal(
    fs.readdirSync(displaced).some(name => name.includes(".pending-")),
    false
  );
});

test("pending substitution before link neither publishes nor removes foreign inodes", t => {
  const state = fixture(t, "pending-substitution");
  const bytes = Buffer.from("owned-private-bytes\n", "utf8");
  let foreignPath;
  let preservedOwnedPath;
  expectCode(() => publishPrivateArtifact({
    outputPath: state.outputPath,
    bytes,
    maximumBytes: MAXIMUM,
    hooks: {
      beforeLink({ pendingPath }) {
        foreignPath = pendingPath;
        preservedOwnedPath = `${pendingPath}.preserved-owned`;
        fs.renameSync(pendingPath, preservedOwnedPath);
        fs.writeFileSync(pendingPath, "foreign-private-bytes\n", { mode: 0o600 });
      }
    }
  }), "private_artifact_changed");
  assert.equal(fs.existsSync(state.outputPath), false);
  assert.equal(fs.readFileSync(foreignPath, "utf8"), "foreign-private-bytes\n");
  assert.deepEqual(fs.readFileSync(preservedOwnedPath), bytes);
  expectCode(() => publishPrivateArtifact({
    outputPath: state.outputPath,
    bytes,
    maximumBytes: MAXIMUM
  }), "private_artifact_invalid");
  assert.equal(fs.readFileSync(foreignPath, "utf8"), "foreign-private-bytes\n");
  assert.deepEqual(fs.readFileSync(preservedOwnedPath), bytes);
});

test("reconciliation never removes a noncanonical pending name", t => {
  const state = fixture(t, "noncanonical-pending");
  const bytes = Buffer.from("durable-private-bytes\n", "utf8");
  publishPrivateArtifact({
    outputPath: state.outputPath,
    bytes,
    maximumBytes: MAXIMUM
  });
  const foreign = path.join(state.root, ".artifact.json.pending-owner-evidence");
  fs.linkSync(state.outputPath, foreign);
  expectCode(() => readPublishedPrivateArtifact({
    outputPath: state.outputPath,
    maximumBytes: MAXIMUM
  }), "private_artifact_invalid");
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.lstatSync(state.outputPath).nlink, 2);
});

test("CLI is silent, idempotent and never overwrites a different final", t => {
  const state = fixture(t, "cli");
  const bytes = Buffer.from("cli-private-bytes\n", "utf8");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(process.execPath, [CLI, state.outputPath, String(MAXIMUM)], {
      input: bytes,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  const mismatch = spawnSync(process.execPath, [CLI, state.outputPath, String(MAXIMUM)], {
    input: Buffer.from("different-private-bytes\n", "utf8"),
    encoding: "utf8"
  });
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.stdout, "");
  assert.equal(mismatch.stderr, "private artifact publication failed closed\n");
  assert.deepEqual(fs.readFileSync(state.outputPath), bytes);
});

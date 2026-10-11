import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
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

test("stable private read uses one dirfd helper and stays fresh", t => {
  const state = fixture(t, "stable-read-fresh");
  const first = Buffer.from("first-synthetic-private-read\n", "utf8");
  const second = Buffer.from("other-synthetic-private-read\n", "utf8");
  fs.writeFileSync(state.outputPath, first, { mode: 0o600, flag: "wx" });
  fs.chmodSync(state.outputPath, 0o600);
  const before = fs.lstatSync(state.outputPath);
  assert.equal(before.mode & 0o7777, 0o600);
  assert.equal(before.nlink, 1);
  assert.equal(fs.lstatSync(state.root).mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(state.root), ["artifact.json"]);

  const originalSpawnSync = cp.spawnSync;
  let helpers = 0;
  cp.spawnSync = function (executable, ...args) {
    if (typeof executable === "string" &&
        /^python(?:[0-9.]+)?$/iu.test(path.basename(executable))) {
      helpers += 1;
    }
    return originalSpawnSync.call(this, executable, ...args);
  };
  try {
    syncBuiltinESMExports();
    assert.deepEqual(readPublishedPrivateArtifact({
      outputPath: state.outputPath,
      maximumBytes: MAXIMUM
    }), first);
    const firstHelpers = helpers;

    fs.writeFileSync(state.outputPath, second, { mode: 0o600, flag: "w" });
    const after = fs.lstatSync(state.outputPath);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o7777, 0o600);
    assert.deepEqual(readPublishedPrivateArtifact({
      outputPath: state.outputPath,
      maximumBytes: MAXIMUM
    }), second);
    assert.equal(firstHelpers, 1);
    assert.equal(helpers - firstHelpers, 1);
  } finally {
    cp.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readdirSync(state.root), ["artifact.json"]);
});

test("a stalled dirfd reader is killed at its fixed deadline and fails closed", { concurrency: false }, t => {
  const state = fixture(t, "helper-deadline");
  const bytes = Buffer.from("unchanged-synthetic-private-artifact\n", "utf8");
  fs.writeFileSync(state.outputPath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(state.outputPath, 0o600);
  const before = fs.lstatSync(state.outputPath);
  const fifoPath = path.join(state.root, "blocked-reader.fifo");
  const pidPath = path.join(state.root, "blocked-reader.pid");
  const made = spawnSync("/usr/bin/mkfifo", ["-m", "600", fifoPath]);
  assert.equal(made.status, 0);
  const readDescriptor = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const writeDescriptor = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  const helperPath = path.join(ROOT, "deployment/private-dirfd-ops.py");
  const sentinel = "synthetic-helper-output-must-not-escape";
  const source = `
import fcntl, os, signal, sys
signal.signal(signal.SIGTERM, signal.SIG_IGN)
descriptor = os.open(${JSON.stringify(pidPath)}, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w") as opened:
    opened.write(str(os.getpid()))
    opened.flush()
sys.stdout.write(${JSON.stringify(sentinel)})
sys.stdout.flush()
sys.stderr.write(${JSON.stringify(sentinel)})
sys.stderr.flush()
fcntl.fcntl(5, fcntl.F_SETFL, fcntl.fcntl(5, fcntl.F_GETFL) & ~os.O_NONBLOCK)
os.read(5, 1)
`;
  const originalSpawnSync = cp.spawnSync;
  let observedResult, observedInput, calls = 0, captured;
  cp.spawnSync = function (executable, argv, options) {
    if (executable !== "python3" || argv[0] !== "-I" || argv[1] !== helperPath) {
      return originalSpawnSync.call(this, executable, argv, options);
    }
    calls += 1;
    // Fail immediately on the old unbounded caller; never launch another
    // indefinitely blocked reproduction without a real native kill deadline.
    assert.equal(options.timeout, 10000);
    assert.equal(options.killSignal, "SIGKILL");
    observedInput = options.input;
    observedResult = originalSpawnSync.call(this, executable, ["-I", "-c", source], {
      ...options, stdio: [...options.stdio, readDescriptor]
    });
    return observedResult;
  };
  const started = performance.now();
  try {
    syncBuiltinESMExports();
    assert.throws(() => readPublishedPrivateArtifact({
      outputPath: state.outputPath, maximumBytes: MAXIMUM
    }), error => {
      captured = error;
      return error instanceof PrivateArtifactPublicationError &&
        error.code === "private_artifact_helper_timeout";
    });
  } finally {
    cp.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
    fs.closeSync(writeDescriptor);
    fs.closeSync(readDescriptor);
  }
  assert.equal(calls, 1);
  assert.equal(observedResult.error?.code, "ETIMEDOUT");
  assert.equal(observedResult.signal, "SIGKILL");
  assert.equal(observedResult.status, null);
  assert.ok(performance.now() - started < 20000);
  const pid = Number(fs.readFileSync(pidPath, "utf8"));
  assert.equal(pid, observedResult.pid);
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
  assert.ok(observedInput.every(value => value === 0));
  assert.equal(JSON.stringify(captured).includes(sentinel), false);
  assert.equal(captured.message.includes(sentinel), false);
  assert.deepEqual(fs.readFileSync(state.outputPath), bytes);
  const after = fs.lstatSync(state.outputPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o7777, 0o600);
});

test("transport failures take precedence over helper missing and fallback sentinels", { concurrency: false }, t => {
  const state = fixture(t, "helper-transport-precedence");
  const bytes = Buffer.from("transport-failure-fixture\n", "utf8");
  fs.writeFileSync(state.outputPath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(state.outputPath, 0o600);
  const before = fs.lstatSync(state.outputPath);
  const helperPath = path.join(ROOT, "deployment/private-dirfd-ops.py");
  const originalSpawnSync = cp.spawnSync;
  try {
    for (const operation of ["read", "publish"]) {
      for (const status of [44, 45, 46]) {
        for (const fault of ["timeout", "signal", "error"]) {
          let calls = 0, helperInput;
          cp.spawnSync = function (executable, argv, options) {
            assert.equal(executable, "python3");
            assert.deepEqual(argv, ["-I", helperPath]);
            calls += 1;
            helperInput = options.input;
            const request = JSON.parse(helperInput.subarray(0, helperInput.indexOf(10)).toString("utf8"));
            assert.equal(request.action, operation === "read" ? "read-clean" : "stat");
            return {
              status, stdout: Buffer.alloc(0), stderr: Buffer.from("synthetic-private-stderr"),
              signal: fault === "signal" ? "SIGKILL" : null,
              error: fault === "signal" ? undefined : Object.assign(new Error("synthetic-private-error"), {
                code: fault === "timeout" ? "ETIMEDOUT" : "EIO"
              })
            };
          };
          syncBuiltinESMExports();
          const invoke = operation === "read" ? () => readPublishedPrivateArtifact({
            outputPath: state.outputPath, maximumBytes: MAXIMUM
          }) : () => publishPrivateArtifact({
            outputPath: state.outputPath, bytes, maximumBytes: MAXIMUM
          });
          expectCode(invoke, fault === "timeout" ? "private_artifact_helper_timeout" : "private_artifact_changed");
          assert.equal(calls, 1);
          assert.ok(helperInput.every(value => value === 0));
          assert.deepEqual(fs.readFileSync(state.outputPath), bytes);
          assert.equal(fs.lstatSync(state.outputPath).ino, before.ino);
          assert.deepEqual(fs.readdirSync(state.root), ["artifact.json"]);
        }
      }
    }
  } finally {
    cp.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
});

function directorySnapshot(directory) {
  const value = fs.lstatSync(directory, { bigint: true });
  return { dev: value.dev, ino: value.ino, uid: value.uid, mode: value.mode, nlink: value.nlink };
}

function withInstrumentedCleanRead(mode, callback) {
  const helperPath = path.join(ROOT, "deployment/private-dirfd-ops.py");
  const prefix = "private-artifact-test-counters:";
  const source = String.raw`
import json
import os
import runpy
import sys

mode = ${JSON.stringify(mode)}
helper_path = sys.argv[1]
counts = {"loaderReached": False, "leafReads": 0, "exactReads": 0,
          "replacementReads": 0, "swapPerformed": False}
captured = {}

class LoaderStop(BaseException):
    pass

def stop_before_main(frame, event, argument):
    if (event == "call" and frame.f_code.co_name == "main"
            and frame.f_code.co_filename == helper_path):
        captured["main"] = frame.f_globals["main"]
        raise LoaderStop()
    return stop_before_main

status = 1
try:
    previous_trace = sys.gettrace()
    sys.settrace(stop_before_main)
    try:
        runpy.run_path(helper_path)
    except LoaderStop:
        pass
    finally:
        sys.settrace(previous_trace)
    main = captured.get("main")
    if main is None:
        raise SystemExit(1)
    counts["loaderReached"] = True
    namespace = main.__globals__
    real_leaf = namespace["read_leaf_with_stat"]
    real_exact = namespace["exact_read"]
    replacement_identity = None
    if mode == "swap":
        replacement = os.stat("replacement-candidate.json", dir_fd=3, follow_symlinks=False)
        replacement_identity = (replacement.st_dev, replacement.st_ino)

    def counted_exact(fd, size):
        counts["exactReads"] += 1
        value = os.fstat(fd)
        if (value.st_dev, value.st_ino) == replacement_identity:
            counts["replacementReads"] += 1
        return real_exact(fd, size)

    def counted_leaf(fd, name, maximum, links, allow_empty=False):
        counts["leafReads"] += 1
        result = real_leaf(fd, name, maximum, links, allow_empty)
        if mode == "swap" and counts["leafReads"] == 1:
            os.rename(name, "original-preserved.json", src_dir_fd=fd, dst_dir_fd=fd)
            os.rename("replacement-candidate.json", name, src_dir_fd=fd, dst_dir_fd=fd)
            counts["swapPerformed"] = True
        if mode == "foreign" and counts["leafReads"] == 1:
            foreign = os.open("foreign-unrelated.json",
                              os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                              0o600, dir_fd=4)
            os.fchmod(foreign, 0o600)
            with os.fdopen(foreign, "wb") as opened:
                opened.write(b"foreign-unrelated-synthetic-bytes\n")
                opened.flush()
                os.fsync(opened.fileno())
        return result

    namespace["exact_read"] = counted_exact
    namespace["read_leaf_with_stat"] = counted_leaf
    main()
    status = 0
except SystemExit as error:
    status = error.code if isinstance(error.code, int) else 1
except BaseException:
    status = 1
finally:
    sys.stderr.write(${JSON.stringify(prefix)} + json.dumps(counts, separators=(",", ":")) + "\n")
raise SystemExit(status)
`;
  const originalSpawnSync = cp.spawnSync;
  const observations = [];
  let helpers = 0;
  cp.spawnSync = function (executable, argv, options) {
    if (executable !== "python3" || argv[0] !== "-I" || argv[1] !== helperPath) {
      return originalSpawnSync.call(this, executable, argv, options);
    }
    helpers += 1;
    const input = options.input;
    const action = JSON.parse(input.subarray(0, input.indexOf(0x0a)).toString("utf8")).action;
    if (action !== "read-clean") {
      return originalSpawnSync.call(this, executable, argv, options);
    }
    const result = originalSpawnSync.call(this, executable, ["-I", "-c", source, helperPath], options);
    let counters;
    let countersClosed = false;
    try {
      const stderr = result.stderr.toString("utf8");
      if (stderr.startsWith(prefix) && stderr.endsWith("\n")) {
        counters = JSON.parse(stderr.slice(prefix.length, -1));
        countersClosed = Object.keys(counters).sort().join(",") ===
          "exactReads,leafReads,loaderReached,replacementReads,swapPerformed" &&
          typeof counters.loaderReached === "boolean" && typeof counters.swapPerformed === "boolean" &&
          [counters.exactReads, counters.leafReads, counters.replacementReads].every(value =>
            Number.isSafeInteger(value) && value >= 0
          );
      }
    } catch { /* Record only the closed counters, never helper content. */ }
    observations.push({
      status: result.status, signal: result.signal,
      stdoutBytes: Buffer.isBuffer(result.stdout) ? result.stdout.length : -1,
      counters, countersClosed
    });
    return result;
  };
  try {
    syncBuiltinESMExports();
    callback({ observations, helpers: () => helpers });
  } finally {
    cp.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
}

test("one real clean helper retains all four exact_read passes", { concurrency: false }, t => {
  const state = fixture(t, "four-passes");
  const staging = path.join(state.root, "staging");
  fs.mkdirSync(staging, { mode: 0o700 });
  const bytes = Buffer.from("four-pass-synthetic-private-bytes\n", "utf8");
  fs.writeFileSync(state.outputPath, bytes, { flag: "wx", mode: 0o600 });
  fs.chmodSync(state.outputPath, 0o600);
  const parentBefore = directorySnapshot(state.root);
  const stagingBefore = directorySnapshot(staging);
  withInstrumentedCleanRead("count", ({ observations, helpers }) => {
    assert.deepEqual(readPublishedPrivateArtifact({
      outputPath: state.outputPath, stagingDirectoryPath: staging, maximumBytes: MAXIMUM
    }), bytes);
    assert.equal(helpers(), 1);
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0], {
      status: 0, signal: null, stdoutBytes: bytes.length, countersClosed: true,
      counters: { loaderReached: true, leafReads: 2, exactReads: 4, replacementReads: 0, swapPerformed: false }
    });
  });
  assert.deepEqual(directorySnapshot(state.root), parentBefore);
  assert.deepEqual(directorySnapshot(staging), stagingBefore);
  assert.deepEqual(fs.readdirSync(staging), []);
  assert.deepEqual(fs.readdirSync(state.root).sort(), ["artifact.json", "staging"]);
});

test("clean helper rejects a same-size inode swap before reading the replacement", { concurrency: false }, t => {
  const state = fixture(t, "read-inode-swap");
  const staging = path.join(state.root, "staging");
  const candidatePath = path.join(state.root, "replacement-candidate.json");
  const originalPath = path.join(state.root, "original-preserved.json");
  fs.mkdirSync(staging, { mode: 0o700 });
  const original = Buffer.from("original-synthetic-private-bytes\n", "utf8");
  const replacement = Buffer.from("intruder-synthetic-private-bytes\n", "utf8");
  assert.equal(original.length, replacement.length);
  fs.writeFileSync(state.outputPath, original, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(candidatePath, replacement, { flag: "wx", mode: 0o600 });
  fs.chmodSync(state.outputPath, 0o600);
  fs.chmodSync(candidatePath, 0o600);
  const originalBefore = fs.lstatSync(state.outputPath, { bigint: true });
  const replacementBefore = fs.lstatSync(candidatePath, { bigint: true });
  assert.notEqual(originalBefore.ino, replacementBefore.ino);
  assert.equal(originalBefore.mode & 0o7777n, 0o600n);
  assert.equal(replacementBefore.mode & 0o7777n, 0o600n);
  const parentBefore = directorySnapshot(state.root);
  const stagingBefore = directorySnapshot(staging);
  withInstrumentedCleanRead("swap", ({ observations, helpers }) => {
    expectCode(() => readPublishedPrivateArtifact({
      outputPath: state.outputPath, stagingDirectoryPath: staging, maximumBytes: MAXIMUM
    }), "private_artifact_changed");
    assert.equal(helpers(), 1);
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0], {
      status: 1, signal: null, stdoutBytes: 0, countersClosed: true,
      counters: { loaderReached: true, leafReads: 1, exactReads: 2, replacementReads: 0, swapPerformed: true }
    });
  });
  assert.deepEqual(directorySnapshot(state.root), parentBefore);
  assert.deepEqual(directorySnapshot(staging), stagingBefore);
  assert.deepEqual(fs.readdirSync(staging), []);
  assert.deepEqual(fs.readdirSync(state.root).sort(), ["artifact.json", "original-preserved.json", "staging"]);
  assert.deepEqual(fs.readFileSync(originalPath), original);
  assert.deepEqual(fs.readFileSync(state.outputPath), replacement);
  const preserved = fs.lstatSync(originalPath, { bigint: true });
  const current = fs.lstatSync(state.outputPath, { bigint: true });
  for (const field of ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs"]) {
    assert.equal(preserved[field], originalBefore[field]);
    assert.equal(current[field], replacementBefore[field]);
  }
});

test("clean read tolerates a new unrelated staging file and preserves it", { concurrency: false }, t => {
  const state = fixture(t, "unrelated-staging-file");
  const staging = path.join(state.root, "staging");
  const foreignName = "foreign-unrelated.json";
  const foreignPath = path.join(staging, foreignName);
  fs.mkdirSync(staging, { mode: 0o700 });
  const bytes = Buffer.from("compatible-synthetic-private-bytes\n", "utf8");
  fs.writeFileSync(state.outputPath, bytes, { flag: "wx", mode: 0o600 });
  fs.chmodSync(state.outputPath, 0o600);
  const targetBefore = fs.lstatSync(state.outputPath, { bigint: true });
  assert.equal(targetBefore.nlink, 1n);
  const parentBefore = directorySnapshot(state.root);
  const stagingBefore = directorySnapshot(staging);
  assert.equal(foreignName.startsWith(".artifact.json.pending-"), false);
  assert.deepEqual(fs.readdirSync(staging), []);
  withInstrumentedCleanRead("foreign", ({ observations, helpers }) => {
    assert.deepEqual(readPublishedPrivateArtifact({
      outputPath: state.outputPath, stagingDirectoryPath: staging, maximumBytes: MAXIMUM
    }), bytes);
    assert.equal(helpers(), 1);
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0], {
      status: 0, signal: null, stdoutBytes: bytes.length, countersClosed: true,
      counters: { loaderReached: true, leafReads: 2, exactReads: 4, replacementReads: 0, swapPerformed: false }
    });
  });
  assert.deepEqual(directorySnapshot(state.root), parentBefore);
  const stagingAfter = directorySnapshot(staging);
  for (const field of ["dev", "ino", "uid", "mode"]) {
    assert.equal(stagingAfter[field], stagingBefore[field]);
  }
  assert.deepEqual(fs.readdirSync(staging), [foreignName]);
  assert.deepEqual(fs.readdirSync(state.root).sort(), ["artifact.json", "staging"]);
  assert.equal(fs.readFileSync(foreignPath, "utf8"), "foreign-unrelated-synthetic-bytes\n");
  const foreign = fs.lstatSync(foreignPath, { bigint: true });
  assert.equal(foreign.nlink, 1n);
  assert.equal(foreign.mode & 0o7777n, 0o600n);
  assert.equal(foreign.uid, targetBefore.uid);
  const targetAfter = fs.lstatSync(state.outputPath, { bigint: true });
  for (const field of ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
    assert.equal(targetAfter[field], targetBefore[field]);
  }
});

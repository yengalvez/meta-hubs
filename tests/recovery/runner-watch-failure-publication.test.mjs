import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeFailureMarker } from "../../deployment/watch-bot-runner-pods.mjs";

const frame = "runner_watch_failed\n";
const frameBytes = Buffer.from(frame, "ascii");
assert.equal(frameBytes.length, 20);

function fixture(t, content = "") {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-watch-failure-"));
  fs.chmodSync(directory, 0o700);
  const marker = path.join(directory, "failure");
  const descriptor = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(descriptor, content, { encoding: "ascii" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return { directory, marker };
}

function recordedIO(action, { interruptWrite = false } = {}) {
  const original = {
    writeSync: fs.writeSync,
    ftruncateSync: fs.ftruncateSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync
  };
  const calls = [];
  fs.writeSync = (...args) => {
    const [descriptor, bytes, offset, length, position] = args;
    calls.push({ operation: "write", descriptor, bytes: Buffer.isBuffer(bytes) ? Buffer.from(bytes) : bytes,
      offset, length, position });
    if (interruptWrite) throw new Error("simulated interrupted writer");
    return original.writeSync(...args);
  };
  fs.ftruncateSync = (descriptor, length) => {
    calls.push({ operation: "truncate", descriptor, length });
    return original.ftruncateSync(descriptor, length);
  };
  fs.fsyncSync = descriptor => {
    calls.push({ operation: "fsync", descriptor });
    return original.fsyncSync(descriptor);
  };
  fs.closeSync = descriptor => {
    calls.push({ operation: "close", descriptor });
    return original.closeSync(descriptor);
  };
  // These seams are synchronous and each test is sequential. Never leave a
  // patched native API behind, including when the publication/assertion fails.
  try {
    action();
    return calls;
  } finally {
    Object.assign(fs, original);
  }
}

function assertFixedFrame(marker) {
  assert.deepEqual(fs.readFileSync(marker), frameBytes);
  const stat = fs.statSync(marker);
  assert.equal(stat.size, 20);
  assert.equal(stat.mode & 0o777, 0o600);
}

test("failure publication writes fixed positional bytes before truncate20, fsync and close", { concurrency: false }, t => {
  const { marker } = fixture(t, `${frame}old-tail`);
  const inode = fs.statSync(marker).ino;
  const calls = recordedIO(() => writeFailureMarker(marker));
  assert.deepEqual(calls.map(call => call.operation), ["write", "truncate", "fsync", "close"]);
  const [write, truncate] = calls;
  assert.ok(Buffer.isBuffer(write.bytes), "publication must use the fixed byte frame");
  assert.deepEqual(write.bytes, frameBytes);
  assert.equal(write.offset, 0);
  assert.equal(write.length, 20);
  assert.equal(write.position, 0, "shared descriptors must not rely on a mutable current file offset");
  assert.equal(truncate.length, 20, "failure publication must never pretruncate to zero");
  assert.ok(calls.every(call => call.descriptor === write.descriptor));
  assert.equal(fs.statSync(marker).ino, inode, "publication must retain the shared marker inode");
  assertFixedFrame(marker);
});

test("interruption at write preserves an already durable twenty-byte failure frame", { concurrency: false }, t => {
  const { marker } = fixture(t, frame);
  const inode = fs.statSync(marker).ino;
  const calls = recordedIO(() => {
    assert.throws(() => writeFailureMarker(marker), { code: "marker_write" });
  }, { interruptWrite: true });
  assert.deepEqual(calls.map(call => call.operation), ["write", "close"],
    "an interrupted write must neither truncate nor acknowledge publication with fsync");
  assert.equal(fs.statSync(marker).ino, inode);
  assertFixedFrame(marker);
});

test("empty private marker receives the exact durable failure frame and retains mode0600", { concurrency: false }, t => {
  const { marker } = fixture(t);
  assert.equal(fs.statSync(marker).size, 0);
  writeFailureMarker(marker);
  assertFixedFrame(marker);
});

test("symlink and nonprivate failure markers are rejected without altering their bytes or modes", { concurrency: false }, t => {
  const { directory, marker } = fixture(t, frame);
  const symlink = path.join(directory, "failure-link");
  fs.symlinkSync(marker, symlink);
  assert.throws(() => writeFailureMarker(symlink), { code: "marker_contract" });
  assert.ok(fs.lstatSync(symlink).isSymbolicLink());
  assert.equal(fs.readlinkSync(symlink), marker);
  assertFixedFrame(marker);

  fs.chmodSync(marker, 0o640);
  const before = fs.statSync(marker);
  assert.throws(() => writeFailureMarker(marker), { code: "marker_contract" });
  const after = fs.statSync(marker);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mode & 0o777, 0o640);
  assert.deepEqual(fs.readFileSync(marker), frameBytes);
});

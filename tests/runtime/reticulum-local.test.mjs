import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { networkProfile, assertPostmaster, runtimeCases } from "./reticulum-local.mjs";

test("chat canary and remaining boundaries never rerun the accepted profiles", () => {
  assert.deepEqual(runtimeCases("--chat-canary"), [{ profile: "chat-canary", count: 2 }]);
  assert.deepEqual(runtimeCases("--chat-boundaries"), [{ profile: "chat-boundaries", count: 5 }]);
  assert.deepEqual(runtimeCases("--run"), [{ profile: "existing-tests", count: 5 }]);
  assert.deepEqual(runtimeCases("--profiles"), ["base", "base-avaturn", "bots", "bots-avaturn", "bots-ai", "bots-ai-avaturn"].map(profile => ({ profile, count: 1 })));
});

test("unknown, empty or broad runtime modes fail before materialization", () => {
  for (const mode of ["--all", "--chat", "", undefined, "--profiles-extra"]) {
    assert.throws(() => runtimeCases(mode), /explicit_native_target_required/);
  }
});

test("network profile has only one outbound local port, not all loopback", () => {
  const profile = networkProfile(55483);
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /network-bind\(local ip "localhost:\*"\)/);
  assert.match(profile, /network-inbound\(local ip "localhost:\*"\)/);
  assert.match(profile, /network-outbound\(remote ip "localhost:55483"\)/);
  assert.equal((profile.match(/network-outbound/g) || []).length, 1);
  assert.doesNotMatch(profile, /remote ip "localhost:\*"|allow network\*/);
});

for (const value of ["55483", 0, 1023, 65536, 55483.5, NaN, undefined]) {
  test(`reject non-private/noninteger port ${value}`, () => {
    assert.throws(() => networkProfile(value), /invalid_private_port/);
  });
}

function fixture(change = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ynret-guard-"));
  fs.chmodSync(work, 0o700);
  const data = path.join(work, "database"); fs.mkdirSync(data, { mode: 0o700 });
  const epoch = Math.floor(Date.now() / 1000);
  const fields = [String(process.pid), data, String(epoch), "55483", path.join(work, "socket"), "127.0.0.1"];
  for (const [index, value] of Object.entries(change)) fields[Number(index)] = value;
  fs.writeFileSync(path.join(data, "postmaster.pid"), fields.join("\n") + "\n", { mode: 0o600 });
  // Keep these tiny owned fixtures as evidence; no server is ever started.
  return { work, data, epoch };
}

test("accept exact identity and only check liveness, never stop a process", () => {
  const { work, data, epoch } = fixture();
  assert.equal(assertPostmaster(work, data, 55483, epoch), process.pid);
});

for (const [name, change] of [
  ["invalid PID", { 0: "0" }],
  ["another data directory", { 1: "/private/tmp/another-database" }],
  ["stale epoch", { 2: "1" }],
  ["another port", { 3: "55484" }],
  ["foreign socket", { 4: "/private/tmp/foreign-socket" }],
  ["nonlocal bind", { 5: "0.0.0.0" }]
]) {
  test(`refuse ${name} before any liveness/stop effect`, () => {
    const { work, data, epoch } = fixture(change);
    assert.throws(() => assertPostmaster(work, data, 55483, epoch), /postmaster_identity_mismatch/);
  });
}

test("refuse a symlink PID file", () => {
  const { work, data, epoch } = fixture();
  const alternate = path.join(work, "another-database"); fs.mkdirSync(alternate, { mode: 0o700 });
  fs.symlinkSync(path.join(data, "postmaster.pid"), path.join(alternate, "postmaster.pid"));
  assert.throws(() => assertPostmaster(work, alternate, 55483, epoch), /unowned_postmaster/);
});

test("CLI without opt-in refuses before creating/starting any target", () => {
  const result = spawnSync(process.execPath, [new URL("./reticulum-local.mjs", import.meta.url).pathname], {
    env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RET_LOCAL_FAIL:arguments:explicit_native_target_required/);
  assert.equal(result.stdout, "");
});

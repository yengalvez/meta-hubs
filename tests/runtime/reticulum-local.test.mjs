import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { networkProfile, assertPostmaster, runtimeCases } from "./reticulum-local.mjs";

test("avaturn runtime selects only the five new native capability cases", () => {
  assert.deepEqual(runtimeCases("--avaturn-runtime"), [{ profile: "avaturn-runtime", count: 5 }]);
  assert.throws(() => runtimeCases("--avaturn"), /explicit_native_target_required/);
  const source = fs.readFileSync(new URL("./reticulum-local.exs", import.meta.url), "utf8");
  const branch = source.match(/avaturn_runtime ->([\s\S]*?)\n    chat_focus ->/);
  assert.ok(branch, "dedicated capability-only selection is required");
  for (const file of ["test/ret/product_modules_test.exs", "test/ret/app_config_test.exs", "test/ret_web/channels/hub_channel_test.exs"]) {
    assert.ok(branch[1].includes(`Code.require_file("${file}")`));
  }
  assert.match(branch[1], /length\(selected\) != 5/);
  assert.match(branch[1], /ExUnit.configure\(exclude: \[:test\], include: \[:avaturn_runtime_capabilities\]\)/);
  assert.match(branch[1], /\{5, length\(tests\), length\(tests\) - 5\}/);
  assert.doesNotMatch(branch[1], /reticulum-profiles|bot_chat_presence/);
});

test("historical five native tests exclude only the new avaturn tag", () => {
  const source = fs.readFileSync(new URL("./reticulum-local.exs", import.meta.url), "utf8");
  const branch = source.match(/profile == "existing-tests" ->([\s\S]*?)\n    avaturn_runtime ->/);
  assert.ok(branch, "preserved historical branch is required");
  assert.match(branch[1], /ExUnit.configure\(exclude: \[:avaturn_runtime_capabilities\]\)/);
  assert.match(branch[1], /\{5, 7, 2\}/);
  assert.match(source, /profile == "existing-tests" or avaturn_runtime or chat_focus/);
});

test("config-cache canary selects only its positive and immediate OFF cases", () => {
  assert.deepEqual(runtimeCases("--config-cache-canary"), [{ profile: "config-cache-canary", count: 2 }]);
  assert.deepEqual(runtimeCases("--config-cache-boundaries"), [{ profile: "config-cache-boundaries", count: 4 }]);
  assert.deepEqual(runtimeCases("--config-cache-types"), [{ profile: "config-cache-types", count: 1 }]);
  assert.throws(() => runtimeCases("--config-cache"), /explicit_native_target_required/);
});

test("chat canary and remaining boundaries never rerun the accepted profiles", () => {
  assert.deepEqual(runtimeCases("--chat-canary"), [{ profile: "chat-canary", count: 2 }]);
  assert.deepEqual(runtimeCases("--chat-boundaries"), [{ profile: "chat-boundaries", count: 5 }]);
  assert.deepEqual(runtimeCases("--chat-concurrent"), [{ profile: "chat-concurrent", count: 2 }]);
  assert.deepEqual(runtimeCases("--chat-concurrent-boundaries"), [{ profile: "chat-concurrent-boundaries", count: 4 }]);
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { networkProfile, assertPostmaster, runtimeCases, browserOrigin, uiSocketCommand, inspectHexArchive, writeUiSocketLog } from "./reticulum-local.mjs";

for (const stream of ["stdout", "stderr"]) {
  test(`UI socket ${stream} log failure remains a closed callback result`, () => {
    const original = fs.writeSync;
    const pipe = new EventEmitter(), failures = [];
    let forwarded = false;
    fs.writeSync = () => { const error = new Error("synthetic log failure"); error.code = stream === "stdout" ? "ENOSPC" : "EIO"; throw error; };
    try {
      pipe.on("data", bytes => {
        if (!writeUiSocketLog(123, bytes, code => failures.push(code))) return;
        forwarded = true;
      });
      assert.doesNotThrow(() => pipe.emit("data", Buffer.from("synthetic fixture output\n")));
      assert.deepEqual(failures, ["ui_socket_private_log_write_failed"]);
      assert.equal(forwarded, false);
      const runner = fs.readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
      assert.match(runner, /child.stderr.on\("data", bytes => writeUiSocketLog\(log, bytes, fail\)\)/);
      assert.match(runner, /if \(!writeUiSocketLog\(log, bytes, fail\)\) return/);
      assert.match(runner, /if \(socketMode\) \{\s*\/\/ Diagnostic storage[\s\S]*?try \{ stopOwnedDatabase\(\); \}/);
    } finally { fs.writeSync = original; }
  });
}

test("UI socket is one explicit observation, never a replay of native tests", () => {
  assert.deepEqual(runtimeCases("--profile-ui-socket"), [{ profile: "profile-ui-socket", count: 0 }]);
  const runner = fs.readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
  const bootstrap = fs.readFileSync(new URL("./reticulum-local.exs", import.meta.url), "utf8");
  const fixture = fs.readFileSync(new URL("./reticulum-ui-socket.exs", import.meta.url), "utf8");
  assert.ok(runner.indexOf("hexArchive = inspectHexArchive(args[8])") < runner.indexOf('work = fs.mkdtempSync'));
  assert.match(runner, /if \(socketMode\) step\("copy-verified-existing-hex-private-home"/);
  assert.match(runner, /else step\("materialize-pinned-hex-private-home"/);
  assert.match(runner, /outcome = socketMode \? "OBSERVATION_STOPPED" : "PASS"/);
  assert.match(runner, /ui_socket_input_eof_without_stop/);
  assert.match(runner, /ui_socket_observation_deadline/);
  assert.match(runner, /ui_socket_owned_process_still_alive/);
  assert.match(bootstrap, /Keyword.put\(:allowed_origins, origin\)/);
  assert.match(bootstrap, /if ui_socket do\n  Ecto.Adapters.SQL.Sandbox.mode\(Ret.Repo, :auto\)/);
  assert.match(fixture, /Hub.changeset\(nil,/);
  assert.match(fixture, /AppConfig.set_config_value\("features\|require_account_for_join", true\)/);
  assert.match(fixture, /%AppConfig\{value: %\{"value" => \^enabled\}\}/);
  assert.match(fixture, /Application.stop\(:ret\)/);
  assert.doesNotMatch(fixture, /Endpoint\.broadcast\s*\(|ExUnit\.run\s*\(|bot_access_key|entered|HTTPoison/);
});

test("socket origin and stdin commands have a closed local schema", () => {
  assert.equal(browserOrigin("http://127.0.0.1:18443"), "http://127.0.0.1:18443");
  for (const value of [undefined, "http://localhost:18443", "http://127.0.0.1:80", "http://127.0.0.1:65536", "http://127.0.0.1:18443/", "https://127.0.0.1:18443", "http://127.0.0.1:18443?token=x", "http://user@127.0.0.1:18443", "*"]) {
    assert.throws(() => browserOrigin(value), /exact_browser_origin_required/);
  }
  for (const command of ["BASE", "BOTS_AI", "STOP"]) assert.equal(uiSocketCommand(JSON.stringify({ command })), command);
  for (const line of ['{"command":"BASE","other":1}', '{"command":"BASE","command":"STOP"}', '{"command":"ON"}', '{"command":"BOTS\\u005fAI"}', "[]", "", " ".repeat(129)]) {
    assert.throws(() => uiSocketCommand(line), /invalid_ui_socket_command/);
  }
  assert.throws(() => inspectHexArchive(path.join(os.tmpdir(), `missing-hex-${process.pid}`)), /ENOENT/);
});

test("connected browser binds a private bootstrap and never exposes SQL buttons", () => {
  const source = fs.readFileSync(new URL("./profile-ui-browser.mjs", import.meta.url), "utf8");
  const entry = fs.readFileSync(new URL("./profile-ui-browser-entry.js", import.meta.url), "utf8");
  assert.match(source, /exact_linked_browser_port_required/);
  assert.match(source, /bootstrap_hash_mismatch/);
  assert.match(source, /connected_source_not_frozen/);
  assert.match(source, /connect-src \$\{connection.ws_url\}\/websocket/);
  assert.match(source, /__RETICULUM_UI_BOOTSTRAP__:\s*JSON.stringify\(connection\)/);
  assert.match(entry, /hub.setChannel\(transport\)/);
  assert.match(entry, /socket.connect\(\)/);
  assert.match(entry, /transport\s*\.join\(10000\)/);
  assert.match(entry, /deniedChannel\s*\.join\(10000\)/);
  assert.match(entry, /missingChannel\s*\.join\(10000\)/);
  assert.match(entry, /missingToken: status/);
  assert.match(entry, /response.reason === "join_denied"/);
  assert.match(entry, /onClick: \(\) => socket.disconnect\(\)/);
  assert.match(entry, /bootstrap\s*\?\s*React.createElement\(\s*"div"/);
  assert.doesNotMatch(entry, /configs\.set|hub.configureProductModules|fetch\(/);
});

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

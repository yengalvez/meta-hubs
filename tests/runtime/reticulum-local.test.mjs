import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { networkProfile, assertPostmaster, runtimeCases, browserOrigin, uiSocketCommand, creatorSocketCommand, validateCreatorBootstrap, compiledCanarySourcePaths, inspectHexArchive, writeUiSocketLog } from "./reticulum-local.mjs";

test("creator compilation guard ignores checker-only files but keeps real resources", () => {
  const root = path.resolve("/synthetic-canary-root");
  const entry = "tests/runtime/profile-media-browser-entry.js", media = "hubs/src/react-components/media-browser.js";
  const sdk = "hubs/src/utils/avaturn-sdk.js", files = new Set([entry, media, sdk]);
  const compilation = {
    fileDependencies: new Set([...files].map(file => path.join(root, file))),
    modules: new Set([{ resource: path.join(root, entry) }, { resource: path.join(root, media) }]),
  };
  assert.deepEqual(compiledCanarySourcePaths(compilation, root, files), [media, entry].sort());
  const wrapper = fs.readFileSync(new URL("./profile-ui-browser.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /compiledCanarySourcePaths\(stats\.compilation, root, sourcePaths\)/);
  assert.doesNotMatch(wrapper, /\.\.\.stats\.compilation\.fileDependencies/);
  assert.match(wrapper, /creator_canary_must_not_include_editor_or_sdk/);
});

test("creator compilation guard detects forbidden resources inside concatenated modules", () => {
  const root = path.resolve("/synthetic-canary-root");
  for (const file of ["hubs/src/utils/avaturn-sdk.js", "hubs/src/react-components/avaturn-creator.js", "hubs/src/react-components/avatar-editor.js"]) {
    const nested = { resource: path.join(root, file) }, parent = { modules: new Set([nested]) };
    nested.modules = new Set([parent]); // A repeated/cyclic reference cannot hide a resource or loop.
    assert.deepEqual(compiledCanarySourcePaths({ modules: new Set([parent]) }, root, new Set([file])), [file]);
  }
  for (const compilation of [null, {}, { modules: {} }])
    assert.throws(() => compiledCanarySourcePaths(compilation, root, new Set()), /invalid_canary_module_graph/);
});

test("creator compilation guard normalizes query and fragment on actual resources", () => {
  const root = path.resolve("/synthetic-canary-root");
  const required = "hubs/src/react-components/media-browser.js";
  const forbidden = ["hubs/src/utils/avaturn-sdk.js", "hubs/src/react-components/avaturn-creator.js", "hubs/src/react-components/avatar-editor.js"];
  for (const file of [required, ...forbidden]) {
    for (const suffix of ["?canary", "#fragment", "?canary#fragment"]) {
      const nested = { resource: path.join(root, file) + suffix };
      const parent = { modules: new Set([nested]) };
      nested.modules = new Set([parent]);
      assert.deepEqual(compiledCanarySourcePaths({ modules: new Set([parent]) }, root, new Set([file])), [file]);
    }
  }
});

test("creator socket mode and commands stay separate from the accepted UI observation", () => {
  assert.deepEqual(runtimeCases("--profile-creator-socket"), [{ profile: "profile-creator-socket", count: 0 }]);
  assert.deepEqual(runtimeCases("--profile-ui-socket"), [{ profile: "profile-ui-socket", count: 0 }]);
  for (const command of ["CREATOR_ON", "CREATOR_OFF", "STOP"]) assert.equal(creatorSocketCommand(JSON.stringify({ command })), command);
  for (const command of ["BASE", "BOTS_AI"]) assert.throws(() => creatorSocketCommand(JSON.stringify({ command })), /invalid_creator_socket_command/);
  for (const command of ["CREATOR_ON", "CREATOR_OFF"]) assert.throws(() => uiSocketCommand(JSON.stringify({ command })), /invalid_ui_socket_command/);
  for (const line of ['{"command":"CREATOR_ON","extra":true}', '{"command":"CREATOR_OFF","command":"STOP"}', '{"command":"CREATOR\\u005fON"}', " ".repeat(129), "[]"]) {
    assert.throws(() => creatorSocketCommand(line), /invalid_creator_socket_command/);
  }
  const source = fs.readFileSync(new URL("./reticulum-local.exs", import.meta.url), "utf8");
  assert.match(source, /if profile == "profile-creator-socket" do[\s\S]*?bots: false,[\s\S]*?ai: false,[\s\S]*?avaturn: true,[\s\S]*?avaturn_creator_url: "https:\/\/virtualmente.avaturn.dev"/);
  assert.match(source, /else\s*Application.put_env\(:ret, Ret.ProductModules, bots: true, ai: true, avaturn: false\)/);
});

function creatorBootstrap() {
  return {
    schema: 1, kind: "reticulum-profile-creator-socket", mode: "creator-only",
    ws_url: "ws://127.0.0.1:18444/socket", browser_origin: "http://127.0.0.1:18443",
    hub_sid: "Local77", auth_token: "local.local.local", backend_pid: 123,
    source: { root: "f".repeat(40), hubs: "d".repeat(40), cloud: "2".repeat(40) },
    app_config_provenance: "Ret.ProductModules.project_config/committed-SQL",
    app_config: { features: { enable_room_bots: false, enable_bot_chat: false, enable_avaturn_creator: true }, links: { avaturn_creator: "https://virtualmente.avaturn.dev" } },
  };
}

test("creator bootstrap rejects extra flags origins types and unbound provenance", () => {
  const value = creatorBootstrap();
  assert.equal(validateCreatorBootstrap(value), value);
  const invalid = [
    v => { v.extra = true; }, v => { delete v.mode; }, v => { v.kind = "reticulum-profile-ui-socket"; },
    v => { v.app_config_provenance = "client-fixture"; }, v => { v.backend_pid = "123"; },
    v => { v.source.root = "unknown"; }, v => { v.source.extra = "f".repeat(40); }, v => { v.auth_token = "invalid"; },
    v => { v.browser_origin = "https://example.com"; }, v => { v.ws_url = "wss://example.com/socket"; },
    v => { v.ws_url = "ws://127.0.0.1:18443/socket"; }, v => { v.ws_url = "ws://127.0.0.1:65536/socket"; },
    v => { v.app_config.links.avaturn_creator = "https://demo.avaturn.dev"; },
    v => { v.app_config.links.avaturn_creator += "/?token=synthetic"; }, v => { v.app_config.links.extra = "https://example.com"; },
    v => { v.app_config.features.enable_room_bots = true; }, v => { v.app_config.features.enable_bot_chat = true; },
    v => { v.app_config.features.enable_avaturn_creator = "true"; }, v => { v.app_config.features.extra = true; },
    v => { v.app_config.features = []; }, v => { delete v.app_config; },
  ];
  for (const mutate of invalid) {
    const value = creatorBootstrap(); mutate(value);
    assert.throws(() => validateCreatorBootstrap(value), /invalid_creator_bootstrap|exact_browser_origin_required/);
  }
  for (const value of [undefined, null, [], 1]) assert.throws(() => validateCreatorBootstrap(value), /invalid_creator_bootstrap/);
});

test("creator browser routes only to the real action consumer and projected public config", () => {
  const wrapper = fs.readFileSync(new URL("./profile-ui-browser.mjs", import.meta.url), "utf8");
  const entry = fs.readFileSync(new URL("./profile-media-browser-entry.js", import.meta.url), "utf8");
  const fixture = fs.readFileSync(new URL("./reticulum-ui-socket.exs", import.meta.url), "utf8");
  assert.match(wrapper, /consumerEntry\s*=\s*\(?connection\)?\s*=>\s*isCreator\(connection\)\s*\?\s*creatorEntry\s*:\s*ownFiles\[1\]/);
  assert.match(wrapper, /auth_token,backend_pid,browser_origin,hub_sid,kind,schema,source,ws_url/);
  assert.match(wrapper, /bootstrap_mode_path_mismatch|bootstrap_consumer_route_mismatch/);
  assert.match(wrapper, /public-app-config.js/);
  assert.match(wrapper, /window.APP_CONFIG = \$\{JSON.stringify\(connection.app_config\)\}/);
  assert.match(wrapper, /frame-src 'none'/);
  assert.match(wrapper, /creator_canary_must_not_include_editor_or_sdk/);
  assert.match(fixture, /Repo.get_by!\(AppConfig, key: "features\|" <> key\)/);
  assert.match(fixture, /Ret.ProductModules.project_config\(%\{"features" => features, "links" => %\{\}\}\)/);
  assert.match(fixture, /AppConfig.set_config_value\("features\|enable_avaturn_creator", enabled\)/);
  assert.doesNotMatch(fixture, /Endpoint\.broadcast\s*\(/);
  assert.match(entry, /import "aframe"/);
  assert.match(entry, /new MediaSearchStore\(\)/);
  assert.match(entry, /MediaBrowserContainer.WrappedComponent/);
  assert.match(entry, /capturedAdmission.current = instance.onCreateAvaturnAvatar/);
  assert.match(entry, /capturedAdmission.current\(\)/);
  assert.match(entry, /missingChannel\s*\.join\(10000\)/);
  assert.match(entry, /deniedChannel\s*\.join\(10000\)/);
  assert.match(entry, /onClick: \(\) => socket.disconnect\(\)/);
  assert.doesNotMatch(entry, /\.trigger\s*\(|configs\.set|dispatchEvent\s*\(|\.setHistory\s*\(|\.fetch\s*\(/);
});

test("creator build keeps backend public config through the normal production mode", () => {
  const wrapper = fs.readFileSync(new URL("./profile-ui-browser.mjs", import.meta.url), "utf8");
  assert.equal(/const buildMode = isCreator\(connection\) \? "production" : "development"/.test(wrapper), true, "creator-only production factory required");
  assert.equal(/require\(path.join\(hubs, "webpack.config.js"\)\)\(\s*\{\},\s*\{ mode: buildMode \}/.test(wrapper), true, "factory and webpack mode must agree");
  assert.equal(/config.mode = buildMode/.test(wrapper), true, "compiled mode must agree");
  assert.doesNotMatch(wrapper, /loadAppConfig:\s*true|localDev:\s*true|fetchAppConfigAndEnvironmentVars\(/);
  assert.match(wrapper, /window.APP_CONFIG = \$\{JSON.stringify\(connection.app_config\)\}/);
});

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

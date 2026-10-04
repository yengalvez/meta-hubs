import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { networkProfile, assertPostmaster, runtimeCases, browserOrigin, uiSocketCommand, creatorSocketCommand, validateCreatorBootstrap, validateNormalGlbBootstrap, compiledCanarySourcePaths, inspectHexArchive, writeUiSocketLog } from "./reticulum-local.mjs";

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
  assert.match(wrapper, /consumerEntry\s*=\s*\(?connection\)?\s*=>\s*isAvaturn\(connection\)\s*\?\s*avaturnEntry\s*:\s*isNormalGlb\(connection\)\s*\?\s*normalGlbEntry\s*:\s*isCreator\(connection\)\s*\?\s*creatorEntry\s*:\s*ownFiles\[1\]/);
  assert.match(wrapper, /const creatorEntry = "tests\/runtime\/profile-media-browser-entry.js"/);
  assert.match(wrapper, /const normalGlbEntry = "tests\/runtime\/profile-glb-editor-entry.js"/);
  assert.match(wrapper, /const ownFiles = \[\s*"tests\/runtime\/profile-ui-browser.mjs",\s*"tests\/runtime\/profile-ui-browser-entry.js"/);
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
  assert.match(wrapper, /const hasCreatorConfig = \(connection\) => isCreator\(connection\) \|\| isNormalGlb\(connection\)/);
  assert.match(wrapper, /const isCreator = \(connection\) =>\s*connection\?\.kind === "reticulum-profile-creator-socket"/);
  assert.match(wrapper, /const isNormalGlb = \(connection\) =>\s*connection\?\.kind === "reticulum-profile-normal-glb"/);
  assert.equal(/const buildMode = hasCreatorConfig\(connection\) \? "production" : "development"/.test(wrapper), true, "backend-config consumers use production; RoomSettings remains development");
  assert.equal(/require\(path.join\(hubs, "webpack.config.js"\)\)\(\s*\{\},\s*\{ mode: buildMode \}/.test(wrapper), true, "factory and webpack mode must agree");
  assert.equal(/config.mode = buildMode/.test(wrapper), true, "compiled mode must agree");
  assert.doesNotMatch(wrapper, /loadAppConfig:\s*true|localDev:\s*true|fetchAppConfigAndEnvironmentVars\(/);
  assert.match(wrapper, /window.APP_CONFIG = \$\{JSON.stringify\(connection.app_config\)\}/);
});

function normalGlbBootstrap() {
  return {
    ...creatorBootstrap(), kind: "reticulum-profile-normal-glb", mode: "normal-glb",
    auth_bootstrap: "local-native-guardian", auth_email: "ui-socket-99@example.invalid", account_id: "784512345678901234",
    reticulum_origin: "http://127.0.0.1:18444", storage_origin: "http://127.0.0.1:18444",
  };
}

test("normal GLB bootstrap preserves the native synthetic schema and origin binding", () => {
  const value = normalGlbBootstrap();
  assert.equal(validateNormalGlbBootstrap(value), value);
  assert.equal(value.reticulum_origin, value.storage_origin);
  assert.equal(value.reticulum_origin, new URL(value.ws_url).origin.replace("ws:", "http:"));
  assert.notEqual(value.reticulum_origin, value.browser_origin);
  assert.throws(() => validateCreatorBootstrap(value), /invalid_creator_bootstrap/);
  assert.throws(() => validateNormalGlbBootstrap(creatorBootstrap()), /invalid_normal_glb_bootstrap/);
});

test("normal GLB bootstrap rejects altered schema credentials origins storage and ports", () => {
  const invalid = [
    v => { v.extra = true; }, v => { delete v.auth_bootstrap; }, v => { v.schema = 2; },
    v => { v.kind = "reticulum-profile-creator-socket"; }, v => { v.mode = "creator-only"; },
    v => { v.auth_bootstrap = "external-OAuth"; }, v => { v.auth_email = "owner@example.com"; },
    v => { v.auth_email = "ui-socket-x@example.invalid"; }, v => { v.auth_email = null; },
    v => { v.account_id = 101; }, v => { v.account_id = 0; }, v => { v.account_id = 1.5; },
    v => { v.account_id = Number.MAX_SAFE_INTEGER + 1; }, v => { v.auth_token = "invalid"; },
    v => { v.auth_token = null; }, v => { v.app_config_provenance = "client-fixture"; },
    v => { v.app_config.features.enable_room_bots = true; }, v => { v.app_config.features.enable_bot_chat = true; },
    v => { v.app_config.features.enable_avaturn_creator = false; },
    v => { v.browser_origin = "http://localhost:18443"; }, v => { v.browser_origin = v.reticulum_origin; },
    v => { v.reticulum_origin = "http://localhost:18444"; }, v => { v.reticulum_origin = "https://127.0.0.1:18444"; },
    v => { v.reticulum_origin = "http://127.0.0.1:18444/"; }, v => { v.reticulum_origin += "?token=synthetic"; },
    v => { v.reticulum_origin = "http://127.0.0.1:18445"; }, v => { v.storage_origin = "http://127.0.0.1:18445"; },
    v => { v.storage_origin = "https://remote.invalid"; },
    v => { v.ws_url = "ws://localhost:18444/socket"; }, v => { v.ws_url = "ws://127.0.0.1:18443/socket"; },
    v => { v.ws_url = "ws://127.0.0.1:65536/socket"; }, v => { v.ws_url = "ws://127.0.0.1:1000/socket"; },
    v => { v.reticulum_origin = "http://127.0.0.1:65536"; }, v => { v.reticulum_origin = "http://127.0.0.1:1000"; },
    v => { v.source.root = "unknown"; }, v => { v.backend_pid = "123"; },
  ];
  for (const mutate of invalid) {
    const value = normalGlbBootstrap(); mutate(value);
    assert.throws(() => validateNormalGlbBootstrap(value), /invalid_normal_glb_bootstrap|invalid_creator_bootstrap|exact_browser_origin_required|normal_glb_endpoint_storage_mismatch/);
  }
  for (const value of [undefined, null, [], 1])
    assert.throws(() => validateNormalGlbBootstrap(value), /invalid_normal_glb_bootstrap/);
});

test("normal GLB account IDs preserve canonical PostgreSQL bigint text without numeric coercion", () => {
  for (const accountId of ["1", "9007199254740993", "784512345678901234", "9223372036854775807"]) {
    const value = normalGlbBootstrap(); value.account_id = accountId;
    const parsed = JSON.parse(JSON.stringify(value));
    assert.equal(validateNormalGlbBootstrap(parsed), parsed);
    assert.equal(parsed.account_id, accountId, "private JSON must preserve every decimal digit");
  }
  assert.ok(BigInt(normalGlbBootstrap().account_id) > 9007199254740992n);
  for (const accountId of [null, undefined, true, 1, 101, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1,
    "", "0", "00", "01", "000101", "+1", "-1", "1e3", "1E3", "1.0", " 1", "1 ", "1\n", "1\r\n", "\t1",
    "9223372036854775808", "9999999999999999999", "18446744073709551615"]) {
    const value = normalGlbBootstrap(); value.account_id = accountId;
    assert.throws(() => validateNormalGlbBootstrap(value), /invalid_normal_glb_bootstrap/);
  }
  const fixture = fs.readFileSync(new URL("./reticulum-ui-socket.exs", import.meta.url), "utf8");
  const avatarView = fs.readFileSync(new URL("../../hubs-cloud/community-edition/services/reticulum/lib/ret_web/views/api/v1/avatar_view.ex", import.meta.url), "utf8");
  const entry = fs.readFileSync(new URL("./profile-glb-editor-entry.js", import.meta.url), "utf8");
  assert.match(fixture, /account_id: Integer.to_string\(account.account_id\)/);
  assert.match(avatarView, /avatar.account_id == account.account_id &&\s*avatar.account_id \|> Integer.to_string\(\)/);
  assert.match(entry, /typeof avatar.account_id === "string" && avatar.account_id === bootstrap.account_id/);
  assert.doesNotMatch(entry, /String\(bootstrap.account_id\)|Number\([^)]*account_id/);
});

test("normal GLB selector reuses the native socket lifecycle without changing existing consumers", () => {
  assert.deepEqual(runtimeCases("--normal-glb-browser"), [{ profile: "profile-creator-socket", count: 0 }]);
  assert.deepEqual(runtimeCases("--profile-creator-socket"), [{ profile: "profile-creator-socket", count: 0 }]);
  assert.deepEqual(runtimeCases("--profile-ui-socket"), [{ profile: "profile-ui-socket", count: 0 }]);
  assert.throws(() => runtimeCases("--normal-glb"), /explicit_native_target_required/);
  const runner = fs.readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
  const fixture = fs.readFileSync(new URL("./reticulum-ui-socket.exs", import.meta.url), "utf8");
  assert.match(runner, /if \(args\[0\] === "--normal-glb-browser"\) env.RET_LOCAL_CONSUMER_ENTRY = "normal-glb"/);
  assert.match(runner, /normalGlb \? "normal-glb-socket-bootstrap.json" : creatorMode \? "creator-socket-bootstrap.json" : "ui-socket-bootstrap.json"/);
  assert.match(fixture, /if normal_glb and not creator_mode, do: raise\("normal GLB requires creator-only native ceiling"\)/);
  assert.match(fixture, /if normal_glb, do: bind_normal_glb_storage!\(work, http_port\)/);
  assert.match(fixture, /RetWeb.Endpoint.url\(\) == native_origin and Process.whereis\(RetWeb.Endpoint\)/);
  assert.match(fixture, /Keyword.put\(:host, native_origin\)/);
  assert.match(fixture, /uri.scheme == "http" and uri.host == "127.0.0.1" and uri.port == http_port/);
  assert.match(runner, /ui_socket_owned_process_still_alive/);
  assert.match(runner, /owned_database_not_stopped/);
});

test("normal GLB native owner lifetime covers finite observation without a sandbox transaction", () => {
  const bootstrap = fs.readFileSync(new URL("./reticulum-local.exs", import.meta.url), "utf8");
  const fixture = fs.readFileSync(new URL("./reticulum-ui-socket.exs", import.meta.url), "utf8");
  const runner = fs.readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
  const ownerConfig = /if profile == "profile-creator-socket" and\s*System.get_env\("RET_LOCAL_CONSUMER_ENTRY"\) in \["normal-glb", "avaturn-save"\] do[\s\S]*?Application.put_env\(\s*:ret,\s*Ret.Repo,\s*Application.fetch_env!\(:ret, Ret.Repo\)\s*\|> Keyword.put\(:ownership_timeout, 120_000 \+ 300_000 \+ 15_000\)\s*\)\s*end/;
  const selected = bootstrap.match(ownerConfig);
  assert.ok(selected, "finite pool override must be guarded by both native profile and selected consumer");
  assert.ok(selected.index < bootstrap.indexOf("Application.ensure_all_started(:ret)"), "owner lifetime must be configured before the Repo pool starts");
  assert.equal((bootstrap.match(/Keyword.put\(:ownership_timeout/g) || []).length, 1, "other native modes must keep their original ownership lifetime");
  assert.match(bootstrap, /if ui_socket do\s*Ecto.Adapters.SQL.Sandbox.mode\(Ret.Repo, :auto\)/);
  assert.doesNotMatch(bootstrap + fixture, /Sandbox.checkout\s*\(|Sandbox.start_owner|\{:shared,|ownership_timeout[^\n]*:infinity/);
  assert.match(runner, /setTimeout\(\(\) => fail\("ui_socket_startup_timeout"\), 120000\)/);
  assert.match(runner, /setTimeout\(\(\) => fail\("ui_socket_observation_deadline"\), 300000\)/);
  assert.match(runner, /setTimeout\(\(\) => fail\("ui_socket_stop_timeout"\), 15000\)/);
  assert.match(fixture, /Application.stop\(:ret\)/);
  assert.match(runner, /owned_database_not_stopped/);
});

test("normal GLB entry uses the real editor preview and native auth API without provider actions", () => {
  const entry = fs.readFileSync(new URL("./profile-glb-editor-entry.js", import.meta.url), "utf8");
  const wrapper = fs.readFileSync(new URL("./profile-ui-browser.mjs", import.meta.url), "utf8");
  for (const file of ["store-instance", "auth-channel", "hub-channel", "phoenix-utils"])
    assert.ok(entry.includes(`import("../../hubs/src/utils/${file}")`), `real ${file} import required`);
  assert.match(entry, /import\("\.\.\/\.\.\/hubs\/src\/react-components\/avatar-editor"\)/);
  assert.match(entry, /await auth.handleAuthCredentials\(bootstrap.auth_email, bootstrap.auth_token\)/);
  assert.match(entry, /window.APP = \{ store \}/);
  assert.match(entry, /React.createElement\(AvatarEditor, \{ key: editor, mode: "private-glb"/);
  assert.match(entry, /response.status !== 401/);
  assert.match(entry, /for \(const token of \[null, "invalid-local-normal-glb-token"\]\)/);
  assert.match(entry, /typeof avatar.account_id === "string" && avatar.account_id === bootstrap.account_id/);
  assert.match(entry, /avatar.allow_promotion === false && avatar.allow_remixing === false/);
  assert.match(entry, /setEditor\(null\)/);
  assert.match(entry, /href: `\/\?avatar_sid=\$\{encodeURIComponent\(saved.sid\)\}`/);
  for (const file of ["avatar-editor.js", "avatar-preview.js", "auth-channel.js", "store-instance.ts", "storage/store.js", "gltf-model-plus.js"])
    assert.ok(wrapper.includes(file), `compiled graph must require ${file}`);
  assert.doesNotMatch(entry, /store\.update\s*\(|configs\.set|dispatchEvent\s*\(|\.trigger\s*\(|\.setState\s*\(|new File\s*\(|createObjectURL\s*\(|loadAvaturnSdk|sdk\.init|acceptCreatorFile|handleGltfLoaded/);
  assert.doesNotMatch(entry, /import\([^)]*(avaturn|avatar-preview|GLTFLoader)[^)]*\)/);
});

test("normal GLB CSP is separate and preserves the WS-only creator guard", () => {
  const wrapper = fs.readFileSync(new URL("./profile-ui-browser.mjs", import.meta.url), "utf8");
  const start = wrapper.indexOf("if (isNormalGlb(connection)) {");
  const end = wrapper.indexOf("if (isCreator(connection))", start);
  assert.ok(start > 0 && end > start);
  const normalPolicy = wrapper.slice(start, end);
  assert.match(wrapper, /connect-src 'none'/);
  assert.match(wrapper, /connect-src \$\{connection.ws_url\}\/websocket/);
  assert.match(normalPolicy, /connect-src 'self' blob: \$\{connection.ws_url\}\/websocket \$\{native\}\/api\/v1\/meta \$\{native\}\/api\/v1\/media \$\{native\}\/api\/v1\/avatars \$\{native\}\/api\/v1\/avatars\/ \$\{native\}\/files\//);
  assert.match(normalPolicy, /worker-src 'self' blob:; object-src 'none'/);
  assert.doesNotMatch(normalPolicy, /https:\/\/|\*|unsafe-eval|unsafe-inline/);
  assert.match(wrapper, /if \(isCreator\(connection\)\) \{\s*for \(const file of \[\s*"hubs\/src\/utils\/avaturn-sdk.js",\s*"hubs\/src\/react-components\/avaturn-creator.js",\s*"hubs\/src\/react-components\/avatar-editor.js",[\s\S]*?creator_canary_must_not_include_editor_or_sdk/);
  assert.match(wrapper, /authBootstrap: "local-native-guardian", externalLogin: "NOT_RUN"/);
  assert.match(wrapper, /browserAcceptance: "NOT_RUN"/);
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
  assert.match(runner, /if \(socketMode \|\| canaryHexCache \|\| restoreMode\) step\("copy-verified-existing-hex-private-home"/);
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

// Purely exercise the real argument/copy/receipt bodies with closed doubles;
// no archive bytes, native process, scratch directory or installer is reached.
const reticulumSource = () => fs.readFileSync(new URL("./reticulum-local.mjs", import.meta.url), "utf8");
const syntheticHex = { directory: "/owned/hex-2.5.1", manifest: "a".repeat(64), files: 133, bytes: 1549651, version: "2.5.1" };
const canaryArgs = ["--sql-http-canary", "--pg-bin", "/owned/pg", "--cache-reticulum", "/owned/ret",
  "--cache-bot-orchestrator", "/owned/bot"];
function canaryHexArguments(args, inspect = value => { assert.equal(value, syntheticHex.directory); return syntheticHex; }) {
  const source = reticulumSource(), start = source.indexOf("    const integrated =");
  const end = source.indexOf("    pgBin = fs.realpathSync(args[2]);", start);
  assert.ok(start >= 0 && end > start, "exact pre-effect argument body required");
  const run = new Function("args", "runtimeCases", "inspectHexArchive", "browserOrigin", "catalogSourceSnapshot", "process", "reject",
    `let cases, socketMode = false, canaryHexCache = false, hexArchive, socketSourceBefore;
    ${source.slice(start, end)} return { cases, socketMode, canaryHexCache, hexArchive };`);
  return run(args, runtimeCases, inspect, browserOrigin, () => { throw new Error("unexpected_source_snapshot"); },
    { platform: "darwin" }, code => { throw new Error(code); });
}

test("SQL HTTP canary Hex opt-in accepts only the exact trailing flag before native effects", () => {
  const source = reticulumSource(), events = [];
  const parsed = canaryHexArguments([...canaryArgs, "--hex-cache", syntheticHex.directory], directory => {
    events.push("inspect"); assert.equal(directory, syntheticHex.directory); return syntheticHex;
  });
  assert.deepEqual(parsed.cases, [{ profile: "sql-http-canary", count: 2 }]);
  assert.equal(parsed.socketMode, false); assert.equal(parsed.canaryHexCache, true);
  assert.equal(parsed.hexArchive, syntheticHex); assert.deepEqual(events, ["inspect"]);
  const inspectAt = source.indexOf("if (canaryHexCache || restoreMode) hexArchive = inspectHexArchive(args[8]);");
  assert.ok(inspectAt >= 0 && inspectAt < source.indexOf("work = fs.mkdtempSync"));
  assert.ok(source.indexOf("work = fs.mkdtempSync") < source.indexOf('step("initialize-private-synthetic-database"'));
  assert.equal(canaryHexArguments(canaryArgs).canaryHexCache, false, "legacy canary stays opt-in");
});

test("SQL HTTP canary Hex rejects partial unknown and other-mode flags before archive access", () => {
  for (const args of [[...canaryArgs, "--hex-cache"], [...canaryArgs, "--unknown", syntheticHex.directory],
    [...canaryArgs, "--hex-cache", ""], [...canaryArgs, "--hex-cache", "--unknown"],
    [...canaryArgs, "--hex-cache", syntheticHex.directory, "--extra"],
    ...["--sql-http-reentry", "--sql-http-stop-drain", "--sql-http-periodic"].map(mode => [mode, ...canaryArgs.slice(1), "--hex-cache", syntheticHex.directory])]) {
    let inspected = false;
    assert.throws(() => canaryHexArguments(args, () => { inspected = true; throw new Error("archive_access_not_allowed"); }), /explicit_native_target_required/);
    assert.equal(inspected, false);
  }
  const first = new Error("injected_archive_manifest_mismatch");
  assert.throws(() => canaryHexArguments([...canaryArgs, "--hex-cache", syntheticHex.directory], () => { throw first; }), error => error === first);
});

function canaryHexCopy(changed) {
  const source = reticulumSource(), copy = source.indexOf('step("copy-verified-existing-hex-private-home"');
  const start = source.lastIndexOf("\n    if (", copy), end = source.indexOf("\n    port = await privatePort", copy);
  assert.ok(copy >= 0 && start >= 0 && end > copy, "existing private-home copy branch required");
  const events = [], archive = "/owned/scratch/mix/archives/hex-2.5.1";
  const run = new Function("socketMode", "canaryHexCache", "step", "path", "work", "fs", "hexArchive", "inspectHexArchive", "reject", "run", "elixir", source.slice(start, end));
  run(false, true, (name, action) => { events.push(name); action(); }, path, "/owned/scratch", {
    mkdirSync(directory, options) { assert.equal(directory, path.dirname(archive)); assert.equal(options.mode, 0o700); },
    cpSync(from, to, options) { assert.equal(from, syntheticHex.directory); assert.equal(to, archive); assert.deepEqual(options, { recursive: true, dereference: false }); events.push("copy"); }
  }, syntheticHex, directory => {
    events.push(directory === archive ? "verify-copy" : "verify-source");
    return { ...syntheticHex, manifest: directory === changed ? "b".repeat(64) : syntheticHex.manifest };
  }, code => { throw new Error(code); }, () => { throw new Error("network_installer_forbidden"); }, "/no-installer");
  return events;
}

test("SQL HTTP canary Hex copies and verifies the existing archive without a network installer", () => {
  assert.deepEqual(canaryHexCopy(), ["copy-verified-existing-hex-private-home", "copy", "verify-copy", "verify-source"]);
  for (const changed of [syntheticHex.directory, "/owned/scratch/mix/archives/hex-2.5.1"])
    assert.throws(() => canaryHexCopy(changed), /hex_archive_changed_during_copy/);
  const guards = reticulumSource().match(/for \(const name of \[("mix\.exs"[^\]]+)\]\) \{/);
  assert.ok(guards); assert.equal(guards[1], '"mix.exs", "mix.lock", "config/config.exs", "config/test.exs", "config/runtime.exs"');
});

test("SQL HTTP canary Hex receipt records verified private archive hash and version", () => {
  const source = reticulumSource(), start = source.indexOf("  const writeReceipt = () => {");
  const end = source.indexOf("  const step =", start);
  assert.ok(start >= 0 && end > start, "existing receipt body required");
  let receipt;
  const run = new Function("fs", "path", "performance", "args", "hexArchive", `
    const work = "/owned/scratch", phase = "terminal", outcome = "PASS", tests = 2, metrics = {}, started = 0;
    const socketMode = false, canaryHexCache = true, catalogSourceBefore = undefined, catalogSourceAfter = undefined;
    ${source.slice(start, end)} writeReceipt();`);
  run({ writeFileSync(file, contents, options) { assert.equal(file, "/owned/scratch/summary.json"); assert.equal(options.mode, 0o600); receipt = JSON.parse(contents); } },
    path, { now: () => 100 }, [...canaryArgs, "--hex-cache", syntheticHex.directory], syntheticHex);
  assert.deepEqual(receipt.hex_archive, { manifest: syntheticHex.manifest, files: 133, bytes: 1549651, version: "2.5.1" });
  assert.equal(receipt.tests, 2); assert.equal(receipt.outcome, "PASS");
  assert.equal(receipt.hex_archive.directory, undefined, "receipt metadata excludes the input path");
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

// Pure harness contract checks only: no bootstrap reads, sockets, SQL, provider
// network, build, browser, fixture mutation or runtime acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runtimeCases, validateCreatorBootstrap, validateNormalGlbBootstrap,
  validateAvaturnBootstrap, avaturnSaveContentSecurityPolicy, compiledCanarySourcePaths } from "./reticulum-local.mjs";

const read = file => fs.readFileSync(new URL(file, import.meta.url), "utf8");
test("Avaturn harness pure contracts are registered in local security and CI without starting runtime", () => {
  const local = read("../../scripts/verify-project.sh");
  const ci = read("../../.github/workflows/project-security.yml");
  for (const name of ["reticulum-avaturn-save.test.mjs", "avaturn-save-sql-boundary.test.mjs"]) {
    assert.equal(local.split(name).length - 1, 1);
    assert.equal(ci.split(name).length - 1, 1);
  }
  assert.match(local, /node --test "\$ROOT_DIR\/tests\/runtime\/reticulum-avaturn-save.test.mjs" "\$ROOT_DIR\/tests\/runtime\/avaturn-save-sql-boundary.test.mjs"/);
  assert.match(ci, /node --test tests\/runtime\/reticulum-avaturn-save.test.mjs tests\/runtime\/avaturn-save-sql-boundary.test.mjs/);
});
function bootstrap() {
  return {
    schema: 1, kind: "reticulum-profile-avaturn-save", mode: "avaturn-save",
    ws_url: "ws://127.0.0.1:18444/socket", browser_origin: "http://127.0.0.1:18443",
    hub_sid: "Local77", auth_token: "local.local.local", backend_pid: 123,
    source: { root: "f".repeat(40), hubs: "d".repeat(40), cloud: "2".repeat(40) },
    app_config_provenance: "Ret.ProductModules.project_config/committed-SQL",
    app_config: { features: { enable_room_bots: false, enable_bot_chat: false, enable_avaturn_creator: true },
      links: { avaturn_creator: "https://virtualmente.avaturn.dev" } },
    auth_bootstrap: "local-native-guardian", auth_email: "ui-socket-99@example.invalid",
    account_id: "9223372036854775807",
    reticulum_origin: "http://127.0.0.1:18444", storage_origin: "http://127.0.0.1:18444",
  };
}

test("Avaturn native save is a distinct zero-test observation with the existing SQL/socket ceiling", () => {
  assert.deepEqual(runtimeCases("--avaturn-save-browser"), [{ profile: "profile-creator-socket", count: 0 }]);
  assert.deepEqual(runtimeCases("--normal-glb-browser"), [{ profile: "profile-creator-socket", count: 0 }]);
  assert.deepEqual(runtimeCases("--profile-creator-socket"), [{ profile: "profile-creator-socket", count: 0 }]);
  for (const mode of ["--avaturn-save", "--avaturn-browser", "--all"])
    assert.throws(() => runtimeCases(mode), /explicit_native_target_required/);
  const runner = read("./reticulum-local.mjs"), fixture = read("./reticulum-ui-socket.exs");
  assert.match(runner, /if \(args\[0\] === "--avaturn-save-browser"\) env.RET_LOCAL_CONSUMER_ENTRY = "avaturn-save"/);
  assert.match(runner, /avaturnSave \? "avaturn-save-socket-bootstrap.json" : normalGlb \? "normal-glb-socket-bootstrap.json"/);
  assert.match(runner, /browser_acceptance: "NOT_RECORDED"/);
  assert.match(runner, /outcome = socketMode \? "OBSERVATION_STOPPED" : "PASS"/);
  assert.match(fixture, /avaturn_save -> "avaturn-save-socket-bootstrap.json"/);
  assert.match(fixture, /if avaturn_save and not creator_mode/);
  assert.match(fixture, /if avaturn_save, do: bind_normal_glb_storage!\(work, http_port\)/);
  assert.match(fixture, /kind: "reticulum-profile-avaturn-save", mode: "avaturn-save"/);
  assert.match(fixture, /account_id: Integer.to_string\(account.account_id\)/);
  assert.match(fixture, /AppConfig.set_config_value\("features\|enable_avaturn_creator", enabled\)/);
  assert.doesNotMatch(fixture, /Endpoint\.broadcast\s*\(|LOCK TABLE|pg_sleep|HTTPoison/);
});

test("Avaturn bootstrap has the same exact private native contract without aliasing old validators", () => {
  const value = bootstrap();
  assert.equal(validateAvaturnBootstrap(value), value);
  assert.throws(() => validateCreatorBootstrap(value), /invalid_creator_bootstrap/);
  assert.throws(() => validateNormalGlbBootstrap(value), /invalid_normal_glb_bootstrap/);
  const normal = { ...value, kind: "reticulum-profile-normal-glb", mode: "normal-glb" };
  assert.equal(validateNormalGlbBootstrap(normal), normal);
  assert.throws(() => validateAvaturnBootstrap(normal), /invalid_avaturn_save_bootstrap/);
  const invalid = [
    v => { v.extra = true; }, v => { delete v.auth_bootstrap; }, v => { v.schema = 2; },
    v => { v.kind = "reticulum-profile-creator-socket"; }, v => { v.mode = "normal-glb"; },
    v => { v.auth_bootstrap = "external-OAuth"; }, v => { v.auth_email = "owner@example.com"; },
    v => { v.account_id = 9223372036854775807; }, v => { v.account_id = "9223372036854775808"; },
    v => { v.account_id = "01"; }, v => { v.auth_token = "invalid"; },
    v => { v.app_config.features.enable_room_bots = true; }, v => { v.app_config.features.enable_bot_chat = true; },
    v => { v.app_config.features.enable_avaturn_creator = false; },
    v => { v.app_config.links.avaturn_creator = "https://preview.avaturn.dev"; },
    v => { v.app_config.links.avaturn_creator += "/?token=x"; },
    v => { v.browser_origin = "http://localhost:18443"; }, v => { v.browser_origin = v.reticulum_origin; },
    v => { v.ws_url = "wss://virtualmente.avaturn.dev/socket"; },
    v => { v.reticulum_origin = "http://127.0.0.1:18445"; },
    v => { v.storage_origin = "https://remote.invalid"; },
    v => { v.source.root = "unknown"; }, v => { v.backend_pid = "123"; },
  ];
  for (const mutate of invalid) {
    const value = bootstrap(); mutate(value);
    assert.throws(() => validateAvaturnBootstrap(value), /invalid_avaturn_save_bootstrap|invalid_normal_glb_bootstrap|invalid_creator_bootstrap|exact_browser_origin_required|normal_glb_endpoint_storage_mismatch/);
  }
  for (const value of [undefined, null, [], 1])
    assert.throws(() => validateAvaturnBootstrap(value), /invalid_avaturn_save_bootstrap/);
});

test("Avaturn CSP permits only the owned provider frame and closes external export/download origins", () => {
  const value = bootstrap();
  const policy = avaturnSaveContentSecurityPolicy(value);
  const directives = Object.fromEntries(policy.split("; ").map(part => {
    const [name, ...sources] = part.split(" "); return [name, sources];
  }));
  assert.deepEqual(directives["frame-src"], ["https://virtualmente.avaturn.dev"]);
  assert.deepEqual(directives["connect-src"], ["'self'", "blob:", `${value.ws_url}/websocket`,
    ...["/api/v1/meta", "/api/v1/media", "/api/v1/avatars", "/api/v1/avatars/", "/files/"].map(p => value.reticulum_origin + p)]);
  assert.deepEqual(directives["script-src"], ["'self'"]);
  assert.deepEqual(directives["img-src"], ["'self'", "data:", "blob:", `${value.reticulum_origin}/files/`]);
  assert.deepEqual(directives["worker-src"], ["'self'", "blob:"]);
  for (const name of ["object-src", "base-uri", "form-action"]) assert.deepEqual(directives[name], ["'none'"]);
  assert.equal((policy.match(/https:\/\//g) || []).length, 1);
  assert.doesNotMatch(policy, /\*|demo\.|preview\.|assets\.avaturn\.me|unsafe-eval|connect-src[^;]*https:/);
  assert.throws(() => avaturnSaveContentSecurityPolicy({ ...value, storage_origin: "https://remote.invalid" }), /normal_glb_endpoint_storage_mismatch/);
});

test("new build route requires compiled real creator and installed pinned SDK without weakening MediaBrowser", () => {
  const wrapper = read("./profile-ui-browser.mjs");
  assert.match(wrapper, /isAvaturn\(connection\) \? avaturnEntry : isNormalGlb\(connection\) \? normalGlbEntry : isCreator\(connection\) \? creatorEntry : ownFiles\[1\]/);
  assert.match(wrapper, /const avaturnEntry = "tests\/runtime\/profile-avaturn-editor-entry.js"/);
  assert.match(wrapper, /const sdkEntry = "hubs\/node_modules\/@avaturn\/sdk\/dist\/index.js"/);
  assert.match(wrapper, /manifest.version !== "1.1.4"/);
  assert.match(wrapper, /declared.dependencies\?\.\["@avaturn\/sdk"\] !== "1.1.4"/);
  assert.match(wrapper, /lock.packages\?\.\["node_modules\/@avaturn\/sdk"\]\?\.version !== "1.1.4"/);
  assert.match(wrapper, /avaturn_sdk_changed_before_build/);
  assert.match(wrapper, /avaturn_sdk_changed_during_build/);
  assert.match(wrapper, /avaturn_sdk_changed_before_serve/);
  assert.match(wrapper, /if \(sdkBefore\) for \(const source of sdkBefore.sources\) sourcePaths.add\(source.path\)/);
  assert.match(wrapper, /if \(isAvaturn\(connection\)\) \{\s*for \(const file of \[\s*"hubs\/src\/react-components\/avaturn-creator.js",\s*"hubs\/src\/utils\/avaturn-sdk.js",\s*"hubs\/src\/utils\/avaturn-utils.js",\s*sdkEntry,[\s\S]*?real_avaturn_sdk_consumer_missing_from_build/);
  assert.match(wrapper, /if \(isCreator\(connection\)\) \{\s*for \(const file of \[\s*"hubs\/src\/utils\/avaturn-sdk.js",\s*"hubs\/src\/react-components\/avaturn-creator.js",\s*"hubs\/src\/react-components\/avatar-editor.js",[\s\S]*?creator_canary_must_not_include_editor_or_sdk/);
  assert.match(wrapper, /if \(isAvaturn\(connection\)\) \{[\s\S]*?avaturnSaveContentSecurityPolicy\(connection\)/);
  assert.match(wrapper, /externalExportDownload: "NOT_ALLOWLISTED"/);
  assert.match(wrapper, /browser_acceptance: "NOT_RECORDED"/);
  const root = path.resolve("/synthetic-canary-root"), sdk = "hubs/node_modules/@avaturn/sdk/dist/index.js";
  assert.deepEqual(compiledCanarySourcePaths({ modules: new Set([{ resource: path.join(root, sdk) + "?sdk" }]) }, root, new Set([sdk])), [sdk]);
});

test("real AvatarEditor mode avaturn uses native auth/socket and observes rather than injecting export or revocation", () => {
  const entry = read("./profile-avaturn-editor-entry.js");
  assert.match(entry, /await auth.handleAuthCredentials\(bootstrap.auth_email, bootstrap.auth_token\)/);
  assert.match(entry, /window.APP = \{ store \}/);
  assert.match(entry, /hub.setChannel\(transport\)/);
  assert.match(entry, /React.createElement\(AvatarEditor, \{ key: editor, mode: editor === "new" \? "avaturn" : "private-glb"/);
  assert.match(entry, /callbacks: previous.callbacks \+ 1/);
  assert.match(entry, /typeof avatar.account_id === "string" && avatar.account_id === bootstrap.account_id/);
  assert.match(entry, /avatar.allow_promotion === false && avatar.allow_remixing === false && avatar.has_listings === false/);
  assert.match(entry, /href: `\/\?avatar_sid=\$\{encodeURIComponent\(saved.sid\)\}`/);
  assert.match(entry, /onClick: \(\) => socket.disconnect\(\)/);
  assert.match(entry, /editor && status.join === "JOINED" && React.createElement/);
  assert.doesNotMatch(entry, /status.creator ===|status.socket ===|\.trigger\s*\(|configs\.set|dispatchEvent\s*\(|store\.update\s*\(|\.setState\s*\(|new File\s*\(|createObjectURL\s*\(|acceptCreatorFile|handleAvaturnExportStart|sdk\.(init|on|exportAvatar)|fetch\s*\(/);
  assert.doesNotMatch(entry, /import\([^)]*(avaturn-sdk|avatar-preview|GLTFLoader)[^)]*\)/);
  assert.match(entry, /new URL\(event.blockedURI\).origin/);
  // The mount relies on the unchanged production wiring for the real SDK.
  const editor = read("../../hubs/src/react-components/avatar-editor.js"), creator = read("../../hubs/src/react-components/avaturn-creator.js");
  assert.match(editor, /<AvaturnCreator\s*creatorUrl=\{avaturnCreatorUrl\}/);
  assert.match(creator, /const sdk = await loadAvaturnSdk\(creatorUrl\)/);
  assert.match(creator, /sdk.on\("export", result =>/);
});

test("SID reload edits the existing native avatar without mounting a new creator or SDK session", () => {
  const entry = read("./profile-avaturn-editor-entry.js");
  assert.match(entry, /useState\(initialSid === null \? "new" : initialSid\)/);
  assert.match(entry, /React.createElement\(AvatarEditor, \{ key: editor, mode: editor === "new" \? "avaturn" : "private-glb", \.\.\.\(editor === "new" \? \{\} : \{ avatarId: editor \}\)/);
  assert.doesNotMatch(entry, /mode: "avaturn"|mode: "creator"|React.createElement\(AvaturnCreator|sdk\.(init|exportAvatar)|loadAvaturnSdk/);
  // With the existing SID and private-glb mode, the real product loads from
  // API; its provider mount and module-OFF unavailable view are Avaturn-only.
  const product = read("../../hubs/src/react-components/avatar-editor.js");
  assert.match(product, /if \(this.props.avatarId\) \{\s*const avatar = await fetchAvatar\(this.props.avatarId\)/);
  assert.match(product, /const isAvaturnMode = this.props.mode === "avaturn"/);
  assert.match(product, /if \(isAvaturnMode && !this.isAvaturnEnabled\(\)\)/);
  assert.match(product, /\) : isAvaturnMode \? \(\s*<AvaturnCreator/);
});

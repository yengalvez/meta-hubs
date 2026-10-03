// Opt-in, macOS-only native backend sample. No provider, production DB,
// Kubernetes, restore or profile/deployment acceptance is implied by this test.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareCatalogDataset } from "./catalog-dataset.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const relativeRet = "community-edition/services/reticulum";
const cloud = path.join(root, "hubs-cloud");
const source = path.join(cloud, relativeRet);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const reject = code => { throw new Error(code); };
const hexManifest = "68883cfc9367253fe7cf762a68c588013023d2a9985aa847083203801fcb861d";

export function browserOrigin(value) {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(value)) reject("exact_browser_origin_required");
  let url;
  try { url = new URL(value); } catch { reject("exact_browser_origin_required"); }
  if (url.origin !== value || Number(url.port) < 1024 || Number(url.port) > 65535) reject("exact_browser_origin_required");
  return value;
}

export function uiSocketCommand(line) {
  if (typeof line !== "string" || Buffer.byteLength(line) > 128 ||
      !/^\s*\{\s*"command"\s*:\s*"(BASE|BOTS_AI|STOP)"\s*\}\s*$/.test(line)) reject("invalid_ui_socket_command");
  return JSON.parse(line).command;
}

export function creatorSocketCommand(line) {
  if (typeof line !== "string" || Buffer.byteLength(line) > 128 ||
      !/^\s*\{\s*"command"\s*:\s*"(CREATOR_OFF|CREATOR_ON|STOP)"\s*\}\s*$/.test(line)) reject("invalid_creator_socket_command");
  return JSON.parse(line).command;
}

export function compiledCanarySourcePaths(compilation, root, sourcePaths) {
  if (!compilation?.modules || typeof compilation.modules[Symbol.iterator] !== "function" ||
      !path.isAbsolute(root) || !(sourcePaths instanceof Set)) reject("invalid_canary_module_graph");
  const seen = new Set(), files = new Set();
  const visit = module => {
    if (!module || typeof module !== "object" || seen.has(module)) return;
    seen.add(module);
    if (typeof module.resource === "string" && path.isAbsolute(module.resource)) {
      // Webpack includes loader queries/fragments in resource; compare the
      // actual source pathname, not a checker dependency or decorated identifier.
      const resourcePath = module.resource.split(/[?#]/, 1)[0];
      const relative = path.relative(root, resourcePath).split(path.sep).join("/");
      if (sourcePaths.has(relative)) files.add(relative);
    }
    if (module.modules && typeof module.modules[Symbol.iterator] === "function")
      for (const nested of module.modules) visit(nested);
  };
  for (const module of compilation.modules) visit(module);
  return [...files].sort();
}

export function validateCreatorBootstrap(value) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value, expected) => object(value) && Object.keys(value).sort().join(",") === expected;
  if (!keys(value, "app_config,app_config_provenance,auth_token,backend_pid,browser_origin,hub_sid,kind,mode,schema,source,ws_url") ||
      value.schema !== 1 || value.kind !== "reticulum-profile-creator-socket" || value.mode !== "creator-only" ||
      value.app_config_provenance !== "Ret.ProductModules.project_config/committed-SQL" ||
      !keys(value.source, "cloud,hubs,root") || !Object.values(value.source).every(head => typeof head === "string" && /^[a-f0-9]{40}$/.test(head)) ||
      typeof value.hub_sid !== "string" || !/^[A-Za-z0-9]{7}$/.test(value.hub_sid) ||
      typeof value.auth_token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.auth_token) ||
      !Number.isInteger(value.backend_pid) || value.backend_pid < 2 ||
      typeof value.ws_url !== "string" || !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/socket$/.test(value.ws_url) ||
      !keys(value.app_config, "features,links") ||
      !keys(value.app_config.features, "enable_avaturn_creator,enable_bot_chat,enable_room_bots") ||
      value.app_config.features.enable_room_bots !== false || value.app_config.features.enable_bot_chat !== false ||
      value.app_config.features.enable_avaturn_creator !== true ||
      !keys(value.app_config.links, "avaturn_creator") || value.app_config.links.avaturn_creator !== "https://virtualmente.avaturn.dev") reject("invalid_creator_bootstrap");
  browserOrigin(value.browser_origin);
  let ws;
  try { ws = new URL(value.ws_url); } catch { reject("invalid_creator_bootstrap"); }
  const port = Number(ws.port);
  if (port < 1024 || port > 65535 || port === Number(new URL(value.browser_origin).port)) reject("invalid_creator_bootstrap");
  return value;
}

export function validateNormalGlbBootstrap(value) {
  // Ret account IDs are PostgreSQL int64 values, not JavaScript safe integers.
  // Canonical decimal text preserves every bit across the private JSON boundary.
  const accountId = value?.account_id;
  const validAccountId = typeof accountId === "string" && /^[1-9][0-9]{0,18}$/.test(accountId) &&
    BigInt(accountId).toString() === accountId && BigInt(accountId) <= 9223372036854775807n;
  if (!value || Object.keys(value).sort().join(",") !==
      "account_id,app_config,app_config_provenance,auth_bootstrap,auth_email,auth_token,backend_pid,browser_origin,hub_sid,kind,mode,reticulum_origin,schema,source,storage_origin,ws_url" ||
      value.kind !== "reticulum-profile-normal-glb" || value.mode !== "normal-glb" ||
      value.auth_bootstrap !== "local-native-guardian" ||
      !validAccountId ||
      typeof value.auth_email !== "string" || !/^ui-socket-[0-9]+@example\.invalid$/.test(value.auth_email)) reject("invalid_normal_glb_bootstrap");
  const { account_id, auth_email, auth_bootstrap, reticulum_origin, storage_origin, ...creator } = value;
  validateCreatorBootstrap({ ...creator, kind: "reticulum-profile-creator-socket", mode: "creator-only" });
  browserOrigin(reticulum_origin);
  if (reticulum_origin !== new URL(value.ws_url).origin.replace("ws:", "http:") ||
      storage_origin !== reticulum_origin) reject("normal_glb_endpoint_storage_mismatch");
  return value;
}

export function inspectHexArchive(directory) {
  const actual = fs.realpathSync(directory);
  if (actual !== path.resolve(directory)) reject("hex_archive_symlink_not_allowed");
  const rows = [];
  const walk = (file, relative) => {
    const stat = fs.lstatSync(file);
    if (stat.uid !== process.getuid() || stat.isSymbolicLink()) reject("unowned_hex_archive");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) walk(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) rows.push({ path: relative, sha256: sha(fs.readFileSync(file)), bytes: stat.size });
    else reject("hex_archive_not_regular");
  };
  walk(actual, "");
  if (!/\{vsn,\s*"2\.5\.1"\}/.test(fs.readFileSync(path.join(actual, "hex-2.5.1/ebin/hex.app"), "utf8"))) reject("hex_archive_version_mismatch");
  rows.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const manifest = sha(rows.map(row => `${row.path}\0${row.sha256}\0${row.bytes}\n`).join(""));
  if (manifest !== hexManifest || rows.length !== 133 || rows.reduce((total, row) => total + row.bytes, 0) !== 1549651) reject("hex_archive_manifest_mismatch");
  return { directory: actual, manifest, files: rows.length, bytes: 1549651, version: "2.5.1" };
}

async function privatePort(excluded = []) {
  const chosen = await new Promise((resolve, fail) => {
    const server = net.createServer(); server.once("error", fail);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = server.address().port;
      server.close(error => error ? fail(error) : resolve(port));
    });
  });
  return excluded.includes(chosen) ? privatePort(excluded) : chosen;
}

export function writeUiSocketLog(log, bytes, onFailure) {
  try { fs.writeSync(log, bytes); return true; }
  catch { onFailure("ui_socket_private_log_write_failed"); return false; }
}

// This is a finite observation handle, not an ExUnit/browser acceptance gate.
async function observeUiSocket({ root, work, log, env, application, pgPort, mix }) {
  const creatorMode = env.RET_LOCAL_PROFILE === "profile-creator-socket";
  const normalGlb = env.RET_LOCAL_CONSUMER_ENTRY === "normal-glb";
  const commandParser = creatorMode ? creatorSocketCommand : uiSocketCommand;
  const profiles = creatorMode ? ["CREATOR_OFF", "CREATOR_ON"] : ["BASE", "BOTS_AI"];
  const child = spawn("/usr/bin/sandbox-exec", ["-p", networkProfile(pgPort), mix, "run", "--no-start", "--no-compile",
    path.join(root, "tests/runtime/reticulum-local.exs")], { cwd: application, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let ready = false, stopped = false, stopRequested = false, backendPid, failure, input = "", output = "";
  const fail = code => {
    if (failure) return;
    failure = code;
    if (!child.stdin.destroyed) child.stdin.end();
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") failure = "ui_socket_signal_failed"; }
  };
  let deadline = setTimeout(() => fail("ui_socket_startup_timeout"), 120000);
  const onInput = bytes => {
    input += bytes.toString("utf8");
    if (Buffer.byteLength(input) > 1024) return fail("invalid_ui_socket_command");
    while (input.includes("\n")) {
      const index = input.indexOf("\n"), line = input.slice(0, index); input = input.slice(index + 1);
      try {
        const command = commandParser(line);
        if (!ready || stopRequested) reject("ui_socket_not_accepting_commands");
        child.stdin.write(JSON.stringify({ command }) + "\n");
        if (command === "STOP") { stopRequested = true; child.stdin.end(); clearTimeout(deadline); deadline = setTimeout(() => fail("ui_socket_stop_timeout"), 15000); }
      } catch (error) { fail(error.message); }
    }
  };
  const onEof = () => { if (!stopRequested) fail("ui_socket_input_eof_without_stop"); };
  const onSignal = () => fail("ui_socket_observation_interrupted");
  const onOutputError = () => fail("ui_socket_output_pipe_failed");
  process.stdin.on("data", onInput); process.stdin.once("end", onEof);
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  process.stdout.on("error", onOutputError);
  child.stdin.on("error", () => fail("ui_socket_input_pipe_failed"));
  child.stderr.on("data", bytes => writeUiSocketLog(log, bytes, fail));
  child.stdout.on("data", bytes => {
    if (!writeUiSocketLog(log, bytes, fail)) return;
    output += bytes.toString("utf8");
    if (Buffer.byteLength(output) > 65536) return fail("ui_socket_output_not_framed");
    while (output.includes("\n")) {
      const index = output.indexOf("\n"), line = output.slice(0, index); output = output.slice(index + 1);
      if (!line.startsWith("RET_UI_SOCKET:")) continue;
      try {
        const event = JSON.parse(line.slice("RET_UI_SOCKET:".length));
        if (event.phase === "READY" && Object.keys(event).sort().join(",") === "bootstrap,phase,pid" &&
            event.bootstrap === path.join(work, normalGlb ? "normal-glb-socket-bootstrap.json" : creatorMode ? "creator-socket-bootstrap.json" : "ui-socket-bootstrap.json") && Number.isInteger(event.pid) && event.pid > 1 && !ready) {
          backendPid = event.pid; ready = true; clearTimeout(deadline);
          deadline = setTimeout(() => fail("ui_socket_observation_deadline"), 300000);
        } else if (event.phase === "SQL_APPLIED" && Object.keys(event).sort().join(",") === "phase,profile" && profiles.includes(event.profile) && ready) {
          // No browser assertion is inferred from committed wrappers.
        } else if (event.phase === "STOPPED" && Object.keys(event).join(",") === "phase" && stopRequested) stopped = true;
        else reject("invalid_ui_socket_marker");
        process.stdout.write(`RET_UI_SOCKET:${JSON.stringify(event)}\n`);
      } catch { fail("invalid_ui_socket_marker"); }
    }
  });
  let killTimer;
  const pollFailure = setInterval(() => {
    if (failure && !killTimer) killTimer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failure = "ui_socket_kill_failed"; }
    }, 5000);
  }, 100);
  let code, signal;
  try {
    [code, signal] = await new Promise((resolve, fail) => { child.once("error", fail); child.once("close", (...result) => resolve(result)); });
  } finally {
    clearTimeout(deadline); clearTimeout(killTimer); clearInterval(pollFailure);
    process.stdin.off("data", onInput); process.stdin.off("end", onEof); process.stdin.pause();
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    process.stdout.off("error", onOutputError);
  }
  for (const pid of new Set([child.pid, backendPid].filter(Boolean))) {
    try { process.kill(pid, 0); reject("ui_socket_owned_process_still_alive"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  if (failure || code !== 0 || signal || !ready || !stopRequested || !stopped) reject(failure || "ui_socket_observation_not_stopped");
  return { status: "OBSERVATION_STOPPED", backend_pid: backendPid, cleanup_pid_absent: true, browser_acceptance: "NOT_RECORDED" };
}

export function runtimeCases(mode) {
  switch (mode) {
    case "--run": return [{ profile: "existing-tests", count: 5 }];
    case "--profile-ui-socket": return [{ profile: "profile-ui-socket", count: 0 }];
    case "--profile-creator-socket": return [{ profile: "profile-creator-socket", count: 0 }];
    // Keep the existing native SQL/socket lifecycle; select only a new consumer.
    case "--normal-glb-browser": return [{ profile: "profile-creator-socket", count: 0 }];
    case "--avaturn-runtime": return [{ profile: "avaturn-runtime", count: 5 }];
    case "--profiles": return ["base", "base-avaturn", "bots", "bots-avaturn", "bots-ai", "bots-ai-avaturn"].map(profile => ({ profile, count: 1 }));
    case "--chat-canary": return [{ profile: "chat-canary", count: 2 }];
    case "--chat-boundaries": return [{ profile: "chat-boundaries", count: 5 }];
    case "--chat-concurrent": return [{ profile: "chat-concurrent", count: 2 }];
    case "--chat-concurrent-boundaries": return [{ profile: "chat-concurrent-boundaries", count: 4 }];
    case "--sql-http-canary": return [{ profile: "sql-http-canary", count: 2 }];
    case "--sql-http-reentry": return [{ profile: "sql-http-reentry", count: 1 }];
    case "--sql-http-stop-drain": return [{ profile: "sql-http-stop-drain", count: 2 }];
    case "--sql-http-periodic": return [{ profile: "sql-http-periodic", count: 1 }];
    case "--catalog-dataset": return [{ profile: "catalog-dataset", count: 1 }];
    case "--catalog-graph-dataset": return [{ profile: "catalog-graph-dataset", count: 1 }];
    case "--config-cache-canary": return [{ profile: "config-cache-canary", count: 2 }];
    case "--config-cache-boundaries": return [{ profile: "config-cache-boundaries", count: 4 }];
    case "--config-cache-types": return [{ profile: "config-cache-types", count: 1 }];
    default: reject("explicit_native_target_required");
  }
}

export function networkProfile(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) reject("invalid_private_port");
  // SBPL accepts localhost, not a numeric address. This exact-port rule was
  // proved against two listening TCP peers; the denied peer received no data.
  // Mix 1.18 owns loopback listeners for its compiler lock/PubSub. Permit
  // local binding/accept only; this does NOT allow calls to other local ports.
  return `(version 1)(allow default)(deny network*)(allow network-bind(local ip "localhost:*"))(allow network-inbound(local ip "localhost:*"))(allow network-outbound(remote ip "localhost:${port}"))`;
}

export function assertPostmaster(work, data, port, epoch) {
  const pidFile = path.join(data, "postmaster.pid"), stat = fs.lstatSync(pidFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) reject("unowned_postmaster");
  const fields = fs.readFileSync(pidFile, "utf8").split("\n");
  const pid = Number(fields[0]);
  if (!Number.isInteger(pid) || pid < 2 || fields[1] !== data ||
      Number(fields[2]) < epoch || Number(fields[3]) !== port ||
      fields[4] !== path.join(work, "socket") || fields[5] !== "127.0.0.1") reject("postmaster_identity_mismatch");
  process.kill(pid, 0);
  return pid;
}

async function main() {
  const args = process.argv.slice(2);
  let cases;
  let work, log, env, data, pgBin, port, epoch, attempted = false, identity;
  let phase = "arguments", outcome = "FAIL", tests = 0;
  const metrics = {}, started = performance.now();
  let catalog, catalogSourceBefore, catalogSourceAfter, socketMode = false, socketSourceBefore, socketSourceAfter, hexArchive;
  const catalogSourceSnapshot = () => Object.fromEntries([".", "hubs", "hubs-cloud"].map(name => {
    const repository = path.join(root, name);
    const read = args => {
      const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } });
      if (result.error || result.signal || result.status !== 0) reject("catalog_source_read_failed");
      return result.stdout.trim();
    };
    if (read(["status", "--porcelain=v1", "--untracked-files=normal"]) !== "") reject("catalog_source_not_clean");
    return [name, read(["rev-parse", "HEAD"])];
  }));
  const writeReceipt = () => {
    if (work) fs.writeFileSync(path.join(work, "summary.json"), JSON.stringify({
      scope: "native-synthetic-reticulum-not-kubernetes-or-production", phase,
      outcome, tests, metrics, elapsed_ms: Math.round(performance.now() - started),
      ...(socketMode ? { mode: args[0].slice(2), browser_acceptance: "NOT_RECORDED", full_acceptance: false,
        socket_source_before: socketSourceBefore, socket_source_after: socketSourceAfter,
        hex_archive: hexArchive && { manifest: hexArchive.manifest, files: hexArchive.files, bytes: hexArchive.bytes, version: hexArchive.version } } : {}),
      ...(catalogSourceBefore ? { catalog_source_before: catalogSourceBefore, catalog_source_after: catalogSourceAfter } : {})
    }, null, 2) + "\n", { mode: 0o600 });
  };
  const step = (name, action) => {
    phase = name; writeReceipt(); process.stdout.write(`RET_LOCAL_STAGE:${name}\n`);
    const before = performance.now();
    try { return action(); } finally { metrics[name] = Math.round(performance.now() - before); writeReceipt(); }
  };
  const run = (command, argv, options = {}) => {
    const result = spawnSync(command, argv, { env, cwd: options.cwd || work,
      encoding: "utf8", timeout: options.timeout || 120000, maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", options.capture ? "pipe" : options.discardLog ? "ignore" : log,
        options.discardLog ? "ignore" : log] });
    if (result.error || result.signal || result.status !== 0) reject(`command_failed_${phase}`);
    return result.stdout || "";
  };
  try {
    const integrated = ["--sql-http-canary", "--sql-http-reentry", "--sql-http-stop-drain", "--sql-http-periodic"].includes(args[0]);
    const catalogMode = ["--catalog-dataset", "--catalog-graph-dataset"].includes(args[0]);
    socketMode = ["--profile-ui-socket", "--profile-creator-socket", "--normal-glb-browser"].includes(args[0]);
    if (args.length !== (socketMode ? 9 : integrated || catalogMode ? 7 : 5) || args[1] !== "--pg-bin" || args[3] !== "--cache-reticulum" ||
        (integrated && args[5] !== "--cache-bot-orchestrator") ||
        (catalogMode && args[5] !== "--catalog-receipts") ||
        (socketMode && (args[5] !== "--browser-origin" || args[7] !== "--hex-cache")) ||
        process.platform !== "darwin") reject("explicit_native_target_required");
    cases = runtimeCases(args[0]);
    if (socketMode) {
      browserOrigin(args[6]); hexArchive = inspectHexArchive(args[8]);
      socketSourceBefore = catalogSourceSnapshot();
      if (socketSourceBefore.hubs !== "dd176f6ed318ffc724efcd930803ca972058e782" ||
          socketSourceBefore["hubs-cloud"] !== "2c0b53d591d5547438812d27507bc1b3e1ae6f41") reject("ui_socket_source_not_frozen");
    }
    pgBin = fs.realpathSync(args[2]); const cache = fs.realpathSync(args[4]);
    for (const name of ["mix.exs", "mix.lock", "config/config.exs", "config/test.exs", "config/runtime.exs"]) {
      if (sha(fs.readFileSync(path.join(source, name))) !== sha(fs.readFileSync(path.join(cache, name)))) reject("cache_source_mismatch");
    }
    for (const name of ["initdb", "pg_ctl", "psql", "postgres", ...(catalogMode ? ["pg_dump"] : [])]) fs.accessSync(path.join(pgBin, name), fs.constants.X_OK);
    fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
    const erlang = "/Users/yengalvez/.local/share/mise/installs/erlang/27.3.4.14/bin";
    const elixir = "/Users/yengalvez/.local/share/mise/installs/elixir/1.18.4-otp-27/bin";
    fs.accessSync(path.join(elixir, "mix"), fs.constants.X_OK);
    work = fs.mkdtempSync("/private/tmp/ynret-local-"); fs.chmodSync(work, 0o700);
    if (catalogMode) {
      catalogSourceBefore = catalogSourceSnapshot();
      catalog = step("prepare-approved-catalog-private-input", () => prepareCatalogDataset({ root, work, receiptsPath: args[6],
        includeGraph: args[0] === "--catalog-graph-dataset" }));
    }
    for (const name of ["home", "socket", "mix", "hex"]) fs.mkdirSync(path.join(work, name), { mode: 0o700 });
    log = fs.openSync(path.join(work, "private.log"), "wx", 0o600);
    // No inherited DB/PG/service/password/provider variables or user Mix home.
    env = { PATH: `${elixir}:${erlang}:${pgBin}:/opt/homebrew/bin:/usr/bin:/bin`, HOME: path.join(work, "home"),
      LC_ALL: "C", LANG: "C", TZ: "UTC", TMPDIR: work, MIX_ENV: "test", HEX_OFFLINE: "1",
      MIX_HOME: path.join(work, "mix"), HEX_HOME: path.join(work, "hex"),
      ERL_FLAGS: "+S 4:4", DB_HOST: "127.0.0.1", DB_CREDENTIALS: "unusable-before-local-override" };
    let catalogPostgresVersion;
    if (catalogMode) {
      catalogPostgresVersion = run(path.join(pgBin, "postgres"), ["--version"], { capture: true }).trim();
      if (!/^postgres \(PostgreSQL\) 14\./.test(catalogPostgresVersion)) reject("catalog_native_major14_required");
    }
    const application = path.join(work, "reticulum"); fs.mkdirSync(application, { mode: 0o700 });
    step("materialize-owned-source-and-cache", () => {
      const list = run("/usr/bin/git", ["-C", cloud, "ls-files", "-z", "--", relativeRet], { capture: true }).split("\0").filter(Boolean);
      if (!list.includes(`${relativeRet}/mix.lock`)) reject("missing_tracked_source");
      for (const file of list) {
        const relative = file.slice(relativeRet.length + 1), input = path.join(cloud, file), output = path.join(application, relative);
        if (!relative || relative.startsWith("../") || !fs.lstatSync(input).isFile()) reject("unsafe_tracked_source");
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.copyFileSync(input, output);
      }
      // Materialize dependency links within an owned scratch; never compile
      // through links into the frozen candidate. Ret itself is freshly built.
      for (const [from, to] of [["deps", "deps"], ["_build/test", "_build/test"]]) {
        const cachedApp = path.join(cache, "_build/test/lib/ret");
        fs.cpSync(path.join(cache, from), path.join(application, to), { recursive: true, dereference: true,
          filter: input => input !== cachedApp && !input.startsWith(cachedApp + path.sep) });
      }
    });
    // The host's Hex 2.5.1 archive was compiled for a newer OTP and cannot
    // load on OTP27. Keep the SAME Hex version, using Mix's signed-CSV/SHA512
    // official installer ONLY in this private Mix home, before starting PG.
    // No user config, provider credentials or global software is changed.
    if (socketMode) step("copy-verified-existing-hex-private-home", () => {
      const archive = path.join(work, "mix/archives/hex-2.5.1");
      fs.mkdirSync(path.dirname(archive), { mode: 0o700 });
      fs.cpSync(hexArchive.directory, archive, { recursive: true, dereference: false });
      if (inspectHexArchive(archive).manifest !== hexArchive.manifest || inspectHexArchive(hexArchive.directory).manifest !== hexArchive.manifest) reject("hex_archive_changed_during_copy");
    });
    else step("materialize-pinned-hex-private-home", () => run(path.join(elixir, "mix"), ["local.hex", "2.5.1", "--force"]));
    port = await privatePort(socketMode ? [Number(new URL(args[6]).port)] : []);
    data = path.join(work, "database"); const credential = crypto.randomBytes(32).toString("hex");
    const pwfile = path.join(work, "password"); fs.writeFileSync(pwfile, credential + "\n", { mode: 0o600 });
    epoch = Math.floor(Date.now() / 1000);
    step("initialize-private-synthetic-database", () => {
      run(path.join(pgBin, "initdb"), ["-D", data, "-U", "profile_test", "--pwfile", pwfile, "--auth-local=trust", "--auth-host=scram-sha-256", "--no-locale", "--encoding=UTF8"]);
      attempted = true;
      run(path.join(pgBin, "pg_ctl"), ["-D", data, "-l", path.join(work, "postgres.log"), "-o",
        `-h 127.0.0.1 -p ${port} -k ${path.join(work, "socket")}`, "-w", "start"]);
      identity = assertPostmaster(work, data, port, epoch);
      const answer = run(path.join(pgBin, "psql"), ["-X", "-h", path.join(work, "socket"), "-p", String(port),
        "-U", "profile_test", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT current_setting('data_directory'), current_user"], { capture: true }).trim();
      if (answer !== `${data}|profile_test`) reject("database_identity_mismatch");
    });
    env.RET_LOCAL_DATA = data; env.RET_LOCAL_PORT = String(port); env.RET_LOCAL_CREDENTIAL = credential;
    if (socketMode) {
      env.RET_LOCAL_UI_HTTP_PORT = String(await privatePort([port, Number(new URL(args[6]).port)]));
      env.RET_LOCAL_BROWSER_ORIGIN = args[6]; env.RET_LOCAL_UI_BOOTSTRAP = path.join(work,
        args[0] === "--normal-glb-browser" ? "normal-glb-socket-bootstrap.json" :
          args[0] === "--profile-creator-socket" ? "creator-socket-bootstrap.json" : "ui-socket-bootstrap.json");
      if (args[0] === "--normal-glb-browser") env.RET_LOCAL_CONSUMER_ENTRY = "normal-glb";
      env.RET_LOCAL_SOURCE_ROOT = socketSourceBefore["."]; env.RET_LOCAL_SOURCE_HUBS = socketSourceBefore.hubs;
      env.RET_LOCAL_SOURCE_CLOUD = socketSourceBefore["hubs-cloud"];
    }
    if (catalog) env.RET_LOCAL_CATALOG_INPUT = catalog.input;
    const isolated = argv => run("/usr/bin/sandbox-exec", ["-p", networkProfile(port), ...argv], { cwd: application, timeout: 240000 });
    step("compile-current-reticulum-offline", () => isolated([path.join(elixir, "mix"), "compile", "--warnings-as-errors", "--no-deps-check"]));
    for (const { profile, count } of cases) {
      // One fresh OS/BEAM process per installation. Application env swaps in
      // a surviving supervisor would not prove that omitted children stay OFF.
      env.RET_LOCAL_PROFILE = profile;
      if (["profile-ui-socket", "profile-creator-socket"].includes(profile)) {
        phase = `backend-${profile}`; writeReceipt(); process.stdout.write(`RET_LOCAL_STAGE:${phase}\n`);
        metrics.ui_socket = await observeUiSocket({ root, work, log, env, application, pgPort: port, mix: path.join(elixir, "mix") });
        socketSourceAfter = catalogSourceSnapshot();
        if (JSON.stringify(socketSourceAfter) !== JSON.stringify(socketSourceBefore)) reject("ui_socket_source_changed");
        continue;
      } else if (["sql-http-canary", "sql-http-reentry", "sql-http-stop-drain", "sql-http-periodic"].includes(profile)) {
        const { runSqlHttpCanary } = await import("./sql-http-local.mjs");
        phase = `backend-${profile}`; writeReceipt();
        process.stdout.write(`RET_LOCAL_STAGE:${phase}\n`);
        const before = performance.now();
        try {
          metrics.sql_http = await runSqlHttpCanary({ root, work, log, env, application,
            pgPort: port, mix: path.join(elixir, "mix"), botCache: args[6] });
        } finally {
          metrics[phase] = Math.round(performance.now() - before); writeReceipt();
        }
      } else {
        step(`backend-${profile}`, () => isolated([path.join(elixir, "mix"), "run", "--no-start", "--no-compile",
          path.join(root, "tests/runtime/reticulum-local.exs")]));
      }
      const result = fs.readFileSync(path.join(application, `local-result-${profile}.txt`), "utf8").trim();
      if (result !== `${count}/${count}`) reject("missing_exact_test_result");
      tests += count;
    }
    if (catalog) {
      const captureOwnedCatalogDump = () => {
        if (assertPostmaster(work, data, port, epoch) !== identity) reject("catalog_postmaster_identity_changed");
        const readback = JSON.parse(fs.readFileSync(path.join(work, "catalog-readback.json"), "utf8"));
        const ownedPairs = catalog.graph ? 103 : 99;
        if (readback.models !== 33 || readback.listings !== 33 || readback.owned_pairs !== ownedPairs || readback.preserved !== 7 ||
            (catalog.graph && readback.graph?.scope !== "native-synthetic-room-project-graph-not-current-metaverse")) reject("catalog_readback_missing");
        const dump = run(path.join(pgBin, "pg_dump"), ["-h", path.join(work, "socket"), "-p", String(port),
          "-U", "profile_test", "-d", "ret_test", "--no-owner", "--no-acl"], { capture: true });
        fs.writeFileSync(path.join(work, "catalog-native.sql"), dump, { flag: "wx", mode: 0o600 });
        // Keys remain solely in this private synthetic SQL. Never print it or
        // advertise it as a complete checkpoint/restore or the PG12 runtime.
        catalog.assertUnchanged(); catalogSourceAfter = catalogSourceSnapshot();
        if (JSON.stringify(catalogSourceAfter) !== JSON.stringify(catalogSourceBefore)) reject("catalog_source_changed");
        metrics.catalog = { models: 33, owned_pairs: ownedPairs, preserved: 7, originals: catalog.originals,
          media_plaintext_bytes: catalog.source_bytes, sql_bytes: Buffer.byteLength(dump),
          postgres_version: catalogPostgresVersion,
          ...(catalog.graph ? { graph: readback.graph } : {}),
          scope: "native-PG14-synthetic-catalog-not-backup-restore-browser-or-three-cycles" };
      };
      step("capture-owned-catalog-sql-and-source-identity", captureOwnedCatalogDump);
    }
    outcome = socketMode ? "OBSERVATION_STOPPED" : "PASS";
  } catch (error) {
    process.stderr.write(`RET_LOCAL_FAIL:${phase}:${/^[a-z0-9_-]+$/.test(error.message) ? error.message : "inspect_private_log"}\n`);
    process.exitCode = 1;
  } finally {
    if (attempted) {
      try {
        const stopOwnedDatabase = () => {
          if (identity !== undefined && assertPostmaster(work, data, port, epoch) !== identity) reject("changed_postmaster_identity");
          if (identity === undefined && !fs.existsSync(path.join(data, "postmaster.pid"))) return;
          identity ??= assertPostmaster(work, data, port, epoch);
          run(path.join(pgBin, "pg_ctl"), ["-D", data, "-w", "stop", "-m", "fast"], { discardLog: socketMode });
          let alive = true; try { process.kill(identity, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
          if (alive || fs.existsSync(path.join(data, "postmaster.pid"))) reject("owned_database_not_stopped");
        };
        if (socketMode) {
          // Diagnostic storage must not prevent the already-owned PG cleanup.
          phase = "stop-owned-database";
          const before = performance.now();
          try { stopOwnedDatabase(); }
          finally { metrics[phase] = Math.round(performance.now() - before); }
        } else step("stop-owned-database", stopOwnedDatabase);
      } catch { outcome = "FAIL"; process.exitCode = 1; process.stderr.write("RET_LOCAL_FAIL:owned-database-stop\n"); }
    }
    phase = "terminal";
    if (socketMode) {
      try { writeReceipt(); }
      catch { outcome = "FAIL"; process.exitCode = 1; process.stderr.write("RET_LOCAL_FAIL:terminal-receipt-write\n"); }
      if (log !== undefined) {
        try { fs.closeSync(log); }
        catch { outcome = "FAIL"; process.exitCode = 1; process.stderr.write("RET_LOCAL_FAIL:terminal-log-close\n"); }
      }
    } else { writeReceipt(); if (log !== undefined) fs.closeSync(log); }
    if (work && !process.stdout.destroyed) process.stdout.write(`RET_LOCAL_RESULT:${outcome}:tests=${tests}:scratch=${work}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

// Opt-in build/serve of one RoomSettings browser canary. No browser acceptance,
// Build success never implies SQL/socket/browser acceptance or production.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { browserOrigin } from "./reticulum-local.mjs";

const root = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const hubs = path.join(root, "hubs");
const expectedHubs = "dd176f6ed318ffc724efcd930803ca972058e782";
const expectedCloud = "2c0b53d591d5547438812d27507bc1b3e1ae6f41";
const ownFiles = [
  "tests/runtime/profile-ui-browser.mjs",
  "tests/runtime/profile-ui-browser-entry.js",
  "tests/runtime/reticulum-local.mjs",
];
const publicConfigFiles = new Set([
  "webpack.config.js",
  "babel.config.js",
  "tsconfig.json",
  ".browserslistrc",
  "package.json",
  "package-lock.json",
  "themes.json",
]);
const gitEnv = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
};
const sha = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const digest = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code) => {
  throw new Error(code);
};
const within = (base, file) =>
  file === base || file.startsWith(base + path.sep);
const json = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });

function git(directory, args) {
  const result = spawnSync(
    "/usr/bin/git",
    ["--no-optional-locks", "-C", directory, ...args],
    {
      encoding: "utf8",
      env: gitEnv,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0) fail("source_git_check_failed");
  return result.stdout;
}

function frozenSource() {
  const head = git(hubs, ["rev-parse", "HEAD"]).trim();
  const status = git(hubs, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (head !== expectedHubs || status) fail("hubs_source_not_frozen");
  const tracked = git(hubs, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of publicConfigFiles) {
    if (fs.existsSync(path.join(hubs, file)) && !tracked.includes(file))
      fail("untracked_build_config_not_allowed");
  }
  const paths = tracked
    .filter((file) => file.startsWith("src/") || publicConfigFiles.has(file))
    .map((file) => `hubs/${file}`);
  const sources = [...paths, ...ownFiles].sort().map((relative) => {
    const file = path.join(root, relative);
    if (!within(root, fs.realpathSync(file)) || !fs.lstatSync(file).isFile())
      fail("source_not_regular_local_file");
    return { path: relative, bytes: fs.statSync(file).size, sha256: sha(file) };
  });
  return {
    hubsHead: head,
    hubsStatus: status,
    sourceSha256: digest(sources),
    sources,
  };
}

function connectedSource() {
  const heads = {};
  for (const [name, directory] of [
    ["root", root],
    ["hubs", hubs],
    ["cloud", path.join(root, "hubs-cloud")],
  ]) {
    if (
      git(directory, ["status", "--porcelain=v1", "--untracked-files=normal"])
    )
      fail("connected_source_not_frozen");
    heads[name] = git(directory, ["rev-parse", "HEAD"]).trim();
  }
  if (heads.hubs !== expectedHubs || heads.cloud !== expectedCloud)
    fail("connected_source_heads_mismatch");
  return heads;
}

function readBootstrap(file, copied = false) {
  const actual = fs.realpathSync(file),
    stat = fs.lstatSync(file),
    parent = fs.lstatSync(path.dirname(actual));
  if (
    actual !== path.resolve(file) ||
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 ||
    !parent.isDirectory() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700 ||
    stat.size > 8192 ||
    (!copied &&
      !/^\/private\/tmp\/ynret-local-[^/]+\/ui-socket-bootstrap\.json$/.test(
        actual,
      ))
  )
    fail("private_native_bootstrap_required");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(actual, "utf8"));
  } catch {
    fail("invalid_native_bootstrap");
  }
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "auth_token,backend_pid,browser_origin,hub_sid,kind,schema,source,ws_url" ||
    value.schema !== 1 ||
    value.kind !== "reticulum-profile-ui-socket" ||
    typeof value.hub_sid !== "string" ||
    !/^[A-Za-z0-9]{7}$/.test(value.hub_sid) ||
    typeof value.auth_token !== "string" ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      value.auth_token,
    ) ||
    !Number.isInteger(value.backend_pid) ||
    value.backend_pid < 2 ||
    typeof value.ws_url !== "string" ||
    !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/socket$/.test(value.ws_url) ||
    !value.source ||
    Object.keys(value.source).sort().join(",") !== "cloud,hubs,root"
  )
    fail("invalid_native_bootstrap");
  browserOrigin(value.browser_origin);
  const ws = new URL(value.ws_url);
  if (
    Number(ws.port) < 1024 ||
    Number(ws.port) > 65535 ||
    ws.port === new URL(value.browser_origin).port ||
    JSON.stringify(Object.entries(value.source).sort()) !==
      JSON.stringify(Object.entries(connectedSource()).sort())
  )
    fail("bootstrap_source_or_ports_mismatch");
  try {
    process.kill(value.backend_pid, 0);
  } catch {
    fail("native_backend_not_alive");
  }
  return value;
}

function connectionForReceipt(scratch, receipt) {
  if (receipt.mode !== "connected") return null;
  const file = path.join(scratch, "connected-bootstrap.json");
  if (sha(file) !== receipt.bootstrapSha256) fail("bootstrap_hash_mismatch");
  const value = readBootstrap(file, true);
  if (
    value.browser_origin !== receipt.browserOrigin ||
    value.ws_url !== receipt.wsUrl ||
    value.backend_pid !== receipt.backendPid
  )
    fail("bootstrap_receipt_mismatch");
  return value;
}

function scratchDirectory(directory) {
  const actual = fs.realpathSync(directory);
  const stat = fs.lstatSync(actual);
  if (
    within(root, actual) ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    fail("private_scratch_outside_checkout_required");
  return actual;
}

function artifactInventory(directory, prefix = "") {
  return fs
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const file = path.join(directory, name),
        relative = prefix + name,
        stat = fs.lstatSync(file);
      if (stat.isDirectory()) return artifactInventory(file, relative + "/");
      if (!stat.isFile()) fail("artifact_not_regular_file");
      fs.chmodSync(file, 0o600);
      return [{ path: relative, bytes: stat.size, sha256: sha(file) }];
    });
}

function cleanBuildEnvironment(scratch) {
  return {
    ...gitEnv,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: path.join(scratch, "home"),
    TMPDIR: scratch,
    XDG_CACHE_HOME: path.join(scratch, "cache"),
    CI: "1",
    NODE_ENV: "development",
    DEV_HTTP: "1",
    BASE_ASSETS_PATH: "/",
    LANG: "C.UTF-8",
  };
}

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Canary local RoomSettings</title><link rel="icon" href="data:,"><style>
.profile-canary{min-height:100vh;padding:16px;box-sizing:border-box}
.profile-canary-controls{max-width:900px;margin-bottom:16px}
.profile-canary-controls h1{font-size:22px}.profile-canary-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.profile-canary-buttons button{padding:10px 14px}.profile-canary-consumer{height:760px;max-height:80vh;width:440px;max-width:100%}
</style></head><body><div id="root"></div><noscript>Este canary necesita JavaScript.</noscript></body></html>`;

async function buildWorker(directory) {
  const scratch = scratchDirectory(directory),
    receiptFile = path.join(scratch, "build-receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  try {
    // Darwin injects this locale hint at exec even with an explicit env array.
    // Remove that OS-only addition; all supplied build keys stay exact.
    if (process.platform === "darwin")
      delete process.env.__CF_USER_TEXT_ENCODING;
    const allowedEnvironment = cleanBuildEnvironment(scratch);
    if (
      Object.keys(process.env).length !==
        Object.keys(allowedEnvironment).length ||
      Object.entries(allowedEnvironment).some(
        ([key, value]) => process.env[key] !== value,
      )
    )
      fail("build_worker_environment_not_allowlisted");
    const before = frozenSource();
    const connection = connectionForReceipt(scratch, receipt);
    if (before.sourceSha256 !== receipt.sourceSha256)
      fail("source_changed_before_build");
    if (
      process.cwd() !== scratch ||
      fs.existsSync(".env") ||
      fs.existsSync(".defaults.env")
    )
      fail("empty_build_cwd_required");
    const require = createRequire(path.join(hubs, "package.json"));
    const webpack = require("webpack"),
      HtmlWebpackPlugin = require("html-webpack-plugin"),
      CopyWebpackPlugin = require("copy-webpack-plugin");
    const config = await require(path.join(hubs, "webpack.config.js"))(
      {},
      { mode: "development" },
    );
    config.mode = "development";
    config.context = hubs;
    config.entry = { "profile-ui-canary": path.join(root, ownFiles[1]) };
    config.output = {
      ...config.output,
      path: path.join(scratch, "out"),
      publicPath: "/",
    };
    config.cache = { type: "memory" };
    config.resolve.modules = [path.join(hubs, "node_modules"), "node_modules"];
    config.resolveLoader = {
      modules: [path.join(hubs, "node_modules"), "node_modules"],
    };
    for (const rule of config.module.rules) {
      if (rule.loader === "babel-loader") {
        rule.options = {
          ...rule.options,
          cwd: hubs,
          configFile: path.join(hubs, "babel.config.js"),
          cacheDirectory: false,
        };
      }
    }
    config.plugins = config.plugins.filter(
      (plugin) =>
        !(plugin instanceof HtmlWebpackPlugin) &&
        !(plugin instanceof CopyWebpackPlugin),
    );
    config.plugins.push(
      new webpack.DefinePlugin({
        __RETICULUM_UI_BOOTSTRAP__: JSON.stringify(connection),
      }),
      new HtmlWebpackPlugin({
        filename: "index.html",
        templateContent: connection
          ? html.replace(
              "connect-src 'none'",
              `connect-src ${connection.ws_url}/websocket`,
            )
          : html,
        scriptLoading: "defer",
      }),
    );
    // Compilation does not start a dev server. Serving uses the owned static server below.
    delete config.devServer;
    const stats = await new Promise((resolve, reject) => {
      const compiler = webpack(config);
      compiler.run((error, result) =>
        compiler.close((closeError) =>
          error || closeError ? reject(error || closeError) : resolve(result),
        ),
      );
    });
    process.stdout.write(
      stats.toString({
        all: false,
        assets: true,
        errors: true,
        warnings: true,
        timings: true,
      }) + "\n",
    );
    const after = frozenSource();
    if (before.sourceSha256 !== after.sourceSha256)
      fail("source_changed_during_build");
    const summary = stats.toJson({
      all: false,
      errorsCount: true,
      warningsCount: true,
      timings: true,
    });
    if (stats.hasErrors()) fail("webpack_compilation_failed");
    const sourcePaths = new Set(before.sources.map((source) => source.path));
    const compiledSourcePaths = [...stats.compilation.fileDependencies]
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .filter((file) => sourcePaths.has(file))
      .sort();
    for (const file of [
      ownFiles[1],
      "hubs/src/utils/hub-channel.js",
      "hubs/src/utils/configs.js",
      "hubs/src/react-components/room/RoomSettingsSidebar.js",
    ]) {
      if (!compiledSourcePaths.includes(file))
        fail("real_canary_consumer_missing_from_build");
    }
    const artifacts = artifactInventory(path.join(scratch, "out"));
    if (!artifacts.some((artifact) => artifact.path === "index.html"))
      fail("canary_html_missing");
    json(receiptFile, {
      ...receipt,
      status: "BUILD_SUCCEEDED",
      finishedAt: new Date().toISOString(),
      sourceAfterSha256: after.sourceSha256,
      webpackVersion: webpack.version,
      errors: summary.errorsCount,
      warnings: summary.warningsCount,
      buildMs: summary.time,
      compiledSourcePaths,
      artifacts,
      artifactsSha256: digest(artifacts),
      browserAcceptance: "NOT_RUN",
      fullAcceptance: false,
    });
  } catch (error) {
    process.stderr.write(String(error.stack) + "\n");
    json(receiptFile, {
      ...receipt,
      status: "BUILD_FAILED",
      finishedAt: new Date().toISOString(),
      failure: error.message,
    });
    process.exitCode = 1;
  }
}

function build(bootstrapFile) {
  const before = frozenSource();
  const connection = bootstrapFile ? readBootstrap(bootstrapFile) : null;
  const temporary = fs.realpathSync(os.tmpdir());
  if (within(root, temporary)) fail("scratch_parent_inside_checkout");
  const scratch = fs.mkdtempSync(
    path.join(temporary, "yn-profile-ui-browser-"),
  );
  fs.chmodSync(scratch, 0o700);
  fs.mkdirSync(path.join(scratch, "home"), { mode: 0o700 });
  const receiptFile = path.join(scratch, "build-receipt.json"),
    logFile = path.join(scratch, "build.log");
  const env = cleanBuildEnvironment(scratch);
  const copiedBootstrap = path.join(scratch, "connected-bootstrap.json");
  if (connection) json(copiedBootstrap, connection);
  // No inherited NODE_OPTIONS/NODE_PATH, dotenv, credentials, proxy or app-config endpoints.
  json(receiptFile, {
    kind: "room-settings-local-browser-canary",
    version: 1,
    status: "BUILD_RUNNING",
    startedAt: new Date().toISOString(),
    root,
    rootHead: git(root, ["rev-parse", "HEAD"]).trim(),
    ...before,
    node: process.version,
    environmentKeys: Object.keys(env).sort(),
    mode: connection ? "connected" : "disconnected",
    ...(connection
      ? {
          bootstrapSha256: sha(copiedBootstrap),
          browserOrigin: connection.browser_origin,
          wsUrl: connection.ws_url,
          backendPid: connection.backend_pid,
          backendSource: connection.source,
        }
      : {}),
    seams: connection
      ? [
          "local-synthetic-account-and-room",
          "SQL-transitions-through-product-setter-not-raw-periodic",
          "RoomSettings-submit-disabled",
        ]
      : [
          "unconnected-Phoenix-trigger",
          "local-credential-store",
          "synthetic-room-data",
        ],
    browserAcceptance: "NOT_RUN",
    fullAcceptance: false,
  });
  const log = fs.openSync(logFile, "wx", 0o600);
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--build-worker", scratch],
      {
        cwd: scratch,
        env,
        stdio: ["ignore", log, log],
      },
    );
  } finally {
    fs.closeSync(log);
  }
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  let sourceUnchanged = false;
  try {
    sourceUnchanged = frozenSource().sourceSha256 === before.sourceSha256;
  } catch {
    /* Recorded as a failed build below. */
  }
  const succeeded =
    result.status === 0 &&
    receipt.status === "BUILD_SUCCEEDED" &&
    sourceUnchanged;
  json(receiptFile, {
    ...receipt,
    status: succeeded ? "BUILD_SUCCEEDED" : "BUILD_FAILED",
    sourceUnchanged,
    workerExitCode: result.status,
    workerSignal: result.signal,
    workerErrorCode: result.error?.code,
    buildLogSha256: sha(logFile),
    buildReceiptCompletedAt: new Date().toISOString(),
  });
  process.stdout.write(
    JSON.stringify({
      status: succeeded ? "BUILD_SUCCEEDED" : "BUILD_FAILED",
      scratch,
      receipt: receiptFile,
      receiptSha256: sha(receiptFile),
      sourceSha256: before.sourceSha256,
      browserAcceptance: "NOT_RUN",
    }) + "\n",
  );
  if (!succeeded) process.exitCode = 1;
}

async function serve(directory, port) {
  const scratch = scratchDirectory(directory),
    receipt = JSON.parse(
      fs.readFileSync(path.join(scratch, "build-receipt.json"), "utf8"),
    );
  if (
    receipt.kind !== "room-settings-local-browser-canary" ||
    receipt.version !== 1 ||
    receipt.status !== "BUILD_SUCCEEDED" ||
    receipt.root !== root ||
    receipt.hubsHead !== expectedHubs ||
    receipt.sourceSha256 !== frozenSource().sourceSha256
  )
    fail("current_successful_build_required");
  const connection = connectionForReceipt(scratch, receipt);
  if (connection && port !== Number(new URL(connection.browser_origin).port))
    fail("exact_linked_browser_port_required");
  const output = fs.realpathSync(path.join(scratch, "out"));
  if (!within(scratch, output)) fail("output_outside_owned_scratch");
  const artifacts = artifactInventory(output);
  if (digest(artifacts) !== receipt.artifactsSha256)
    fail("bundle_hash_mismatch");
  const files = new Map(
    artifacts.map((artifact) => ["/" + artifact.path, artifact]),
  );
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".glb": "model/gltf-binary",
  };
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (
      connection &&
      request.headers.host !== new URL(connection.browser_origin).host
    ) {
      response.writeHead(421).end();
      return;
    }
    if (
      !["GET", "HEAD"].includes(request.method) ||
      !request.url.startsWith("/")
    ) {
      response.writeHead(405).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url, "http://127.0.0.1").pathname,
      );
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname === "/") pathname = "/index.html";
    const artifact = files.get(pathname);
    if (!artifact) {
      response.writeHead(404).end();
      return;
    }
    const file = path.join(output, artifact.path);
    let unchanged = false;
    try {
      unchanged =
        within(output, fs.realpathSync(file)) && sha(file) === artifact.sha256;
    } catch {
      // Missing/replaced artifacts are rejected rather than served from elsewhere.
    }
    if (!unchanged) {
      response.writeHead(409).end();
      return;
    }
    response.setHeader(
      "Content-Type",
      types[path.extname(file)] || "application/octet-stream",
    );
    response.setHeader("Content-Length", artifact.bytes);
    response.writeHead(200);
    if (request.method === "HEAD") response.end();
    else
      fs.createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`,
    serverReceipt = path.join(scratch, `serve-receipt-${process.pid}.json`);
  const state = {
    status: "SERVING",
    pid: process.pid,
    url,
    startedAt: new Date().toISOString(),
    artifactsSha256: receipt.artifactsSha256,
    sourceSha256: receipt.sourceSha256,
    browserAcceptance: "NOT_RUN",
    fullAcceptance: false,
    mode: connection ? "connected" : "disconnected",
  };
  json(serverReceipt, state);
  process.stdout.write(
    JSON.stringify({
      ...state,
      receipt: serverReceipt,
      stop: "SIGINT or SIGTERM to this foreground process",
    }) + "\n",
  );
  await new Promise((resolve) => {
    let stopping = false;
    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      server.close(() => {
        json(serverReceipt, {
          ...state,
          status: "STOPPED",
          signal,
          stoppedAt: new Date().toISOString(),
        });
        process.stdout.write(
          JSON.stringify({
            status: "STOPPED",
            signal,
            receipt: serverReceipt,
          }) + "\n",
        );
        resolve();
      });
      server.closeAllConnections();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
}

try {
  const [command, directory, ...rest] = process.argv.slice(2);
  if (command === "build" && directory === undefined) build();
  else if (
    command === "build" &&
    directory === "--bootstrap" &&
    rest.length === 1
  )
    build(rest[0]);
  else if (command === "--build-worker" && directory && rest.length === 0)
    await buildWorker(directory);
  else if (
    command === "serve" &&
    directory &&
    (rest.length === 0 || (rest.length === 2 && rest[0] === "--port"))
  ) {
    const port = rest.length ? Number(rest[1]) : 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      fail("invalid_loopback_port");
    await serve(directory, port);
  } else fail("usage_build_or_serve_scratch_optional_port");
} catch (error) {
  process.stderr.write(`PROFILE_UI_BROWSER_FAILED:${error.message}\n`);
  process.exitCode = 1;
}

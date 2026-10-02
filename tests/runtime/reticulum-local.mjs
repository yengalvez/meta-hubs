// Opt-in, macOS-only native backend sample. No provider, production DB,
// Kubernetes, restore or profile/deployment acceptance is implied by this test.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareCatalogDataset } from "./catalog-dataset.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const relativeRet = "community-edition/services/reticulum";
const cloud = path.join(root, "hubs-cloud");
const source = path.join(cloud, relativeRet);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const reject = code => { throw new Error(code); };

export function runtimeCases(mode) {
  switch (mode) {
    case "--run": return [{ profile: "existing-tests", count: 5 }];
    case "--profiles": return ["base", "base-avaturn", "bots", "bots-avaturn", "bots-ai", "bots-ai-avaturn"].map(profile => ({ profile, count: 1 }));
    case "--chat-canary": return [{ profile: "chat-canary", count: 2 }];
    case "--chat-boundaries": return [{ profile: "chat-boundaries", count: 5 }];
    case "--chat-concurrent": return [{ profile: "chat-concurrent", count: 2 }];
    case "--chat-concurrent-boundaries": return [{ profile: "chat-concurrent-boundaries", count: 4 }];
    case "--sql-http-canary": return [{ profile: "sql-http-canary", count: 2 }];
    case "--sql-http-reentry": return [{ profile: "sql-http-reentry", count: 1 }];
    case "--catalog-dataset": return [{ profile: "catalog-dataset", count: 1 }];
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
  let catalog, catalogSourceBefore, catalogSourceAfter;
  const catalogSourceSnapshot = () => Object.fromEntries([".", "hubs", "hubs-cloud"].map(name => {
    const repository = path.join(root, name);
    const read = args => {
      const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8" });
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
      stdio: ["ignore", options.capture ? "pipe" : log, log] });
    if (result.error || result.signal || result.status !== 0) reject(`command_failed_${phase}`);
    return result.stdout || "";
  };
  try {
    const integrated = ["--sql-http-canary", "--sql-http-reentry"].includes(args[0]);
    const catalogMode = args[0] === "--catalog-dataset";
    if (args.length !== (integrated || catalogMode ? 7 : 5) || args[1] !== "--pg-bin" || args[3] !== "--cache-reticulum" ||
        (integrated && args[5] !== "--cache-bot-orchestrator") ||
        (catalogMode && args[5] !== "--catalog-receipts") ||
        process.platform !== "darwin") reject("explicit_native_target_required");
    cases = runtimeCases(args[0]);
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
      catalog = step("prepare-approved-catalog-private-input", () => prepareCatalogDataset({ root, work, receiptsPath: args[6] }));
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
    step("materialize-pinned-hex-private-home", () => run(path.join(elixir, "mix"), ["local.hex", "2.5.1", "--force"]));
    port = await new Promise((resolve, fail) => {
      const server = net.createServer(); server.once("error", fail);
      server.listen({ host: "127.0.0.1", port: 0 }, () => { const chosen = server.address().port; server.close(error => error ? fail(error) : resolve(chosen)); });
    });
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
    if (catalog) env.RET_LOCAL_CATALOG_INPUT = catalog.input;
    const isolated = argv => run("/usr/bin/sandbox-exec", ["-p", networkProfile(port), ...argv], { cwd: application, timeout: 240000 });
    step("compile-current-reticulum-offline", () => isolated([path.join(elixir, "mix"), "compile", "--warnings-as-errors", "--no-deps-check"]));
    for (const { profile, count } of cases) {
      // One fresh OS/BEAM process per installation. Application env swaps in
      // a surviving supervisor would not prove that omitted children stay OFF.
      env.RET_LOCAL_PROFILE = profile;
      if (["sql-http-canary", "sql-http-reentry"].includes(profile)) {
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
        if (readback.models !== 33 || readback.listings !== 33 || readback.owned_pairs !== 99 || readback.preserved !== 7) reject("catalog_readback_missing");
        const dump = run(path.join(pgBin, "pg_dump"), ["-h", path.join(work, "socket"), "-p", String(port),
          "-U", "profile_test", "-d", "ret_test", "--no-owner", "--no-acl"], { capture: true });
        fs.writeFileSync(path.join(work, "catalog-native.sql"), dump, { flag: "wx", mode: 0o600 });
        // Keys remain solely in this private synthetic SQL. Never print it or
        // advertise it as a complete checkpoint/restore or the PG12 runtime.
        catalog.assertUnchanged(); catalogSourceAfter = catalogSourceSnapshot();
        if (JSON.stringify(catalogSourceAfter) !== JSON.stringify(catalogSourceBefore)) reject("catalog_source_changed");
        metrics.catalog = { models: 33, owned_pairs: 99, preserved: 7, originals: catalog.originals,
          media_plaintext_bytes: catalog.source_bytes, sql_bytes: Buffer.byteLength(dump),
          postgres_version: catalogPostgresVersion,
          scope: "native-PG14-synthetic-catalog-not-backup-restore-browser-or-three-cycles" };
      };
      step("capture-owned-catalog-sql-and-source-identity", captureOwnedCatalogDump);
    }
    outcome = "PASS";
  } catch (error) {
    process.stderr.write(`RET_LOCAL_FAIL:${phase}:${/^[a-z0-9_-]+$/.test(error.message) ? error.message : "inspect_private_log"}\n`);
    process.exitCode = 1;
  } finally {
    if (attempted) {
      try {
        step("stop-owned-database", () => {
          if (identity !== undefined && assertPostmaster(work, data, port, epoch) !== identity) reject("changed_postmaster_identity");
          if (identity === undefined && !fs.existsSync(path.join(data, "postmaster.pid"))) return;
          identity ??= assertPostmaster(work, data, port, epoch);
          run(path.join(pgBin, "pg_ctl"), ["-D", data, "-w", "stop", "-m", "fast"]);
          let alive = true; try { process.kill(identity, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
          if (alive || fs.existsSync(path.join(data, "postmaster.pid"))) reject("owned_database_not_stopped");
        });
      } catch { outcome = "FAIL"; process.exitCode = 1; process.stderr.write("RET_LOCAL_FAIL:owned-database-stop\n"); }
    }
    phase = "terminal"; writeReceipt(); if (log !== undefined) fs.closeSync(log);
    if (work) process.stdout.write(`RET_LOCAL_RESULT:${outcome}:tests=${tests}:scratch=${work}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

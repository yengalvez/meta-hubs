// Opt-in native LOCAL data canary. This is not the Kubernetes restore CLI,
// another recovery coordinator, or a substitute for runtime/deploy acceptance.
// Only an already accepted, complete checkpoint may be supplied explicitly.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeBashArguments, resolveNativeBash } from "./native-bash.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const library = path.join(root, "deployment/lib/recovery-safety.sh");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const reject = code => { throw new Error(code); };

// A pg_dump is a program. Restrict psql client commands outside COPY data;
// never allow a checkpoint to select another connection, file or subprocess.
export function validateLocalDump(sql) {
  let copy = false;
  for (const line of sql.split("\n")) {
    if (copy) { if (line === "\\.") copy = false; continue; }
    if (/^COPY .* FROM stdin;$/.test(line)) { copy = true; continue; }
    if (line.startsWith("\\") && !/^\\(?:restrict|unrestrict) [A-Za-z0-9]+$/.test(line)) reject("unexpected_psql_command");
  }
  if (copy) reject("unfinished_copy");
  if (/\bCOPY\b[^\n]*\bPROGRAM\b|\bCREATE SERVER\b|\bCREATE FOREIGN TABLE\b|\bLANGUAGE\s+(?:c|plpython\w*|plperl\w*)\b/i.test(sql)) reject("nonlocal_dump_program");
  if ([...sql.matchAll(/OWNER TO ([^;]+);/g)].some(match => !["postgres", "ret_admin"].includes(match[1]))) reject("unsupported_dump_owner");
}

// Ignore ONLY pg_dump's version/date headers and randomized restrict token.
// Preserve all SQL, whitespace, function bodies and COPY data. This comparison
// is deliberately same-major: a PG12->14 deparser changes constraints and the
// placement of partition ATTACH statements without changing source data.
export function logicalDump(sql) {
  let copy = false, started = false;
  const source = sql.split("\n"), lines = [];
  let last = source.length - 1;
  while (last >= 0 && source[last] === "") last--;
  for (let index = 0; index < source.length; index++) {
    const line = source[index];
    if (copy) { lines.push(line); if (line === "\\.") copy = false; continue; }
    if (!started && (/^-- (?:Dumped (?:from database|by pg_dump) version |Started on: )/.test(line) ||
        /^\\restrict [A-Za-z0-9]+$/.test(line))) continue;
    if (index === last && /^\\unrestrict [A-Za-z0-9]+$/.test(line)) continue;
    if (line !== "" && !line.startsWith("--")) started = true;
    if (/^COPY .* FROM stdin;$/.test(line)) copy = true;
    lines.push(line);
  }
  return lines.join("\n");
}

export function copyRows(sql) {
  const result = new Map(); let key, rows = [];
  for (const line of sql.split("\n")) {
    if (key) {
      if (line === "\\.") {
        if (result.has(key)) reject("duplicate_copy_header");
        result.set(key, rows.sort()); key = undefined; rows = [];
      } else rows.push(line);
    } else if (/^COPY .* FROM stdin;$/.test(line)) key = line;
  }
  if (key || result.size === 0) reject("incomplete_copy_inventory");
  return result;
}

export function verifyCopyRows(expected, actual) {
  if (expected.size !== actual.size) reject("database_copy_inventory_mismatch");
  for (const [key, rows] of expected) {
    // Sorting accounts for physical heap order, NOT duplicates or row values.
    if (JSON.stringify(rows) !== JSON.stringify(actual.get(key))) reject("database_copy_rows_mismatch");
  }
}

export function localPgEnvironment(pgBin, home, socket) {
  // Deliberately do NOT spread process.env: inherited PGSERVICE/PGHOST/
  // PGPASSFILE/PGOPTIONS and user psql configuration cannot select a service.
  return { PATH: `${pgBin}:/opt/homebrew/bin:/usr/bin:/bin`, HOME: home,
    LC_ALL: "C", LANG: "C", TZ: "UTC", PGHOST: socket, PGPORT: "55483",
    PGUSER: "postgres", PGDATABASE: "postgres", PGCONNECT_TIMEOUT: "10",
    PGSSLMODE: "disable", PGGSSENCMODE: "disable",
    PGOPTIONS: "-c statement_timeout=30000 -c lock_timeout=10000" };
}

export function mediaInventory(directory) {
  const result = new Map();
  function visit(relative = "") {
    const full = path.join(directory, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid()) reject("unsafe_restored_media");
    if (stat.isDirectory()) {
      fs.chmodSync(full, 0o700);
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    } else if (stat.isFile() && /^owned\/[a-z0-9]{2}\/[a-z0-9]{2}\/[A-Za-z0-9-]+\.(blob|meta\.json)$/.test(relative)) {
      const uuid = path.basename(relative).replace(/\.(blob|meta\.json)$/, "");
      if (relative !== `owned/${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${path.basename(relative)}`) reject("incorrect_media_shard");
      fs.chmodSync(full, 0o600); result.set(relative, sha(fs.readFileSync(full)));
    } else reject("unsafe_restored_media");
  }
  visit();
  return result;
}

export function verifyMedia(inventory, active, expected = inventory) {
  const blobs = [...inventory.keys()].filter(name => name.endsWith(".blob"));
  if (blobs.length !== active.length || inventory.size !== active.length * 2 || inventory.size !== expected.size) reject("restored_media_inventory_mismatch");
  for (const uuid of active) {
    const base = `owned/${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
    for (const suffix of [".blob", ".meta.json"]) {
      if (!inventory.has(base + suffix) || inventory.get(base + suffix) !== expected.get(base + suffix)) reject("restored_media_bytes_mismatch");
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  let work, env, pgBin, log, bashExecutable, serverAttempted = false, serverIdentity, phase = "arguments";
  const started = performance.now(), metrics = {}, rounds = [];
  const report = { scope: "native-local-postgresql-and-media-not-kubernetes-or-production", outcome: "FAIL" };
  function receipt() {
    if (work) fs.writeFileSync(path.join(work, "summary.json"), JSON.stringify({ ...report, phase, metrics, rounds }, null, 2) + "\n", { mode: 0o600 });
  }
  function step(name, action) {
    phase = name; receipt();
    process.stdout.write(`NATIVE_STAGE:${name}\n`);
    const before = performance.now();
    try { return action(); } finally { metrics[name] = Math.round((performance.now() - before) * 1000) / 1000; receipt(); }
  }
  function run(command, argv, options = {}) {
    const result = spawnSync(command, argv, { env, encoding: "utf8", timeout: 120000,
      maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", options.logOutput ? log : "pipe", log],
      input: options.input });
    if (result.status !== 0 || result.error) reject(`${phase}_command_failed`);
    return result.stdout;
  }
  const bash = (program, argv = [], input) => run(bashExecutable, nativeBashArguments(library, program, argv), { input });
  function psql(database, input, logOutput = false) {
    return run(path.join(pgBin, "psql"), ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", env.PGHOST,
      "-p", env.PGPORT, "-U", "postgres", "-d", database], { input, logOutput });
  }
  function privateFile(name, bytes) {
    const file = path.join(work, name); fs.writeFileSync(file, bytes, { mode: 0o600 }); return file;
  }
  function identity() {
    const file = path.join(work, "data/postmaster.pid"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) reject("unsafe_postmaster_identity");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (!/^[1-9][0-9]*$/.test(lines[0]) || lines[1] !== path.join(work, "data") ||
        !/^[0-9]+$/.test(lines[2]) || Number(lines[2]) * 1000 < report.createdAtMs - 1000 ||
        lines[3] !== env.PGPORT || lines[4] !== env.PGHOST) reject("postmaster_identity_mismatch");
    return lines.slice(0, 5).join("\n");
  }
  try {
    if (args.length !== 4 || args[0] !== "--checkpoint" || args[2] !== "--pg-bin" ||
        !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) reject("explicit_local_inputs_required");
    bashExecutable = resolveNativeBash();
    pgBin = fs.realpathSync(args[3]);
    for (const name of ["initdb", "pg_ctl", "psql", "pg_dump"]) if (!fs.statSync(path.join(pgBin, name)).isFile()) reject("native_tool_missing");
    process.umask(0o077);
    // macOS TMPDIR can exceed sockaddr_un's path limit. Use the canonical
    // system /tmp alias, still with a fresh private owned directory.
    work = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "ynr-")); fs.chmodSync(work, 0o700);
    report.createdAtMs = Date.now(); report.privateWork = work;
    const socket = path.join(work, "socket"); fs.mkdirSync(socket, { mode: 0o700 });
    if (Buffer.byteLength(path.join(socket, ".s.PGSQL.55483")) >= 100) reject("local_socket_path_too_long");
    env = localPgEnvironment(pgBin, work, socket);
    log = fs.openSync(path.join(work, "native-private.log"), "wx", 0o600);
    const source = args[1];
    const prepared = step("source_preflight", () => JSON.parse(run(process.execPath,
      [path.join(root, "tests/recovery/native-checkpoint-source.mjs"), "--checkpoint", source, "--native-bash", bashExecutable])));
    const stamp = prepared.sourceStamp, contractSource = path.join(source, "database-contract.json");
    const contract = JSON.parse(fs.readFileSync(contractSource, "utf8"));
    const sums = fs.readFileSync(path.join(source, "SHA256SUMS"), "utf8");
    const expectedHashes = new Map(sums.trim().split("\n").map(line => [line.slice(66), line.slice(0, 64)]));
    const copy = (name, destination) => {
      const bytes = fs.readFileSync(path.join(source, name));
      if (sha(bytes) !== expectedHashes.get(name)) reject("source_changed_before_snapshot");
      return privateFile(destination, bytes);
    };
    let sql, archive;
    step("private_source_snapshot", () => {
      archive = copy(`ret-storage-${stamp}.tar.gz`, "source-media.tar.gz");
      const compressed = fs.readFileSync(copy(`retdb-${stamp}.sql.gz`, "source-db.sql.gz"));
      sql = zlib.gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8");
      validateLocalDump(sql); privateFile("source-db.sql", sql);
      copy("database-contract.json", "source-contract.json");
    });
    step("initdb", () => run(path.join(pgBin, "initdb"), ["-D", path.join(work, "data"), "-U", "postgres",
      "--encoding=UTF8", "--locale=en_US.UTF-8", "--auth-local=trust", "--auth-host=reject"], { logOutput: true }));
    step("server_start", () => {
      serverAttempted = true;
      run(path.join(pgBin, "pg_ctl"), ["-D", path.join(work, "data"), "-t", "30", "-w", "-l", path.join(work, "postgres-private.log"),
        "-o", `-k ${socket} -p ${env.PGPORT} -c listen_addresses='' -c unix_socket_permissions=0700 -c log_statement=none -c log_min_error_statement=panic`, "start"], { logOutput: true });
      serverIdentity = identity();
      if (psql("postgres", "SHOW listen_addresses;\n").trim() !== "" ||
          psql("postgres", "SHOW data_directory;\n").trim() !== path.join(work, "data") ||
          psql("postgres", "SELECT inet_server_addr() IS NULL;\n").trim() !== "t") reject("server_not_private_unix_only");
      if (psql("postgres", "SHOW lc_collate;\n").trim() !== "en_US.UTF-8") reject("local_database_locale_mismatch");
      report.databaseLocale = "en_US.UTF-8";
    });
    step("local_roles", () => psql("postgres", "CREATE ROLE ret_admin NOLOGIN; CREATE DATABASE native0 OWNER postgres TEMPLATE template0;\n", true));
    step("source_database_restore", () => psql("native0", sql, true));
    const query = bash("recovery_database_contract_sql");
    function databaseCheck(database, name) {
      const file = privateFile(name, psql(database, query));
      bash('recovery_database_contracts_match "$2" "$3"', [path.join(work, "source-contract.json"), file]);
      return file;
    }
    step("source_database_inventory", () => databaseCheck("native0", "restored-contract-0.json"));
    function extract(file, name) {
      const destination = path.join(work, name); fs.mkdirSync(destination, { mode: 0o700 });
      run("/usr/bin/tar", ["-xzf", file, "-C", destination]);
      return destination;
    }
    let media, baseline;
    step("source_media_restore", () => {
      media = extract(archive, "media0"); baseline = mediaInventory(media);
      verifyMedia(baseline, contract.critical_inventory.active_owned_file_uuids);
    });
    const originalRows = copyRows(sql); let baselineSql;
    step("source_full_logical_dump", () => {
      const redump = run(path.join(pgBin, "pg_dump"), ["-h", socket, "-p", env.PGPORT, "-U", "postgres", "--format=plain", "native0"]);
      privateFile("source-restored-redump.sql", redump);
      verifyCopyRows(originalRows, copyRows(redump)); baselineSql = logicalDump(redump);
      report.sourceDatabaseVersion = /^-- Dumped from database version ([0-9.]+)/m.exec(sql)?.[1];
      report.localDatabaseVersion = psql("native0", "SHOW server_version;\n").trim().match(/^[0-9.]+/)?.[0];
      report.allSourceCopyTables = originalRows.size;
    });
    for (let round = 1; round <= 3; round++) {
      const before = performance.now();
      let dump, nextArchive;
      step(`round${round}_backup_db`, () => {
        dump = run(path.join(pgBin, "pg_dump"), ["-h", socket, "-p", env.PGPORT, "-U", "postgres", "--format=plain", `native${round - 1}`]);
        validateLocalDump(dump);
        verifyCopyRows(originalRows, copyRows(dump));
        if (logicalDump(dump) !== baselineSql) reject("roundtrip_database_drift");
        const plain = privateFile(`round${round}.sql`, dump);
        privateFile(`round${round}.sql.gz`, zlib.gzipSync(dump, { level: 9 }));
        const bound = path.join(work, `round${round}-contract.json`);
        bash('recovery_bind_database_contract_to_dump "$2" "$3" "$4"; recovery_validate_database_contract_against_dump "$4" "$3"',
          [path.join(work, `restored-contract-${round - 1}.json`), plain, bound]);
      });
      step(`round${round}_backup_media`, () => {
        nextArchive = path.join(work, `round${round}-media.tar.gz`);
        run("/usr/bin/tar", ["-czf", nextArchive, "-C", media, "owned/"]);
      });
      step(`round${round}_restore_db`, () => {
        psql("postgres", `CREATE DATABASE native${round} OWNER postgres TEMPLATE template0;\n`, true);
        const bytes = zlib.gunzipSync(fs.readFileSync(path.join(work, `round${round}.sql.gz`)), { maxOutputLength: 64 * 1024 * 1024 });
        psql(`native${round}`, bytes, true);
        databaseCheck(`native${round}`, `restored-contract-${round}.json`);
        const redump = run(path.join(pgBin, "pg_dump"), ["-h", socket, "-p", env.PGPORT, "-U", "postgres", "--format=plain", `native${round}`]);
        verifyCopyRows(originalRows, copyRows(redump));
        if (logicalDump(redump) !== baselineSql) reject("roundtrip_restored_database_drift");
      });
      step(`round${round}_restore_media`, () => {
        media = extract(nextArchive, `media${round}`);
        verifyMedia(mediaInventory(media), contract.critical_inventory.active_owned_file_uuids, baseline);
      });
      rounds.push({ round, outcome: "PASS", milliseconds: Math.round((performance.now() - before) * 1000) / 1000 });
    }
    step("negative_truncated_dump", () => {
      const bytes = fs.readFileSync(path.join(work, "round1.sql.gz")); let rejected = false;
      try { zlib.gunzipSync(bytes.subarray(0, bytes.length - 16)); } catch { rejected = true; }
      if (!rejected) reject("truncated_dump_not_rejected");
    });
    step("negative_missing_media", () => {
      const name = baseline.keys().next().value, file = path.join(media, name), held = path.join(work, "held-media.blob");
      fs.renameSync(file, held); let rejected = false;
      try { verifyMedia(mediaInventory(media), contract.critical_inventory.active_owned_file_uuids, baseline); }
      catch (error) { rejected = error.message === "restored_media_inventory_mismatch"; }
      finally { fs.renameSync(held, file); }
      if (!rejected) reject("missing_media_not_rejected");
      verifyMedia(mediaInventory(media), contract.critical_inventory.active_owned_file_uuids, baseline);
    });
    step("negative_changed_media", () => {
      const name = [...baseline.keys()].find(entry => entry.endsWith(".meta.json")), file = path.join(media, name);
      const original = fs.readFileSync(file); fs.appendFileSync(file, "\nchanged-local-canary\n"); let rejected = false;
      try { verifyMedia(mediaInventory(media), contract.critical_inventory.active_owned_file_uuids, baseline); }
      catch (error) { rejected = error.message === "restored_media_bytes_mismatch"; }
      finally { fs.writeFileSync(file, original, { mode: 0o600 }); }
      if (!rejected) reject("changed_media_not_rejected");
      verifyMedia(mediaInventory(media), contract.critical_inventory.active_owned_file_uuids, baseline);
    });
    step("source_unchanged", () => {
      if (fs.readFileSync(path.join(source, "SHA256SUMS"), "utf8") !== sums) reject("source_manifest_changed");
      for (const [name, expected] of expectedHashes) if (sha(fs.readFileSync(path.join(source, name))) !== expected) reject("source_artifact_changed");
    });
    report.outcome = "PASS"; report.criticalCounts = contract.critical_counts;
    report.completeMediaPairs = baseline.size / 2; report.verifiedSourceArtifacts = prepared.verifiedArtifacts;
    report.logicalDatabase = "all-source-COPY-rows-and-exact-local-full-dump-roundtrips"; report.sourceUnchanged = true;
  } catch (error) {
    report.failure = /^[a-z0-9_]{1,90}$/.test(error.message) ? error.message : "bounded_native_validation_failed";
    process.exitCode = 1;
  } finally {
    if (serverAttempted) {
      // Cleanup must not depend on successfully writing another receipt. A
      // full disk/log failure may reject a phase, but must still reach stop.
      const before = performance.now(); phase = "server_stop";
      try {
        process.stdout.write("NATIVE_STAGE:server_stop\n");
        const current = identity();
        if (serverIdentity && current !== serverIdentity) reject("stop_owner_changed");
        const stop = mode => run(path.join(pgBin, "pg_ctl"), ["-D", path.join(work, "data"), "-t", "30", "-w", "-m", mode, "stop"], { logOutput: true });
        try { stop("fast"); } catch {
          if (identity() !== current) reject("stop_owner_changed"); stop("immediate");
        }
        if (fs.existsSync(path.join(work, "data/postmaster.pid"))) reject("postmaster_still_present");
        try { process.kill(Number(current.split("\n")[0]), 0); reject("postmaster_still_running"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
        report.serverStopped = true;
      } catch { report.outcome = "FAIL"; report.cleanupFailure = "owned_server_cleanup_failed"; process.exitCode = 1; }
      finally { metrics.server_stop = Math.round((performance.now() - before) * 1000) / 1000; }
    }
    metrics.totalIncludingStop = Math.round((performance.now() - started) * 1000) / 1000;
    try { receipt(); } catch { report.outcome = "FAIL"; report.receiptFailure = "private_receipt_write_failed"; process.exitCode = 1; }
    if (log !== undefined) fs.closeSync(log);
    process.stdout.write(JSON.stringify({ ...report, metrics, rounds }) + "\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

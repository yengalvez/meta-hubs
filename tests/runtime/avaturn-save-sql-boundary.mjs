// Owned --avaturn-save-browser fault-test peer ONLY; never a production tool.
// NDJSON stdin: {"command":"ARM"}, then (after BLOCKED_INSERT) RELEASE, then STOP.
// Each command is single-use. STOP is also allowed before RELEASE for cleanup.
// The real browser/backend must issue the INSERT; this peer writes no rows.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateAvaturnBootstrap } from "./reticulum-local.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scope = "owned-local-avaturn-save-not-production";
const pgPath = "/opt/homebrew/Cellar/postgresql@14/14.23/bin";
const fail = code => { throw new Error(code); };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const literal = text => "'" + String(text).replaceAll("'", "''") + "'";
export const boundaryLimits = Object.freeze({ commandBytes: 128, totalMs: 105000, queryMs: 3000, closeMs: 4000, pollMs: 250 });

export function boundaryArguments(args) {
  if (args.length !== 4 || args[0] !== "--work" || args[2] !== "--pg-bin" ||
      !/^\/private\/tmp\/ynret-local-[A-Za-z0-9_-]+$/.test(args[1]) || args[3] !== pgPath) fail("explicit_owned_boundary_required");
  return { work: args[1], pgBin: args[3] };
}

export function boundaryCommand(line) {
  if (typeof line !== "string" || Buffer.byteLength(line) > boundaryLimits.commandBytes ||
      !/^\s*\{\s*"command"\s*:\s*"(ARM|RELEASE|STOP)"\s*\}\s*$/.test(line)) fail("invalid_boundary_command");
  return JSON.parse(line).command;
}

export class BoundaryCommandDecoder {
  buffer = ""; bytes = 0; stopped = false; seen = new Set();
  push(chunk) {
    if (this.stopped || typeof chunk !== "string") fail("commands_after_stop");
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > 3 * (boundaryLimits.commandBytes + 1)) fail("boundary_input_limit");
    this.buffer += chunk;
    const commands = [];
    while (this.buffer.includes("\n")) {
      const end = this.buffer.indexOf("\n"), command = boundaryCommand(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
      if (this.seen.has(command)) fail("repeated_boundary_command");
      this.seen.add(command); commands.push(command);
      if (command === "STOP") {
        this.stopped = true;
        if (this.buffer.length) fail("commands_after_stop");
      }
    }
    if (Buffer.byteLength(this.buffer) > boundaryLimits.commandBytes) fail("boundary_input_limit");
    return commands;
  }
  end() {
    if (!this.stopped || this.buffer.length) fail("eof_before_stop");
  }
}

export function boundaryTransition(state, command) {
  if (command === "ARM" && state === "READY") return "ARMING";
  if (command === "RELEASE" && state === "BLOCKED") return "RELEASING";
  if (command === "STOP" && ["READY", "ARMED", "BLOCKED", "RELEASED"].includes(state)) return "STOPPING";
  fail("boundary_command_out_of_order");
}

function ownedPath(file, type, mode) {
  const stat = fs.lstatSync(file);
  if (stat.uid !== process.getuid() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file) ||
      (type === "directory" ? !stat.isDirectory() : type === "socket" ? !stat.isSocket() : !stat.isFile()) ||
      (mode !== undefined && (stat.mode & 0o777) !== mode) || (type !== "socket" && (stat.mode & 0o022))) fail("unsafe_owned_path");
  return stat;
}

function readOwned(file, maximum, mode) {
  const before = ownedPath(file, "file", mode), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.dev !== before.dev || stat.ino !== before.ino ||
        (stat.mode & 0o777) !== mode || stat.size < 1 || stat.size > maximum) fail("unsafe_owned_metadata");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function boundaryPostmaster(text, work, nowSeconds = Date.now() / 1000) {
  const fields = text.split("\n"), pid = Number(fields[0]), port = Number(fields[3]), epoch = Number(fields[2]);
  if (!Number.isInteger(pid) || pid < 2 || fields[1] !== path.join(work, "database") ||
      !/^[0-9]+$/.test(fields[2]) || !Number.isSafeInteger(epoch) || epoch < 1 || epoch > nowSeconds ||
      !Number.isInteger(port) || port < 1024 || port > 65535 || port === 5432 ||
      fields[4] !== path.join(work, "socket") || fields[5] !== "127.0.0.1" || fields[7] !== "ready   ") fail("postmaster_identity_mismatch");
  return { pid, port, epoch };
}

function nativeContext({ work, pgBin }) {
  if (process.platform !== "darwin") fail("native_macos_required");
  const data = path.join(work, "database"), socket = path.join(work, "socket"), home = path.join(work, "home");
  const bootstrapFile = path.join(work, "avaturn-save-socket-bootstrap.json"), pidFile = path.join(data, "postmaster.pid");
  for (const directory of [work, data, socket, home]) ownedPath(directory, "directory", 0o700);
  const bootstrapBytes = readOwned(bootstrapFile, 65536, 0o600);
  const bootstrap = validateAvaturnBootstrap(JSON.parse(bootstrapBytes));
  const pidBytes = readOwned(pidFile, 4096, 0o600), postmaster = boundaryPostmaster(pidBytes.toString("utf8"), work);
  const socketFile = path.join(socket, `.s.PGSQL.${postmaster.port}`), socketStat = ownedPath(socketFile, "socket");
  const psql = path.join(pgBin, "psql");
  if (fs.realpathSync(pgBin) !== pgBin || !fs.statSync(pgBin).isDirectory() ||
      fs.realpathSync(psql) !== psql || !fs.statSync(psql).isFile()) fail("exact_psql_required");
  fs.accessSync(psql, fs.constants.X_OK);
  const recheck = (sources = false) => {
    for (const directory of [work, data, socket, home]) ownedPath(directory, "directory", 0o700);
    if (digest(readOwned(bootstrapFile, 65536, 0o600)) !== digest(bootstrapBytes) ||
        digest(readOwned(pidFile, 4096, 0o600)) !== digest(pidBytes)) fail("native_context_changed");
    const current = ownedPath(socketFile, "socket");
    if (current.dev !== socketStat.dev || current.ino !== socketStat.ino) fail("native_socket_changed");
    process.kill(bootstrap.backend_pid, 0); process.kill(postmaster.pid, 0);
    if (sources) for (const [name, repository] of [["root", root], ["hubs", path.join(root, "hubs")], ["cloud", path.join(root, "hubs-cloud")]]) {
      const head = spawnSync("/usr/bin/git", ["-C", repository, "rev-parse", "HEAD"], {
        encoding: "utf8", timeout: 2000, maxBuffer: 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" }
      });
      if (head.error || head.signal || head.status !== 0 || head.stdout.trim() !== bootstrap.source[name]) fail("bootstrap_source_mismatch");
    }
  };
  recheck(true);
  return { work, data, socket, home, psql, pgBin, ...postmaster, recheck };
}

export function validateBoundaryContext(context) {
  if (!context || !/^\/private\/tmp\/ynret-local-[A-Za-z0-9_-]+$/.test(context.work) ||
      context.data !== path.join(context.work, "database") || context.socket !== path.join(context.work, "socket") ||
      context.home !== path.join(context.work, "home") || context.pgBin !== pgPath || context.psql !== path.join(pgPath, "psql") ||
      !Number.isInteger(context.port) || context.port < 1024 || context.port > 65535 || context.port === 5432 ||
      !Number.isSafeInteger(context.epoch) || context.epoch < 1 || context.epoch > Date.now() / 1000) fail("invalid_owned_boundary_context");
  return context;
}

function sqlIdentity(context) {
  const { data, port, epoch } = validateBoundaryContext(context);
  return `current_setting('data_directory') = ${literal(data)} AND current_setting('port') = ${literal(port)}
    AND current_user = 'profile_test' AND current_database() = 'ret_test'
    AND floor(extract(epoch FROM pg_postmaster_start_time()))::bigint = ${epoch}`;
}

function identityGuard(context, refreshStatistics = false) {
  return `DO $owned_boundary$ BEGIN IF NOT (${sqlIdentity(context)}) THEN
    RAISE EXCEPTION 'owned_boundary_identity_mismatch'; END IF;
    ${refreshStatistics ? "PERFORM pg_stat_clear_snapshot();" : ""} END $owned_boundary$;`;
}

const heldLock = `EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation'
  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND relation = 'ret0.avatars'::regclass AND mode = 'ShareRowExclusiveLock' AND granted)`;

export function boundaryArmSql(context) {
  return `BEGIN;
SET LOCAL statement_timeout = '2000ms'; SET LOCAL lock_timeout = '500ms';
SET LOCAL idle_in_transaction_session_timeout = '110000ms';
${identityGuard(context)}
LOCK TABLE ONLY ret0.avatars IN SHARE ROW EXCLUSIVE MODE NOWAIT;
SELECT json_build_object('event', 'ARMED', 'identity_verified', (${sqlIdentity(context)}), 'lock_held', (${heldLock}));`;
}

export function boundaryObserveSql(context) {
  // Read query text only INSIDE PostgreSQL to classify the statement. Never
  // return it, its parameters, account/avatar IDs or another session's PID.
  // pg_stat_activity is transaction-cached; explicitly refresh its snapshot
  // on every bounded poll while retaining the SAME real table lock.
  return `${identityGuard(context, true)}
WITH blocked AS (
  SELECT DISTINCT a.pid FROM pg_stat_activity a JOIN pg_locks w ON w.pid = a.pid
  JOIN pg_locks h ON h.locktype = w.locktype AND h.database = w.database AND h.relation = w.relation
  WHERE a.pid <> pg_backend_pid() AND a.datname = 'ret_test' AND a.usename = 'profile_test'
    AND a.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND a.backend_type = 'client backend' AND a.state = 'active' AND a.wait_event_type = 'Lock'
    AND w.locktype = 'relation' AND w.database = a.datid AND w.relation = 'ret0.avatars'::regclass
    AND w.mode = 'RowExclusiveLock' AND NOT w.granted
    AND h.pid = pg_backend_pid() AND h.mode = 'ShareRowExclusiveLock' AND h.granted
    AND pg_backend_pid() = ANY(pg_blocking_pids(a.pid))
    AND a.query ~* '^[[:space:]]*INSERT[[:space:]]+INTO[[:space:]]+("ret0"|ret0)[[:space:]]*\\.[[:space:]]*("avatars"|avatars)([[:space:]]|\\()'
)
SELECT json_build_object('event', 'POLL', 'identity_verified', (${sqlIdentity(context)}),
  'lock_held', (${heldLock}), 'blocked_insert', (SELECT count(*) = 1 FROM blocked),
  'ambiguous_insert', (SELECT count(*) > 1 FROM blocked));`;
}

export function boundaryReleaseSql(context) {
  return `ROLLBACK;
BEGIN READ ONLY; SET LOCAL statement_timeout = '2000ms'; SET LOCAL lock_timeout = '500ms';
${identityGuard(context)}
SELECT json_build_object('event', 'RELEASED', 'identity_verified', (${sqlIdentity(context)}), 'lock_held', (${heldLock}));
ROLLBACK;`;
}

export function validateBoundaryReply(value, event) {
  const fields = event === "POLL" ? "ambiguous_insert,blocked_insert,event,identity_verified,lock_held" : "event,identity_verified,lock_held";
  if (!["ARMED", "POLL", "RELEASED"].includes(event) || !value || Object.keys(value).sort().join(",") !== fields || value.event !== event || value.identity_verified !== true ||
      value.lock_held !== (event !== "RELEASED") ||
      (event === "POLL" && (typeof value.blocked_insert !== "boolean" || value.ambiguous_insert !== false))) fail("invalid_boundary_reply");
  return value;
}

export function boundaryPsqlOptions(context) {
  validateBoundaryContext(context);
  return {
    args: ["-X", "--no-password", "-qAt", "-h", context.socket, "-p", String(context.port), "-U", "profile_test", "-d", "ret_test", "-v", "ON_ERROR_STOP=1"],
    env: { PATH: `${context.pgBin}:/usr/bin:/bin`, HOME: context.home, LC_ALL: "C", PGCONNECT_TIMEOUT: "2",
      PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null", PGSYSCONFDIR: context.home }
  };
}

// Injectable PROCESS TRANSPORT only, for pure lifecycle tests. No product,
// authentication, HTTP, browser callback or PostgreSQL result is synthesized.
export function createBoundaryPeer(context, spawnProcess = spawn) {
  const options = boundaryPsqlOptions(context);
  const child = spawnProcess(context.psql, options.args, { env: options.env, stdio: ["pipe", "pipe", "ignore"], detached: false });
  const ownCloseCancellation = Object.freeze({});
  let pending, buffer = "", closed = false, closing = false, closePromise, outputBytes = 0, transportFailed = false;
  const rejectPending = reason => { if (pending) { clearTimeout(pending.timer); pending.reject(reason ?? new Error("owned_peer_transport_failed")); pending = undefined; } };
  const exited = new Promise(resolve => {
    child.once("error", () => { transportFailed = true; rejectPending(); });
    child.once("close", (code, signal) => { closed = true; rejectPending(); resolve({ exited: true, clean: code === 0 && !signal && !transportFailed }); });
  });
  child.stdin.on("error", () => { transportFailed = true; rejectPending(); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (closing) return;
    outputBytes += Buffer.byteLength(chunk); buffer += chunk;
    if (outputBytes > 256 * 1024 || Buffer.byteLength(buffer) > 4096) { transportFailed = true; rejectPending(); return; }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const response = pending; pending = undefined;
      if (!response) { transportFailed = true; continue; }
      clearTimeout(response.timer);
      try { response.resolve(validateBoundaryReply(JSON.parse(line), response.event)); }
      catch { transportFailed = true; response.reject(new Error("owned_peer_reply_failed")); }
    }
  });
  return {
    isOwnCloseCancellation(reason) { return reason === ownCloseCancellation; },
    request(event) {
      if (closed || closing || pending || transportFailed) return Promise.reject(new Error("owned_peer_unavailable"));
      if (!["ARMED", "POLL", "RELEASED"].includes(event)) return Promise.reject(new Error("invalid_owned_peer_operation"));
      const sql = event === "ARMED" ? boundaryArmSql(context) : event === "POLL" ? boundaryObserveSql(context) : boundaryReleaseSql(context);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { transportFailed = true; rejectPending(); }, boundaryLimits.queryMs);
        pending = { resolve, reject, timer, event };
        child.stdin.write(sql + "\n", error => { if (error) { transportFailed = true; rejectPending(); } });
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; rejectPending(ownCloseCancellation);
      closePromise = (async () => {
        // Always roll back THIS connection; never cancel/terminate another peer.
        if (!closed) child.stdin.end("ROLLBACK;\n\\quit\n");
        const term = setTimeout(() => { if (!closed) child.kill("SIGTERM"); }, 1500);
        const kill = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2500);
        let deadline;
        try { return await Promise.race([exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("owned_peer_exit_unconfirmed")), boundaryLimits.closeMs); })]); }
        finally { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline); }
      })();
      return closePromise;
    }
  };
}

async function main() {
  const started = performance.now(), parentPid = process.ppid;
  let phase = "arguments", peer, context, state = "READY", poll, total, parent, finishing, shutdownFailed = false;
  const emit = value => process.stdout.write(JSON.stringify({ scope, ...value }) + "\n");
  const clearTimers = () => { clearTimeout(poll); clearTimeout(total); clearInterval(parent); };
  const finish = (failure = false) => {
    shutdownFailed ||= failure;
    if (finishing) return finishing;
    state = "STOPPING"; clearTimers();
    finishing = (async () => {
      let cleanup = { exited: true, clean: true };
      try { if (peer) cleanup = await peer.close(); }
      catch { cleanup = { exited: false, clean: false }; }
      const ok = !shutdownFailed && cleanup.exited && cleanup.clean;
      state = "STOPPED";
      emit({ event: ok ? "STOPPED" : "FAIL", ...(ok ? {} : { failed_check: phase }),
        owned_peer_started: Boolean(peer), owned_peer_exited: Boolean(peer) && cleanup.exited,
        graceful_rollback_exit: Boolean(peer) && cleanup.clean, native_runtime_not_stopped: true });
      if (!ok) process.exitCode = 1;
      process.stdin.pause();
    })();
    return finishing;
  };
  try {
    const args = boundaryArguments(process.argv.slice(2));
    phase = "owned-native-identity"; context = nativeContext(args);
    const decoder = new BoundaryCommandDecoder(); let commands = Promise.resolve();
    const observe = async () => {
      try {
        if (state !== "ARMED") return;
        phase = "blocked-insert-observation"; context.recheck();
        const value = await peer.request("POLL");
        if (state !== "ARMED") return;
        if (value.blocked_insert) {
          state = "BLOCKED";
          emit({ event: "BLOCKED_INSERT", genuine_statement: true, same_owned_database: true, own_relation_blocker: true });
        } else poll = setTimeout(observe, boundaryLimits.pollMs);
      } catch (error) {
        // Suppress only this peer's opaque cancellation created by close().
        // Any other rejection remains a failure, even if STOP already started.
        if (!finishing || !peer?.isOwnCloseCancellation(error)) await finish(true);
      }
    };
    const command = async name => {
      if (finishing) return;
      phase = "closed-command-order";
      state = boundaryTransition(state, name);
      if (name === "STOP") {
        phase = "owned-peer-cleanup"; return finish();
      }
      context.recheck(true);
      if (performance.now() - started >= boundaryLimits.totalMs - 7000) fail("boundary_deadline");
      if (name === "ARM") {
        phase = "table-lock-nowait"; peer = createBoundaryPeer(context);
        await peer.request("ARMED");
        if (finishing) return;
        state = "ARMED";
        emit({ event: "ARMED", identity_verified: true, lock_held: true, only_avatars_locked: true });
        poll = setTimeout(observe, boundaryLimits.pollMs);
      } else {
        phase = "owned-lock-release"; clearTimeout(poll);
        await peer.request("RELEASED");
        if (finishing) return;
        state = "RELEASED";
        emit({ event: "RELEASED", identity_verified: true, lock_held: false, late_backend_completion_permitted: true });
      }
    };
    total = setTimeout(() => { phase = "boundary-total-deadline"; void finish(true); }, Math.max(1, boundaryLimits.totalMs - (performance.now() - started)));
    parent = setInterval(() => {
      try { if (parentPid < 2 || process.ppid !== parentPid) fail("parent_lost"); process.kill(parentPid, 0); }
      catch { phase = "parent-loss"; void finish(true); }
    }, 500);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { phase = "signal-cleanup"; void finish(true); });
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      try {
        for (const name of decoder.push(chunk)) commands = commands.then(() => command(name));
        commands.catch(() => { void finish(true); });
      } catch { phase = "closed-command-parser"; void finish(true); }
    });
    process.stdin.once("end", () => { try { decoder.end(); } catch { phase = "eof-before-stop"; void finish(true); } });
    process.stdin.once("error", () => { phase = "stdin-error"; void finish(true); });
    emit({ event: "READY", native_identity_checked: true, maximum_seconds: 120, row_writes: false });
  } catch { await finish(true); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

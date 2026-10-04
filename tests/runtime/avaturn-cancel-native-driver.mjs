// TEST ONLY. Owns only the native wrapper/SQL boundary children it starts.
// Build/server/browser remain outside. ARM follows a real visible SDK Next.
// OBSERVATIONS_PENDING is diagnostic, NEVER browser/negative acceptance.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browserOrigin, validateAvaturnBootstrap, avaturnRequestEvent, avaturnResponseEvent } from "./reticulum-local.mjs";
import { boundaryPostmaster, validateBoundaryContext, boundaryPsqlOptions, boundaryLimits } from "./avaturn-save-sql-boundary.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pgPath = "/opt/homebrew/Cellar/postgresql@14/14.23/bin";
const scope = "test-only-owned-avaturn-cancellation-not-acceptance";
const fail = code => { throw new Error(code); };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
export const cancelDriverLimits = Object.freeze({ commandBytes: 128, frameBytes: 4096,
  nativeBytes: 1024 * 1024, peerBytes: 256 * 1024, queryMs: boundaryLimits.queryMs,
  peerCloseMs: boundaryLimits.closeMs, nativeStopMs: 15000 });

export function cancelDriverArguments(args) {
  if (args.length !== 8 || args[0] !== "--pg-bin" || args[1] !== pgPath || args[2] !== "--cache-reticulum" ||
      args[4] !== "--browser-origin" || args[6] !== "--hex-cache" ||
      ![args[3], args[7]].every(value => typeof value === "string" && path.isAbsolute(value) &&
        path.normalize(value) === value && !value.includes("\0") && Buffer.byteLength(value) <= 1024)) fail("explicit_cancel_driver_target_required");
  browserOrigin(args[5]);
  return { args: ["--avaturn-save-browser", ...args], pgBin: args[1], browserOrigin: args[5] };
}

export class CancelCommandDecoder {
  buffer = ""; bytes = 0; seen = new Set(); stopped = false;
  push(chunk) {
    if (this.stopped || typeof chunk !== "string") fail("cancel_commands_after_stop");
    this.bytes += Buffer.byteLength(chunk); this.buffer += chunk;
    if (this.bytes > 2 * (cancelDriverLimits.commandBytes + 1)) fail("cancel_input_limit");
    const commands = [];
    while (this.buffer.includes("\n")) {
      const end = this.buffer.indexOf("\n"), line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > cancelDriverLimits.commandBytes ||
          !/^\s*\{\s*"command"\s*:\s*"(ARM|STOP)"\s*\}\s*$/.test(line)) fail("invalid_cancel_command");
      const command = JSON.parse(line).command;
      if (this.seen.has(command)) fail("duplicate_cancel_command");
      this.seen.add(command); commands.push(command);
      if (command === "STOP") { this.stopped = true; if (this.buffer.length) fail("cancel_commands_after_stop"); }
    }
    if (Buffer.byteLength(this.buffer) > cancelDriverLimits.commandBytes) fail("cancel_input_limit");
    return commands;
  }
  end() { if (!this.stopped || this.buffer.length) fail("cancel_eof_without_stop"); }
}

export class CancelFrameDecoder {
  buffer = ""; bytes = 0;
  constructor(maximum) { this.maximum = maximum; }
  push(chunk) {
    if (typeof chunk !== "string") fail("invalid_cancel_frame");
    this.bytes += Buffer.byteLength(chunk); this.buffer += chunk;
    if (this.bytes > this.maximum) fail("cancel_output_limit");
    const lines = [];
    while (this.buffer.includes("\n")) {
      const end = this.buffer.indexOf("\n"), line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > cancelDriverLimits.frameBytes) fail("cancel_frame_limit");
      lines.push(line);
    }
    if (Buffer.byteLength(this.buffer) > cancelDriverLimits.frameBytes) fail("cancel_frame_limit");
    return lines;
  }
  end() { if (this.buffer.length) fail("cancel_output_not_framed"); }
}

export function cancelDrainSql(context) {
  validateBoundaryContext(context);
  if (typeof context.accountId !== "string" || !/^[1-9][0-9]{0,18}$/.test(context.accountId) ||
      BigInt(context.accountId) > 9223372036854775807n || !/^ui-socket-[0-9]+@example\.invalid$/.test(context.email)) fail("invalid_cancel_owner");
  const identity = `current_setting('data_directory') = ${literal(context.data)} AND current_setting('port') = ${literal(context.port)}
    AND current_user = 'profile_test' AND current_database() = 'ret_test'
    AND current_setting('transaction_read_only') = 'on'
    AND floor(extract(epoch FROM pg_postmaster_start_time()))::bigint = ${context.epoch}`;
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout = '2000ms'; SET LOCAL lock_timeout = '500ms';
DO $owned_cancel$ BEGIN IF NOT (${identity}) THEN RAISE EXCEPTION 'owned_cancel_identity_mismatch'; END IF;
PERFORM pg_stat_clear_snapshot(); END $owned_cancel$;
SELECT json_build_object('identity_verified', (${identity}),
  'own_account_equal', (SELECT count(*) = 1 FROM ret0.accounts own_account JOIN ret0.logins own_login USING (account_id)
    WHERE own_account.account_id = ${context.accountId} AND own_account.state::text = 'enabled' AND own_login.identifier_hash IS NOT NULL),
  'creator_off_equal', (SELECT count(*) = 1 AND bool_and(value = '{"value":false}'::jsonb AND owned_file_id IS NULL)
    FROM ret0.app_configs WHERE key = 'features|enable_avaturn_creator'),
  'owned_avatar_count', (SELECT count(*) FROM ret0.avatars WHERE account_id = ${context.accountId}),
  'active_insert_count', (SELECT count(*) FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid()
    AND a.datname = current_database() AND a.usename = current_user AND a.backend_type = 'client backend' AND a.state = 'active'
    AND a.query ~* '^[[:space:]]*INSERT[[:space:]]+INTO[[:space:]]+("ret0"|ret0)[[:space:]]*\\.[[:space:]]*("avatars"|avatars)([[:space:]]|\\()'));
ROLLBACK;`;
}

export function validateCancelDrain(value) {
  if (!value || Object.keys(value).sort().join(",") !== "active_insert_count,creator_off_equal,identity_verified,own_account_equal,owned_avatar_count" ||
      ![value.identity_verified, value.own_account_equal, value.creator_off_equal].every(item => typeof item === "boolean") ||
      ![value.owned_avatar_count, value.active_insert_count].every(item => Number.isSafeInteger(item) && item >= 0)) fail("invalid_cancel_drain_reply");
  if (value.identity_verified !== true || value.own_account_equal !== true || value.creator_off_equal !== true ||
      value.owned_avatar_count !== 0 || value.active_insert_count !== 0) {
    const error = new Error("cancel_drain_not_proven");
    error.cancelDrainObservation = Object.freeze({ identity_verified: value.identity_verified, own_account_equal: value.own_account_equal,
      creator_off_equal: value.creator_off_equal, zero_rows: value.owned_avatar_count === 0, active_insert_drained: value.active_insert_count === 0 });
    throw error;
  }
  return Object.freeze({ ...value });
}

function ownedPath(file, type, mode) {
  const stat = fs.lstatSync(file);
  if (stat.uid !== process.getuid() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file) ||
      (type === "directory" ? !stat.isDirectory() : type === "socket" ? !stat.isSocket() : !stat.isFile()) ||
      (mode !== undefined && (stat.mode & 0o777) !== mode) || (type !== "socket" && (stat.mode & 0o022))) fail("unsafe_cancel_owned_path");
  return stat;
}

function readOwned(file, maximum, mode) {
  const before = ownedPath(file, "file", mode), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile() || after.uid !== process.getuid() ||
        (after.mode & 0o777) !== mode || after.size < 1 || after.size > maximum) fail("unsafe_cancel_owned_file");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function samePath(before, after, content = false) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid || before.mode !== after.mode ||
      (content && (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs))) fail("cancel_context_changed");
}

// Private existing bootstrap only, no password/credential files or content output.
function nativeDrainContext(bootstrapFile, pgBin) {
  if (process.platform !== "darwin") fail("native_macos_required");
  const work = path.dirname(bootstrapFile);
  if (!/^\/private\/tmp\/ynret-local-[A-Za-z0-9_-]+$/.test(work) || bootstrapFile !== path.join(work, "avaturn-save-socket-bootstrap.json")) fail("invalid_cancel_bootstrap_path");
  const data = path.join(work, "database"), socket = path.join(work, "socket"), home = path.join(work, "home");
  const directories = [work, data, socket, home].map(file => ({ file, stat: ownedPath(file, "directory", 0o700) }));
  const bootstrapStat = ownedPath(bootstrapFile, "file", 0o600), bootstrapBytes = readOwned(bootstrapFile, 65536, 0o600);
  const bootstrap = validateAvaturnBootstrap(JSON.parse(bootstrapBytes));
  const pidFile = path.join(data, "postmaster.pid"), pidStat = ownedPath(pidFile, "file", 0o600), pidBytes = readOwned(pidFile, 4096, 0o600);
  const postmaster = boundaryPostmaster(pidBytes.toString("utf8"), work);
  const socketFile = path.join(socket, `.s.PGSQL.${postmaster.port}`), socketStat = ownedPath(socketFile, "socket"), psql = path.join(pgBin, "psql");
  if (pgBin !== pgPath || fs.realpathSync(pgBin) !== pgBin || !fs.statSync(pgBin).isDirectory() || fs.realpathSync(psql) !== psql) fail("exact_cancel_psql_required");
  fs.accessSync(psql, fs.constants.X_OK);
  const context = { work, data, socket, home, pgBin, psql, ...postmaster, accountId: bootstrap.account_id, email: bootstrap.auth_email };
  const recheck = () => {
    for (const { file, stat } of directories) samePath(stat, ownedPath(file, "directory", 0o700));
    samePath(bootstrapStat, ownedPath(bootstrapFile, "file", 0o600), true); samePath(pidStat, ownedPath(pidFile, "file", 0o600), true);
    if (digest(readOwned(bootstrapFile, 65536, 0o600)) !== digest(bootstrapBytes) || digest(readOwned(pidFile, 4096, 0o600)) !== digest(pidBytes)) fail("cancel_context_changed");
    samePath(socketStat, ownedPath(socketFile, "socket")); process.kill(bootstrap.backend_pid, 0); process.kill(postmaster.pid, 0);
    for (const [name, repository] of [["root", root], ["hubs", path.join(root, "hubs")], ["cloud", path.join(root, "hubs-cloud")]]) {
      const options = { encoding: "utf8", timeout: 2000, maxBuffer: 65536,
        env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } };
      const head = spawnSync("/usr/bin/git", ["--no-optional-locks", "-C", repository, "rev-parse", "HEAD"], options);
      const status = spawnSync("/usr/bin/git", ["--no-optional-locks", "-C", repository, "status", "--porcelain", "--untracked-files=all"], options);
      if (head.error || head.signal || head.status !== 0 || head.stdout.trim() !== bootstrap.source[name] ||
          status.error || status.signal || status.status !== 0 || status.stdout.trim()) fail("cancel_source_not_frozen");
    }
  };
  recheck();
  return () => {
    recheck(); const options = boundaryPsqlOptions(context);
    const result = spawnSync(psql, options.args, { input: cancelDrainSql(context), env: options.env,
      encoding: "utf8", timeout: cancelDriverLimits.queryMs, maxBuffer: 4096 });
    if (result.error || result.signal || result.status !== 0 || !result.stdout?.trim()) fail("cancel_read_only_query_failed");
    const projection = validateCancelDrain(JSON.parse(result.stdout)); recheck(); return projection;
  };
}

const peerScope = "owned-local-avaturn-save-not-production";
const keys = (value, expected) => value && Object.keys(value).sort().join(",") === expected;

// Injectable child TRANSPORT/read-only projection for pure cleanup/order tests.
// No product, SQL, auth, SDK or browser results are manufactured by this driver.
export function createCancelDriver({ options, spawnProcess = spawn, createReadback = nativeDrainContext, emit = () => {} }) {
  let state = "BOOTING", native, peer, readback, work, failure, finishing, nativeStopped = false,
    nativeResult = false, peerStopped = false, lifecycle = null, responseCount = 0, drainStarted = false,
    peerReady = false, peerStopRequested = false;
  let nativeClose, peerClose, peerCloseAttempt, nativeClosed = false, peerClosed = false, nativeExit, peerExit;
  const output = value => emit({ scope, ...value });
  const reportDrainFailure = error => {
    const value = error?.cancelDrainObservation;
    if (value && Object.keys(value).sort().join(",") === "active_insert_drained,creator_off_equal,identity_verified,own_account_equal,zero_rows" &&
        Object.values(value).every(item => typeof item === "boolean")) output({ event: "DRAIN_STATE", ...value, acceptance: "NOT_RUNTIME_ACCEPTED" });
  };
  const write = (child, command) => {
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) fail("cancel_child_not_writable");
    child.stdin.write(JSON.stringify({ command }) + "\n");
  };
  const attach = (child, source, decoder, line) => {
    child.stdout.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    let errorBytes = 0;
    child.stdout.on("data", chunk => { try { for (const value of decoder.push(chunk)) line(value); } catch { void finish("cancel_invalid_" + source + "_output"); } });
    // Retain/output no stderr content, including runtime exception stacktraces.
    child.stderr?.on("data", chunk => { errorBytes += Buffer.byteLength(chunk); if (errorBytes > decoder.maximum) void finish("cancel_" + source + "_stderr_limit"); });
    child.stdin.on("error", () => { void finish("cancel_" + source + "_stdin_error"); });
    child.once("error", () => { void finish("cancel_" + source + "_spawn_error"); });
    return new Promise(resolve => child.once("close", (code, signal) => {
      let framed = true;
      try { decoder.end(); } catch { framed = false; failure ||= "cancel_" + source + "_unframed_exit"; }
      if (source === "native") nativeClosed = true; else peerClosed = true;
      const result = { code, signal, framed };
      if (source === "native") nativeExit = result; else peerExit = result;
      resolve(result);
      if (!finishing && (!framed || code !== 0 || signal || (source === "peer" ? !peerStopped : !nativeStopped || !nativeResult))) void finish("cancel_" + source + "_unclean_exit");
    }));
  };
  const waitClose = async (promise, child, milliseconds) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => {
      // Only THIS started child, never a discovered PID or process group.
      child.kill("SIGTERM"); reject(new Error("cancel_owned_close_unconfirmed"));
    }, milliseconds); })]); } finally { clearTimeout(timer); }
  };
  const closePeer = () => {
    if (!peer) return Promise.resolve();
    // One attempt, including its rejection: finish() must not restart the 4s
    // close budget or signal the same unconfirmed peer a second time.
    peerCloseAttempt ??= Promise.resolve().then(async () => {
      if (!peerClosed && !peerStopRequested) { peerStopRequested = true; write(peer, "STOP"); }
      const result = await waitClose(peerClose, peer, cancelDriverLimits.peerCloseMs);
      if (result.code !== 0 || result.signal || !result.framed || !peerStopped) fail("cancel_peer_stop_not_zero");
    });
    return peerCloseAttempt;
  };
  const finish = reason => {
    if (reason) failure ||= reason;
    if (finishing) return finishing;
    state = "FINISHING";
    finishing = Promise.resolve().then(async () => {
      // Preserve the first failure. Attempt peer cleanup before native STOP;
      // an unconfirmed close stays FAIL and never becomes peer STOP0.
      try { await closePeer(); } catch { failure ||= "cancel_peer_cleanup_failed"; }
      if (native && !nativeClosed) {
        try { if (work) { write(native, "STOP"); native.stdin.end(); } else native.stdin.end(); }
        catch { failure ||= "cancel_native_stop_write_failed"; }
      }
      try {
        if (native) {
          const result = await waitClose(nativeClose, native, cancelDriverLimits.nativeStopMs);
          if (result.code !== 0 || result.signal || !result.framed || !nativeStopped || !nativeResult) failure ||= "cancel_native_stop_not_zero";
        }
      } catch { failure ||= "cancel_native_cleanup_unconfirmed"; }
      state = "CLOSED";
      output({ event: failure ? "FAIL" : "STOPPED", ...(failure ? { reason: failure } : {}),
        peer_stop_zero: Boolean(peer) && peerStopped && peerExit?.code === 0 && !peerExit?.signal && peerExit?.framed,
        native_stop_zero: nativeStopped && nativeResult && nativeExit?.code === 0 && !nativeExit?.signal && nativeExit?.framed,
        peer_exit_code: peerExit?.code ?? null, native_exit_code: nativeExit?.code ?? null,
        browser_acceptance: "NOT_RECORDED", acceptance: "NOT_RUNTIME_ACCEPTED" });
      return { failed: Boolean(failure), reason: failure, state };
    });
    return finishing;
  };
  const drain = async () => {
    if (drainStarted || finishing || state !== "OFF_APPLIED" || !lifecycle?.request_down) return;
    drainStarted = true;
    try {
      // Exact owned DOWN permits observation, not a cancellation verdict.
      if (!["pending", "router_exception"].includes(lifecycle.terminal) || responseCount !== 0) {
        output({ event: "TERMINAL_DIAGNOSTIC", terminal: lifecycle.terminal, correlated_down: true, acceptance: "NOT_RUNTIME_ACCEPTED" });
        fail("cancel_terminal_unresolved");
      }
      validateCancelDrain(await readback());
      if (finishing) return;
      state = "RELEASE_SENT"; write(peer, "RELEASE");
    } catch (error) { reportDrainFailure(error); await finish("cancel_drain_or_terminal_failed"); }
  };
  const nativeEvent = event => {
    if (event.phase === "READY" && keys(event, "bootstrap,phase,pid") && state === "BOOTING" &&
        Number.isInteger(event.pid) && event.pid > 1 && /^\/private\/tmp\/ynret-local-[A-Za-z0-9_-]+\/avaturn-save-socket-bootstrap\.json$/.test(event.bootstrap)) {
      work = path.dirname(event.bootstrap); readback = createReadback(event.bootstrap, options.pgBin);
      state = "READY"; output({ event: "READY", bootstrap: event.bootstrap, acceptance: "NOT_RUNTIME_ACCEPTED" });
    } else if (event.phase === "SQL_APPLIED" && keys(event, "phase,profile") && event.profile === "CREATOR_OFF" && state === "OFF_SENT") {
      state = "OFF_APPLIED"; output({ event: "SQL_APPLIED", creator_off: true }); void drain();
    } else if (["AVATAR_RESPONSE_STATE", "AVATAR_RESPONSE_STOP"].includes(event.phase) && work && !nativeStopped) {
      responseCount = avaturnResponseEvent(event, responseCount);
    } else if (event.phase === "AVATAR_REQUEST_LIFECYCLE" && ["ARMED", "OFF_SENT", "OFF_APPLIED"].includes(state)) {
      lifecycle = avaturnRequestEvent(event, lifecycle);
      output({ event: "REQUEST_LIFECYCLE", attempt_count: 1, correlated_down: lifecycle.request_down,
        terminal: lifecycle.terminal, down_reason: lifecycle.down_reason, acceptance: "NOT_RUNTIME_ACCEPTED" }); void drain();
    } else if (event.phase === "STOPPED" && keys(event, "phase") && finishing && !nativeStopped) nativeStopped = true;
    else fail("cancel_native_event_out_of_order");
  };
  const nativeLine = line => {
    if (line.startsWith("RET_UI_SOCKET:")) nativeEvent(JSON.parse(line.slice(14)));
    else if (/^RET_LOCAL_STAGE:[a-z0-9-]+$/.test(line) && !nativeStopped) { /* redacted stage only */ }
    else if (line === `RET_LOCAL_RESULT:OBSERVATION_STOPPED:tests=0:scratch=${work}` && finishing && nativeStopped && !nativeResult) nativeResult = true;
    else fail("cancel_wrong_native_source");
  };
  const peerEvent = event => {
    if (event.scope !== peerScope) fail("cancel_wrong_peer_source");
    if (event.event === "READY" && keys(event, "event,maximum_seconds,native_identity_checked,row_writes,scope") &&
        state === "ARMING" && !peerReady && event.maximum_seconds === 120 && event.native_identity_checked === true && event.row_writes === false) {
      peerReady = true; write(peer, "ARM");
    } else if (event.event === "ARMED" && keys(event, "event,identity_verified,lock_held,only_avatars_locked,scope") &&
        state === "ARMING" && peerReady && event.identity_verified === true && event.lock_held === true && event.only_avatars_locked === true) {
      state = "ARMED"; output({ event: "ARMED", genuine_table_lock: true });
    } else if (event.event === "BLOCKED_INSERT" && keys(event, "event,genuine_statement,own_relation_blocker,same_owned_database,scope") &&
        state === "ARMED" && event.genuine_statement === true && event.own_relation_blocker === true && event.same_owned_database === true) {
      // Critical edge: no model, timer, readback or await between BLOCKED and OFF.
      state = "OFF_SENT"; write(native, "CREATOR_OFF"); output({ event: "BLOCKED_INSERT", creator_off_sent: true });
    } else if (event.event === "RELEASED" && keys(event, "event,identity_verified,late_backend_completion_permitted,lock_held,scope") &&
        state === "RELEASE_SENT" && event.identity_verified === true && event.lock_held === false && event.late_backend_completion_permitted === true) {
      state = "RELEASED";
      void (async () => {
        try {
          validateCancelDrain(await readback());
          if (finishing) return;
          state = "PEER_STOPPING"; await closePeer();
          if (finishing) return;
          state = "OBSERVATIONS_PENDING";
          output({ event: "OBSERVATIONS_PENDING", peer_stop_zero: true, correlated_down: true,
            native_runtime_alive: true, browser_acceptance: "NOT_RECORDED", acceptance: "NOT_RUNTIME_ACCEPTED" });
        } catch (error) { reportDrainFailure(error); await finish("cancel_post_release_or_peer_stop_failed"); }
      })();
    } else if (["STOPPED", "FAIL"].includes(event.event) && keys(event, event.event === "STOPPED" ?
      "event,graceful_rollback_exit,native_runtime_not_stopped,owned_peer_exited,owned_peer_started,scope" :
      "event,failed_check,graceful_rollback_exit,native_runtime_not_stopped,owned_peer_exited,owned_peer_started,scope")) {
      const emptyCleanup = finishing && event.owned_peer_started === false && event.owned_peer_exited === false && event.graceful_rollback_exit === false;
      if (event.event !== "STOPPED" || (!emptyCleanup && (event.owned_peer_started !== true || event.owned_peer_exited !== true ||
          event.graceful_rollback_exit !== true)) || event.native_runtime_not_stopped !== true || !peerStopRequested ||
          (!finishing && state !== "PEER_STOPPING") || peerStopped) fail("cancel_peer_terminal_failed");
      peerStopped = true;
    } else fail("cancel_peer_event_out_of_order");
  };
  native = spawnProcess(process.execPath, [path.join(root, "tests/runtime/reticulum-local.mjs"), ...options.args],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"], detached: false,
      env: { PATH: process.env.PATH, LANG: "C", TZ: "UTC" } });
  nativeClose = attach(native, "native", new CancelFrameDecoder(cancelDriverLimits.nativeBytes), nativeLine);
  return {
    command(command) {
      try {
        if (command === "STOP" && state === "OBSERVATIONS_PENDING") return finish();
        if (command !== "ARM" || state !== "READY" || peer || finishing) fail("cancel_command_out_of_order");
        state = "ARMING";
        peer = spawnProcess(process.execPath, [path.join(root, "tests/runtime/avaturn-save-sql-boundary.mjs"), "--work", work, "--pg-bin", options.pgBin],
          { cwd: root, stdio: ["pipe", "pipe", "pipe"], detached: false, env: { PATH: process.env.PATH, LANG: "C", TZ: "UTC" } });
        peerClose = attach(peer, "peer", new CancelFrameDecoder(cancelDriverLimits.peerBytes), line => peerEvent(JSON.parse(line)));
      } catch { return finish("cancel_command_out_of_order"); }
    },
    fail(reason = "cancel_input_failed") { return finish(reason); },
    get state() { return state; },
    get completion() { return finishing; }
  };
}

async function main() {
  let driver;
  try {
    const options = cancelDriverArguments(process.argv.slice(2)), decoder = new CancelCommandDecoder();
    const emit = value => {
      process.stdout.write(JSON.stringify(value) + "\n");
      if (["FAIL", "STOPPED"].includes(value.event)) { if (value.event === "FAIL") process.exitCode = 1; process.stdin.pause(); }
    };
    driver = createCancelDriver({ options, emit });
    const finishInput = reason => { void driver.fail(reason).then(result => { if (result.failed) process.exitCode = 1; process.stdin.pause(); }); };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      try {
        for (const command of decoder.push(chunk)) {
          const done = driver.command(command);
          if (done) void done.then(result => { if (result.failed) process.exitCode = 1; process.stdin.pause(); });
        }
      } catch { finishInput("cancel_invalid_input"); }
    });
    process.stdin.once("end", () => { try { decoder.end(); } catch { finishInput("cancel_eof_without_stop"); } });
    process.stdin.once("error", () => finishInput("cancel_stdin_error"));
    process.stdout.once("error", () => finishInput("cancel_stdout_error"));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => finishInput("cancel_signal_cleanup"));
  } catch {
    if (driver) await driver.fail("cancel_startup_failed");
    else process.stdout.write(JSON.stringify({ scope, event: "FAIL", reason: "cancel_arguments_failed", acceptance: "NOT_RUNTIME_ACCEPTED" }) + "\n");
    process.exitCode = 1; process.stdin.pause();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

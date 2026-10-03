// PURE parser/identity/SQL-shape and mocked PROCESS TRANSPORT tests only.
// None of these tests proves a PostgreSQL INSERT, lock or browser acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  boundaryArguments, boundaryCommand, BoundaryCommandDecoder, boundaryTransition,
  boundaryPostmaster, validateBoundaryContext, boundaryArmSql, boundaryObserveSql,
  boundaryReleaseSql, validateBoundaryReply, boundaryPsqlOptions, createBoundaryPeer,
  boundaryLimits
} from "./avaturn-save-sql-boundary.mjs";

const pgBin = "/opt/homebrew/Cellar/postgresql@14/14.23/bin";
const work = "/private/tmp/ynret-local-Abc123";
const context = {
  work, data: `${work}/database`, socket: `${work}/socket`, home: `${work}/home`,
  pgBin, psql: `${pgBin}/psql`, port: 15439, epoch: 1780000000
};
const reply = (event, extras = {}) => ({ event, identity_verified: true, lock_held: event !== "RELEASED", ...extras });
const pollReply = extras => reply("POLL", { blocked_insert: false, ambiguous_insert: false, ...extras });

function fakeTransport({ autoExit = true } = {}) {
  const child = new EventEmitter(), writes = [], kills = [], invocations = [];
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(chunk.toString()); callback(); } });
  child.stdin.once("finish", () => { if (autoExit) child.emit("close", 0, null); });
  child.kill = signal => { kills.push(signal); child.emit("close", null, signal); return true; };
  return {
    child, writes, kills, invocations,
    spawnProcess(...args) { invocations.push(args); return child; },
    respond(value) { child.stdout.write(JSON.stringify(value) + "\n"); }
  };
}

function realLifecycle(transport) {
  // Execute literal current main() closures, NOT a replica of their behavior.
  // Only process I/O/exit and the psql child are simulated. Native context,
  // stdin registration, SQL execution, provider and browser never run here.
  const source = fs.readFileSync(new URL("./avaturn-save-sql-boundary.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function main() {"));
  const extract = (begin, end) => {
    const start = body.indexOf(begin), stop = body.indexOf(end, start + begin.length);
    assert.ok(start >= 0 && stop > start, "real lifecycle anchors must remain exact");
    return body.slice(start, stop);
  };
  const header = extract("  const started =", "  const finish =");
  const finish = extract("  const finish = (failure = false) => {", "\n  try {\n    const args =");
  const observe = extract("    const observe = async () => {", "    const command = async name => {");
  const command = extract("    const command = async name => {", "    total = setTimeout(");
  const events = [], unitProcess = {
    ppid: 2, exitCode: 0, stdin: { pause() {} },
    stdout: { write(line) { events.push(JSON.parse(line)); } }
  };
  // This pure shape validation is not native-context/identity proof.
  const unitContext = { ...context, recheck() { validateBoundaryContext(this); } };
  const peer = createBoundaryPeer(unitContext, transport.spawnProcess);
  const factory = new Function("peerTransport", "contextData", "process", "scope", "boundaryLimits", "boundaryTransition", "createBoundaryPeer", [
    header, finish, observe, command,
    'peer = peerTransport; context = contextData; state = "ARMED";',
    "return { observe, command };"
  ].join("\n"));
  const lifecycle = factory(peer, unitContext, unitProcess, "process-transport-lifecycle-oracle", boundaryLimits, boundaryTransition, createBoundaryPeer);
  return { ...lifecycle, events, unitProcess };
}

test("explicit finite owned macOS target only", () => {
  assert.deepEqual(boundaryArguments(["--work", work, "--pg-bin", pgBin]), { work, pgBin });
  for (const args of [[], ["--work", "/tmp/ynret-local-Abc123", "--pg-bin", pgBin],
    ["--work", `${work}/../another`, "--pg-bin", pgBin], ["--work", work, "--pg-bin", "/usr/bin"],
    ["--pg-bin", pgBin, "--work", work], ["--work", work, "--pg-bin", pgBin, "--force"]]) {
    assert.throws(() => boundaryArguments(args));
  }
  assert.ok(boundaryLimits.totalMs + 6000 + boundaryLimits.closeMs <= 120000);
});

test("closed NDJSON syntax rejects unknown fields, commands, duplicates and oversize", () => {
  for (const command of ["ARM", "RELEASE", "STOP"]) assert.equal(boundaryCommand(`{"command":"${command}"}`), command);
  for (const line of ["", "ARM", '{"command":"CREATOR_OFF"}', '{"command":"ARM","extra":true}',
    '{"command":"ARM","command":"STOP"}', '{"command": "arm"}', '{"command": ["ARM"]}',
    " ".repeat(129), '{"command":"ARM"}\n{"command":"STOP"}']) assert.throws(() => boundaryCommand(line));
  const decoder = new BoundaryCommandDecoder();
  assert.deepEqual(decoder.push('{"comm'), []);
  assert.deepEqual(decoder.push('and":"ARM"}\n'), ["ARM"]);
  assert.throws(() => decoder.push('{"command":"ARM"}\n'));
});

test("complete STOP newline is mandatory, and no input is accepted afterwards", () => {
  const decoder = new BoundaryCommandDecoder();
  assert.throws(() => decoder.end());
  assert.deepEqual(decoder.push('{"command":"ARM"}\n{"command":"RELEASE"}\n{"command":"STOP"}\n'), ["ARM", "RELEASE", "STOP"]);
  decoder.end();
  assert.throws(() => decoder.push('{"command":"ARM"}\n'));
  for (const text of ['{"command":"STOP"}', '{"command":"ARM"}\n', '{"command":"STOP"}\nextra', "x".repeat(129)]) {
    const broken = new BoundaryCommandDecoder();
    assert.throws(() => { broken.push(text); broken.end(); });
  }
});

test("single lane order requires real blocked observation before RELEASE", () => {
  assert.equal(boundaryTransition("READY", "ARM"), "ARMING");
  assert.equal(boundaryTransition("BLOCKED", "RELEASE"), "RELEASING");
  for (const state of ["READY", "ARMED", "BLOCKED", "RELEASED"]) assert.equal(boundaryTransition(state, "STOP"), "STOPPING");
  for (const [state, command] of [["READY", "RELEASE"], ["ARMED", "RELEASE"], ["ARMED", "ARM"],
    ["RELEASED", "RELEASE"], ["STOPPED", "STOP"], ["READY", "UNKNOWN"]]) assert.throws(() => boundaryTransition(state, command));
});

test("postmaster must be ready on this exact private database and socket, never port 5432", () => {
  const lines = ["12345", context.data, String(context.epoch), String(context.port), context.socket, "127.0.0.1", "123 456", "ready   ", ""];
  assert.deepEqual(boundaryPostmaster(lines.join("\n"), work, context.epoch + 1), { pid: 12345, port: context.port, epoch: context.epoch });
  for (const [index, value] of [[0, "1"], [1, "/another/database"], [2, "1780000002"], [3, "5432"],
    [3, "65536"], [4, "/tmp"], [5, "*"], [7, "stopping"]]) {
    const invalid = lines.slice(); invalid[index] = value;
    assert.throws(() => boundaryPostmaster(invalid.join("\n"), work, context.epoch + 1));
  }
});

test("helper context cannot redirect the process or SQL to arbitrary local peers", () => {
  assert.equal(validateBoundaryContext(context), context);
  for (const patch of [{ work: "/tmp/ynret-local-Abc123" }, { data: "/another/database" }, { socket: "/tmp" },
    { home: "/Users/other" }, { port: 5432 }, { port: 1 }, { pgBin: "/usr/bin" }, { psql: "/bin/sh" },
    { epoch: "1; SELECT secret" }, { epoch: -1 }]) {
    assert.throws(() => boundaryArmSql({ ...context, ...patch }));
    assert.throws(() => boundaryPsqlOptions({ ...context, ...patch }));
  }
});

test("ARM SQL checks identity before a genuine NOWAIT table lock, with local bounds", () => {
  const sql = boundaryArmSql(context);
  assert.match(sql, /^BEGIN;/);
  assert.ok(sql.indexOf("owned_boundary_identity_mismatch") < sql.indexOf("LOCK TABLE"));
  assert.match(sql, /LOCK TABLE ONLY ret0\.avatars IN SHARE ROW EXCLUSIVE MODE NOWAIT;/);
  assert.match(sql, /current_user = 'profile_test' AND current_database\(\) = 'ret_test'/);
  assert.ok(sql.includes(context.data));
  assert.match(sql, /pg_postmaster_start_time/);
  assert.match(sql, /statement_timeout = '2000ms'/);
  assert.match(sql, /lock_timeout = '500ms'/);
  assert.match(sql, /idle_in_transaction_session_timeout = '110000ms'/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|GRANT|CREATE|ALTER|pg_cancel_backend|pg_terminate_backend)\b/);
});

test("observer refreshes transaction statistics and joins actual waiting and own granted relation locks", () => {
  const sql = boundaryObserveSql(context);
  assert.match(sql, /PERFORM pg_stat_clear_snapshot\(\)/);
  assert.match(sql, /FROM pg_stat_activity a JOIN pg_locks w ON w\.pid = a\.pid/);
  assert.match(sql, /JOIN pg_locks h/);
  assert.match(sql, /a\.pid <> pg_backend_pid\(\)/);
  assert.match(sql, /a\.datname = 'ret_test' AND a\.usename = 'profile_test'/);
  assert.match(sql, /w\.relation = 'ret0\.avatars'::regclass/);
  assert.match(sql, /w\.mode = 'RowExclusiveLock' AND NOT w\.granted/);
  assert.match(sql, /h\.pid = pg_backend_pid\(\) AND h\.mode = 'ShareRowExclusiveLock' AND h\.granted/);
  assert.match(sql, /ANY\(pg_blocking_pids\(a\.pid\)\)/);
  assert.match(sql, /a\.query ~\* '\^\[\[:space:\]\]\*INSERT/);
  assert.ok(sql.includes('("ret0"|ret0)[[:space:]]*\\.[[:space:]]*("avatars"|avatars)'));
  assert.match(sql, /count\(\*\) = 1/);
  assert.match(sql, /count\(\*\) > 1/);
  const output = sql.slice(sql.indexOf("SELECT json_build_object"));
  assert.doesNotMatch(output, /a\.query|a\.pid|account_id|avatar_id|auth/);
});

test("RELEASE rolls back the owned transaction and verifies it no longer holds its lock", () => {
  const sql = boundaryReleaseSql(context);
  assert.match(sql, /^ROLLBACK;\nBEGIN READ ONLY;/);
  assert.match(sql, /'event', 'RELEASED'/);
  assert.match(sql, /\nROLLBACK;$/);
  assert.doesNotMatch(sql, /\b(COMMIT|INSERT|UPDATE|DELETE|GRANT|pg_cancel_backend|pg_terminate_backend)\b/);
});

test("replies are closed boolean metadata, and ambiguity/identity failures cannot prove INSERT", () => {
  for (const event of ["ARMED", "RELEASED"]) assert.equal(validateBoundaryReply(reply(event), event).event, event);
  assert.equal(validateBoundaryReply(pollReply({ blocked_insert: true }), "POLL").blocked_insert, true);
  for (const value of [pollReply({ ambiguous_insert: true }), pollReply({ identity_verified: false }),
    pollReply({ lock_held: false }), pollReply({ blocked_insert: "yes" }), pollReply({ query: "private" }),
    pollReply({ pid: 123 })]) assert.throws(() => validateBoundaryReply(value, "POLL"));
  assert.throws(() => validateBoundaryReply(reply("UNKNOWN"), "UNKNOWN"));
});

test("transport starts only the explicit psql, with no inherited credentials or external connection defaults", () => {
  const fake = fakeTransport(), peer = createBoundaryPeer(context, fake.spawnProcess);
  assert.equal(fake.invocations.length, 1);
  const [file, args, options] = fake.invocations[0];
  assert.equal(file, context.psql);
  assert.deepEqual(args, ["-X", "--no-password", "-qAt", "-h", context.socket, "-p", String(context.port), "-U", "profile_test", "-d", "ret_test", "-v", "ON_ERROR_STOP=1"]);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
  assert.equal(options.detached, false);
  assert.equal(options.env.PGPASSFILE, "/dev/null");
  assert.equal(options.env.PGSERVICEFILE, "/dev/null");
  assert.equal(options.env.HOME, context.home);
  assert.ok(!Object.hasOwn(options.env, "PGPASSWORD"));
  assert.ok(!Object.hasOwn(options.env, "PGHOST"));
  return peer.close();
});

test("transport accepts only its three compiled SQL operations, not caller-supplied SQL", async () => {
  const fake = fakeTransport(), peer = createBoundaryPeer(context, fake.spawnProcess);
  await assert.rejects(peer.request("SELECT private_data"), /invalid_owned_peer_operation/);
  await assert.rejects(peer.request("STOP"), /invalid_owned_peer_operation/);
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(await peer.close(), { exited: true, clean: true });
});

test("mock process transport rejects overlapping requests and confirms rollback plus actual close", async () => {
  const fake = fakeTransport(), peer = createBoundaryPeer(context, fake.spawnProcess);
  const arm = peer.request("ARMED");
  await assert.rejects(peer.request("POLL"));
  fake.respond(reply("ARMED"));
  await arm;
  const firstClose = peer.close(), secondClose = peer.close();
  assert.equal(firstClose, secondClose);
  assert.deepEqual(await firstClose, { exited: true, clean: true });
  assert.equal(fake.writes.at(-1), "ROLLBACK;\n\\quit\n");
  assert.deepEqual(fake.kills, []);
  await assert.rejects(peer.request("ARMED"));
});

test("cleanup during an in-flight observation discards output without inventing a blocked result", async () => {
  const fake = fakeTransport(), peer = createBoundaryPeer(context, fake.spawnProcess);
  const pending = peer.request("POLL");
  const rejected = assert.rejects(pending);
  const closing = peer.close();
  fake.respond(pollReply({ blocked_insert: true }));
  await rejected;
  assert.deepEqual(await closing, { exited: true, clean: true });
});

test("lifecycle oracle: STOP during pending POLL remains clean", async () => {
  const transport = fakeTransport({ autoExit: false }), lifecycle = realLifecycle(transport);
  const observing = lifecycle.observe();
  assert.equal(transport.writes.length, 1, "the real observer is awaiting its POLL transport");
  const stopping = lifecycle.command("STOP");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lifecycle.events.length, 0, "STOP still requires a real child close event");
  transport.child.emit("close", 0, null);
  await Promise.all([observing, stopping]);
  assert.equal(lifecycle.events.length, 1);
  assert.equal(lifecycle.events[0].event, "STOPPED");
  assert.equal(lifecycle.events[0].owned_peer_exited, true);
  assert.equal(lifecycle.events[0].graceful_rollback_exit, true);
  assert.equal(lifecycle.unitProcess.exitCode, 0);
  assert.deepEqual(transport.kills, []);
});

test("lifecycle oracle: POLL failure before STOP remains FAIL", async () => {
  const transport = fakeTransport({ autoExit: false }), lifecycle = realLifecycle(transport);
  const observing = lifecycle.observe();
  assert.equal(transport.writes.length, 1);
  // Unexpected connection exit rejects the real request before STOP begins.
  // Its clean exit is NOT evidence the pending observation succeeded.
  transport.child.emit("close", 0, null);
  await observing;
  await lifecycle.command("STOP");
  assert.equal(lifecycle.events.length, 1);
  assert.equal(lifecycle.events[0].event, "FAIL");
  assert.equal(lifecycle.events[0].failed_check, "blocked-insert-observation");
  assert.equal(lifecycle.events[0].owned_peer_exited, true);
  assert.equal(lifecycle.events[0].graceful_rollback_exit, true);
  assert.equal(lifecycle.unitProcess.exitCode, 1);
  assert.deepEqual(transport.kills, []);
});

test("lifecycle oracle: unexpected POLL close then immediate STOP remains FAIL", async () => {
  const transport = fakeTransport({ autoExit: false }), lifecycle = realLifecycle(transport);
  const observing = lifecycle.observe();
  assert.equal(transport.writes.length, 1);
  transport.child.emit("close", 0, null);
  // Deliberately no await: STOP starts before the rejected POLL's catch runs.
  const stopping = lifecycle.command("STOP");
  await Promise.all([observing, stopping]);
  assert.equal(lifecycle.events.length, 1);
  assert.equal(lifecycle.events[0].event, "FAIL");
  assert.equal(lifecycle.events[0].owned_peer_exited, true);
  assert.equal(lifecycle.events[0].graceful_rollback_exit, true);
  assert.equal(lifecycle.unitProcess.exitCode, 1);
  assert.deepEqual(transport.kills, []);
});

test("a private/unexpected transport reply fails closed, is not relayed, and closes only its own process", async () => {
  const fake = fakeTransport(), peer = createBoundaryPeer(context, fake.spawnProcess);
  const pending = peer.request("ARMED");
  fake.respond({ ...reply("ARMED"), private_query: "must not relay" });
  await assert.rejects(pending, /owned_peer_reply_failed/);
  assert.deepEqual(await peer.close(), { exited: true, clean: false });
  assert.deepEqual(fake.kills, []);
});

test("no STOP cleanup success without real process close, and escalation targets only the spawned peer", async () => {
  const fake = fakeTransport({ autoExit: false }), peer = createBoundaryPeer(context, fake.spawnProcess);
  const closing = peer.close(); let settled = false;
  void closing.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  fake.child.emit("close", 0, null);
  assert.deepEqual(await closing, { exited: true, clean: true });
  assert.deepEqual(fake.kills, []);
});

test("source envelope has no row mutation, external calls, filesystem writes or another-session cancellation", () => {
  const source = fs.readFileSync(new URL("./avaturn-save-sql-boundary.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fs\.(write|append|mkdir|chmod|rm|unlink|rename|copyFile)|fetch\(|https?\.request|PGPASSWORD|pg_cancel_backend|pg_terminate_backend|pg_ctl|onSave\(/);
  assert.match(source, /validateAvaturnBootstrap/);
  assert.match(source, /avaturn-save-socket-bootstrap\.json/);
  assert.match(source, /process\.ppid !== parentPid/);
  assert.match(source, /\["SIGINT", "SIGTERM", "SIGHUP"\]/);
  assert.doesNotMatch(source, /process\.(stdout|stderr)\.write\([^\n]*(bootstrap|result\.stdout|error\.message|a\.query)/);
});

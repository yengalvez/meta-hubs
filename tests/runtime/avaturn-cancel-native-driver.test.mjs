// Pure contract/SQL-shape and injectable process TRANSPORT only. No native jobs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { cancelDriverArguments, CancelCommandDecoder, CancelFrameDecoder, cancelDrainSql,
  validateCancelDrain, createCancelDriver, cancelDriverLimits } from "./avaturn-cancel-native-driver.mjs";
import { boundaryLimits } from "./avaturn-save-sql-boundary.mjs";

const pgBin = "/opt/homebrew/Cellar/postgresql@14/14.23/bin", work = "/private/tmp/ynret-local-Pure123";
const args = ["--pg-bin", pgBin, "--cache-reticulum", "/approved/existing/cache", "--browser-origin", "http://127.0.0.1:18445", "--hex-cache", "/approved/existing/hex"];
const options = cancelDriverArguments(args);
const drainReply = () => ({ identity_verified: true, own_account_equal: true, creator_off_equal: true, owned_avatar_count: 0, active_insert_count: 0 });
const start = () => ({ phase: "AVATAR_REQUEST_LIFECYCLE", attempt_count: 1, start_seen: true, own_token_equal: true,
  terminal: "pending", request_down: false, down_reason: "not_observed", failed: false });
const peerScope = "owned-local-avaturn-save-not-production";
const nativeResponse = () => ({ phase: "AVATAR_RESPONSE_STOP", count: 1, status: 200,
  controller: "RetWeb.Api.V1.AvatarController", action: "create", owned_account_equal: true });
const tick = () => new Promise(resolve => setImmediate(resolve));

function transport({ peerExitCode = 0, readbackError = false, automaticStop = true, unframedPeerExit = false, readbackPatch = {}, stalledPeerClose = false, readbackSteps = [] } = {}) {
  const children = [], calls = [], output = [], order = []; let reads = 0;
  function spawnProcess(...invocation) {
    calls.push(invocation); const name = children.length ? "peer" : "native", child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.commands = []; child.kills = [];
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const command = JSON.parse(chunk.toString()).command; child.commands.push(command); order.push(`${name}:${command}`);
      callback();
      if (command === "STOP" && automaticStop && !(name === "peer" && stalledPeerClose)) queueMicrotask(() => {
        if (name === "peer") {
          child.stdout.write(JSON.stringify({ scope: peerScope, event: "STOPPED", owned_peer_started: true,
            owned_peer_exited: true, graceful_rollback_exit: true, native_runtime_not_stopped: true }) + "\n");
          if (unframedPeerExit) child.stdout.write("partial");
          order.push("peer:close"); child.emit("close", peerExitCode, null);
        } else {
          child.stdout.write('RET_UI_SOCKET:{"phase":"STOPPED"}\n');
          child.stdout.write(`RET_LOCAL_RESULT:OBSERVATION_STOPPED:tests=0:scratch=${work}\n`);
          order.push("native:close"); child.emit("close", 0, null);
        }
      });
    } });
    child.stdin.once("finish", () => {
      if (name === "native" && !child.commands.includes("STOP")) queueMicrotask(() => child.emit("close", 1, null));
    });
    child.kill = signal => {
      child.kills.push(signal); order.push(`${name}:kill:${signal}`);
      if (!(name === "peer" && stalledPeerClose)) child.emit("close", null, signal);
      return true;
    };
    children.push(child); return child;
  }
  const driver = createCancelDriver({ options, spawnProcess,
    createReadback(file, pg) {
      assert.equal(file, `${work}/avaturn-save-socket-bootstrap.json`); assert.equal(pg, pgBin);
      return () => {
        reads++; order.push("readback"); const step = readbackSteps[reads - 1];
        if (readbackError || step instanceof Error) throw new Error("PRIVATE_EXCEPTION_MUST_NOT_ESCAPE");
        return { ...drainReply(), ...readbackPatch, ...step };
      };
    }, emit(value) { output.push(value); order.push(`event:${value.event}`); } });
  const native = event => children[0].stdout.write(`RET_UI_SOCKET:${JSON.stringify(event)}\n`);
  const peer = event => children[1].stdout.write(JSON.stringify({ scope: peerScope, ...event }) + "\n");
  const ready = () => native({ phase: "READY", bootstrap: `${work}/avaturn-save-socket-bootstrap.json`, pid: 99999 });
  const arm = () => {
    ready(); driver.command("ARM");
    peer({ event: "READY", native_identity_checked: true, maximum_seconds: 120, row_writes: false });
    peer({ event: "ARMED", identity_verified: true, lock_held: true, only_avatars_locked: true });
  };
  const blocked = () => peer({ event: "BLOCKED_INSERT", genuine_statement: true, same_owned_database: true, own_relation_blocker: true });
  const off = () => native({ phase: "SQL_APPLIED", profile: "CREATOR_OFF" });
  const terminal = () => {
    native({ ...start(), terminal: "router_exception" });
    native({ ...start(), terminal: "router_exception", request_down: true, down_reason: "abnormal" });
  };
  const released = () => peer({ event: "RELEASED", identity_verified: true, lock_held: false, late_backend_completion_permitted: true });
  return { driver, children, calls, output, order, native, peer, ready, arm, blocked, off, terminal, released, get reads() { return reads; } };
}

test("explicit existing cache/hex/loopback args only; original bounds intact", () => {
  assert.deepEqual(options.args, ["--avaturn-save-browser", ...args]);
  for (const index of [0, 1, 2, 4, 6]) { const invalid = [...args]; invalid[index] = "wrong"; assert.throws(() => cancelDriverArguments(invalid)); }
  for (const invalid of [[], [...args, "--force"], args.map(value => value === args[5] ? "https://example.invalid" : value),
    args.map(value => value === args[3] ? "/approved/../other" : value)]) assert.throws(() => cancelDriverArguments(invalid));
  assert.equal(cancelDriverLimits.queryMs, 3000); assert.equal(cancelDriverLimits.peerCloseMs, 4000);
  assert.equal(cancelDriverLimits.nativeStopMs, 15000); assert.equal(boundaryLimits.totalMs, 105000);
});

test("ARM/STOP NDJSON is bounded, one-use, no unknown keys/order shortcut/EOF", () => {
  const decoder = new CancelCommandDecoder(); assert.deepEqual(decoder.push('{"comm'), []);
  assert.deepEqual(decoder.push('and":"ARM"}\n'), ["ARM"]);
  assert.deepEqual(decoder.push('{"command":"STOP"}\n'), ["STOP"]); decoder.end();
  assert.throws(() => decoder.push("\n"));
  for (const input of ["ARM\n", '{"command":"CREATOR_OFF"}\n', '{"command":"ARM","extra":true}\n',
    '{"command":"ARM","command":"STOP"}\n', '{"command":"ARM"}\n{"command":"ARM"}\n',
    '{"command":"STOP"}\n{"command":"ARM"}\n', "x".repeat(129), '{"command":"STOP"}', '{"command":"ARM"}\n']) {
    const broken = new CancelCommandDecoder(); assert.throws(() => { broken.push(input); broken.end(); });
  }
});

test("frame byte limits apply per frame, total and unframed close", () => {
  const decoder = new CancelFrameDecoder(20); assert.deepEqual(decoder.push("par"), []);
  assert.deepEqual(decoder.push("t\nnext\n"), ["part", "next"]); decoder.end();
  assert.throws(() => decoder.push("x".repeat(20)));
  assert.throws(() => new CancelFrameDecoder(100000).push("x".repeat(4097) + "\n"));
  const incomplete = new CancelFrameDecoder(100); incomplete.push("partial"); assert.throws(() => incomplete.end());
});

test("read-only zero-row drain binds epoch/owner/config and classifies activity inside SQL without IDs returned", () => {
  const context = { work, data: `${work}/database`, socket: `${work}/socket`, home: `${work}/home`, pgBin,
    psql: `${pgBin}/psql`, port: 15439, epoch: 1780000000, accountId: "9007199254740999", email: "ui-socket-99@example.invalid" };
  const sql = cancelDrainSql(context);
  assert.match(sql, /BEGIN READ ONLY/); assert.match(sql, /pg_postmaster_start_time/); assert.match(sql, /pg_stat_clear_snapshot/);
  assert.match(sql, /owned_file_id IS NULL/); assert.match(sql, /a\.state = 'active'/); assert.match(sql, /a\.query ~\*/);
  assert.doesNotMatch(sql, /pg_cancel_backend|pg_terminate_backend|DELETE|UPDATE|RETURNING|'(?:pid|query)'\s*,\s*a\.(?:pid|query)/);
  assert.equal(validateCancelDrain(drainReply()).owned_avatar_count, 0);
  for (const patch of [{ identity_verified: false }, { own_account_equal: false }, { creator_off_equal: false },
    { owned_avatar_count: 1 }, { active_insert_count: 1 }, { account_id: "PRIVATE" }, { query: "PRIVATE" }])
    assert.throws(() => validateCancelDrain({ ...drainReply(), ...patch }));
  for (const patch of [{ accountId: 42 }, { accountId: "0" }, { accountId: "9223372036854775808" }, { email: "other@example.invalid" }])
    assert.throws(() => cancelDrainSql({ ...context, ...patch }));
});

test("real controller sends OFF synchronously at BLOCKED, drains twice, closes peer0, holds runtime until explicit STOP", async () => {
  const t = transport(); t.arm(); t.native(start()); t.blocked();
  assert.deepEqual(t.children[0].commands, ["CREATOR_OFF"]); assert.equal(t.reads, 0);
  assert.ok(t.order.indexOf("native:CREATOR_OFF") < t.order.indexOf("event:BLOCKED_INSERT"));
  t.off(); assert.equal(t.reads, 0); t.terminal(); await tick();
  assert.deepEqual(t.children[1].commands, ["ARM", "RELEASE"]); assert.equal(t.reads, 1);
  t.released(); await tick(); assert.equal(t.reads, 2);
  assert.equal(t.driver.state, "OBSERVATIONS_PENDING"); assert.equal(t.output.at(-1).event, "OBSERVATIONS_PENDING");
  assert.deepEqual(t.children[1].commands, ["ARM", "RELEASE", "STOP"]);
  assert.deepEqual(t.children[0].commands, ["CREATOR_OFF"]);
  assert.ok(t.order.indexOf("peer:close") < t.order.indexOf("event:OBSERVATIONS_PENDING"));
  const result = await t.driver.command("STOP"); assert.equal(result.failed, false);
  assert.ok(t.order.indexOf("peer:close") < t.order.indexOf("native:STOP"));
  assert.equal(t.output.at(-1).event, "STOPPED"); assert.equal(t.output.at(-1).acceptance, "NOT_RUNTIME_ACCEPTED");
  assert.equal(t.output.at(-1).native_exit_code, 0);
  assert.doesNotMatch(JSON.stringify(t.output), /99999|account_id|auth_token|stacktrace|PRIVATE_EXCEPTION/);
  assert.ok(t.calls.every(call => call[2].detached === false && call[2].stdio.join() === "pipe,pipe,pipe"));
});

test("DOWN before SQL_APPLIED is retained and drain still requires real OFF", async () => {
  const t = transport(); t.arm(); t.native(start()); t.blocked(); t.terminal();
  assert.equal(t.reads, 0); t.off(); await tick(); assert.equal(t.reads, 1);
  await t.driver.fail("pure_cleanup");
});

test("pending plus exact DOWN reaches observations only in either order with SQL_APPLIED, native stays alive", async () => {
  for (const downBeforeOff of [true, false]) {
    const t = transport(); t.arm(); t.native(start()); t.blocked();
    const down = { ...start(), request_down: true, down_reason: "normal" };
    if (downBeforeOff) t.native(down);
    assert.equal(t.reads, 0); assert.deepEqual(t.children[0].commands, ["CREATOR_OFF"]);
    t.off();
    if (!downBeforeOff) { assert.equal(t.reads, 0); t.native(down); }
    await tick(); assert.equal(t.reads, 1);
    assert.deepEqual(t.children[1].commands, ["ARM", "RELEASE"]);
    t.released(); await tick(); assert.equal(t.reads, 2);
    assert.equal(t.driver.state, "OBSERVATIONS_PENDING");
    assert.deepEqual(t.children[1].commands, ["ARM", "RELEASE", "STOP"]);
    assert.deepEqual(t.children[0].commands, ["CREATOR_OFF"]);
    assert.ok(t.order.indexOf("peer:close") < t.order.indexOf("event:OBSERVATIONS_PENDING"));
    assert.ok(t.output.filter(event => event.event === "REQUEST_LIFECYCLE").every(event => event.terminal === "pending"));
    assert.equal(t.output.at(-1).acceptance, "NOT_RUNTIME_ACCEPTED");
    assert.equal(t.output.at(-1).browser_acceptance, "NOT_RECORDED");
    assert.equal(t.output.at(-1).native_runtime_alive, true);
    assert.ok(!t.output.some(event => ["PASS", "STOPPED", "FAIL"].includes(event.event)));
    assert.doesNotMatch(JSON.stringify(t.output), /cancelled|canceled|negative_pass/);
    const result = await t.driver.command("STOP"); assert.equal(result.failed, false);
    assert.ok(t.order.indexOf("peer:close") < t.order.indexOf("native:STOP"));
  }
});

test("correlated exception without DOWN cannot drain or reach observations", async () => {
  const t = transport(); t.arm(); t.native(start()); t.blocked(); t.off();
  t.native({ ...start(), terminal: "router_exception" }); await tick();
  assert.equal(t.driver.state, "OFF_APPLIED"); assert.equal(t.reads, 0);
  assert.deepEqual(t.children[1].commands, ["ARM"]);
  assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
  assert.equal((await t.driver.fail("pure_missing_down_cleanup")).failed, true);
});

test("pending DOWN rejects invalid identity/cardinality and duplicate DOWN without changing decoder", async () => {
  for (const patch of [{ own_token_equal: false }, { start_seen: false }, { attempt_count: 0 },
    { attempt_count: 2 }, { attempt_count: "1" }, { failed: true }]) {
    const t = transport(); t.arm(); t.native(start()); t.blocked(); t.off();
    t.native({ ...start(), request_down: true, down_reason: "normal", ...patch }); await tick();
    assert.equal((await t.driver.completion).failed, true); assert.equal(t.reads, 0);
    assert.ok(!t.children[1].commands.includes("RELEASE"));
    assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
  }
  const t = transport(); t.arm(); t.native(start()); t.blocked(); t.off();
  const down = { ...start(), request_down: true, down_reason: "normal" };
  t.native(down); t.native(down); await tick();
  assert.equal((await t.driver.completion).failed, true); assert.equal(t.reads, 1);
  assert.ok(!t.children[1].commands.includes("RELEASE"));
  assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
});

test("owned200 never enters abort branch, including pending lifecycle plus response200", async () => {
  for (const terminal of ["router_stop_200", "pending"]) {
    const t = transport(); t.arm(); t.native(start()); t.blocked(); t.off();
    t.native(nativeResponse());
    if (terminal === "router_stop_200") t.native({ ...start(), terminal });
    t.native({ ...start(), terminal, request_down: true, down_reason: "normal" });
    await tick(); const result = await t.driver.completion;
    assert.equal(result.failed, true); assert.equal(t.reads, 0);
    assert.ok(t.output.some(event => event.event === "TERMINAL_DIAGNOSTIC"));
    assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
    assert.ok(!t.children[1].commands.includes("RELEASE"));
  }
});

test("peer exit1 is never hidden even with graceful rollback true", async () => {
  const t = transport({ peerExitCode: 1 }); t.arm(); t.native(start()); t.blocked(); t.off();
  t.native({ ...start(), request_down: true, down_reason: "normal" }); await tick(); t.released();
  await tick(); const result = await t.driver.completion;
  assert.equal(result.failed, true); assert.equal(t.output.at(-1).peer_exit_code, 1);
  assert.equal(t.output.at(-1).peer_stop_zero, false);
  assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
});

test("pending DOWN still fails closed for each first/second readback rows, INSERT, OFF, identity, owner or query error", async () => {
  const failures = [{ owned_avatar_count: 1 }, { active_insert_count: 1 }, { creator_off_equal: false },
    { identity_verified: false }, { own_account_equal: false }, new Error("PURE_READBACK_ERROR")];
  for (const readIndex of [0, 1]) for (const failure of failures) {
    const readbackSteps = [{}, {}]; readbackSteps[readIndex] = failure;
    const t = transport({ readbackSteps }); t.arm(); t.native(start()); t.blocked(); t.off();
    t.native({ ...start(), request_down: true, down_reason: "normal" }); await tick();
    if (readIndex === 1) { assert.equal(t.driver.state, "RELEASE_SENT"); t.released(); await tick(); }
    const result = await t.driver.completion;
    assert.equal(result.failed, true); assert.equal(t.reads, readIndex + 1);
    assert.equal(result.reason, readIndex === 0 ? "cancel_drain_or_terminal_failed" : "cancel_post_release_or_peer_stop_failed");
    assert.equal(t.children[1].commands.includes("RELEASE"), readIndex === 1);
    assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
    assert.equal(t.output.at(-1).event, "FAIL"); assert.equal(t.output.at(-1).acceptance, "NOT_RUNTIME_ACCEPTED");
    assert.doesNotMatch(JSON.stringify(t.output), /PURE_READBACK_ERROR|PRIVATE_EXCEPTION_MUST_NOT_ESCAPE/);
  }
});

test("unframed peer close0 is a failure before OBSERVATIONS_PENDING", async () => {
  const t = transport({ unframedPeerExit: true }); t.arm(); t.native(start()); t.blocked(); t.off(); t.terminal(); await tick(); t.released();
  await tick(); const result = await t.driver.completion;
  assert.equal(result.failed, true); assert.equal(t.output.at(-1).peer_stop_zero, false);
  assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
});

test("normal peer close timeout is memoized through failure cleanup: one STOP, one4s/SIGTERM, then native STOP", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = [], clockSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...rest) => {
    scheduled.push(milliseconds); return clockSetTimeout(callback, milliseconds, ...rest);
  });
  const t = transport({ stalledPeerClose: true });
  t.arm(); t.native(start()); t.blocked(); t.off(); t.terminal(); await tick(); t.released(); await tick();
  assert.equal(t.driver.state, "PEER_STOPPING");
  assert.deepEqual(t.children[1].commands, ["ARM", "RELEASE", "STOP"]);
  assert.deepEqual(scheduled, [4000]);
  context.mock.timers.tick(3999); await tick();
  assert.deepEqual(t.children[1].kills, []); assert.ok(!t.children[0].commands.includes("STOP"));
  context.mock.timers.tick(1); await tick();
  assert.deepEqual(scheduled, [4000, 15000]);
  assert.equal(t.children[0].commands.filter(command => command === "STOP").length, 1);
  const result = await t.driver.completion;
  assert.equal(result.failed, true); assert.equal(result.reason, "cancel_post_release_or_peer_stop_failed");
  assert.deepEqual(t.children[1].commands, ["ARM", "RELEASE", "STOP"]);
  assert.deepEqual(t.children[1].kills, ["SIGTERM"]);
  assert.deepEqual(scheduled, [4000, 15000]);
  assert.equal(t.output.at(-1).peer_stop_zero, false); assert.equal(t.output.at(-1).peer_exit_code, null);
  assert.equal(t.output.at(-1).native_stop_zero, true);
  assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
  assert.ok(t.order.indexOf("peer:kill:SIGTERM") < t.order.indexOf("native:STOP"));
  // Even another cleanup call reuses the same terminal result/rejected attempt.
  await t.driver.fail("later_failure"); context.mock.timers.tick(4000); await tick();
  assert.equal(scheduled.filter(milliseconds => milliseconds === 4000).length, 1);
  assert.deepEqual(t.children[1].kills, ["SIGTERM"]);
});

test("active INSERT drain failure returns only bounded fact, never cause/retry/RELEASE", async () => {
  const t = transport({ readbackPatch: { active_insert_count: 1 } }); t.arm(); t.native(start()); t.blocked(); t.off(); t.terminal();
  await tick(); assert.equal((await t.driver.completion).failed, true); assert.equal(t.reads, 1);
  assert.equal(t.output.find(event => event.event === "DRAIN_STATE").active_insert_drained, false);
  assert.ok(!t.children[1].commands.includes("RELEASE"));
  assert.doesNotMatch(JSON.stringify(t.output), /active_insert_count|timeout|DBConnection|a\.query/);
});

test("duplicate, unowned, wrong source and order fail closed then peer closes before native", async () => {
  const attacks = [t => t.native({ ...start(), own_token_equal: false }), t => { t.native(start()); t.native(start()); },
    t => t.peer({ scope: "other", event: "BLOCKED_INSERT" }), t => t.released(),
    t => t.native({ phase: "SQL_APPLIED", profile: "CREATOR_ON" }),
    t => t.native({ ...nativeResponse(), status: 422 }), t => t.driver.command("ARM"),
    t => t.native({ ...start(), terminal: "router_exception" }),
    t => t.peer({ event: "READY", native_identity_checked: true, maximum_seconds: 120, row_writes: false })];
  for (const attack of attacks) {
    const t = transport(); t.arm(); attack(t); await tick();
    const result = await t.driver.completion; assert.equal(result.failed, true);
    assert.ok(t.order.indexOf("peer:close") < t.order.indexOf("native:STOP"));
    assert.ok(!t.output.some(event => event.event === "OBSERVATIONS_PENDING"));
  }
});

test("early failure, EOF, signal and concurrent cleanup preserve original failure and own-child-only shutdown", async () => {
  const early = transport(); const earlyResult = await early.driver.fail("cancel_eof_without_stop");
  assert.equal(earlyResult.failed, true); assert.equal(early.children.length, 1); assert.equal(early.output.at(-1).native_exit_code, 1);
  for (const reason of ["cancel_eof_without_stop", "cancel_signal_cleanup", "cancel_read_only_query_failed"]) {
    const t = transport(); t.arm();
    const first = t.driver.fail(reason), second = t.driver.fail("later_failure");
    assert.equal(first, second); const result = await first; assert.equal(result.reason, reason);
    assert.deepEqual(t.children[1].commands, ["ARM", "STOP"]);
    assert.equal(t.children[0].commands.filter(value => value === "STOP").length, 1);
    assert.ok(t.children.every(child => child.kills.length === 0));
  }
  const t = transport({ readbackError: true }); t.arm(); t.native(start()); t.blocked(); t.off(); t.terminal();
  await tick(); assert.equal((await t.driver.completion).failed, true);
  assert.doesNotMatch(JSON.stringify(t.output), /PRIVATE_EXCEPTION_MUST_NOT_ESCAPE/);
});

test("actual CLI routes parser/EOF/signals through cleanup and cannot install/build/start server or selfaccept", () => {
  const source = fs.readFileSync(new URL("./avaturn-cancel-native-driver.mjs", import.meta.url), "utf8");
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.ok(source.includes(`"${signal}"`));
  assert.match(source, /decoder\.end\(\)/); assert.match(source, /cancel_eof_without_stop/);
  assert.match(source, /value\.event === "FAIL"\) process\.exitCode = 1/);
  assert.doesNotMatch(source, /spawnProcess\([^\n]*(bash|zsh)|PGPASSWORD|readFileSync\([^\n]*password|kubectl|npm install|ERR_ABORTED|negative_pass/);
  assert.match(source, /state = "OFF_SENT"; write\(native, "CREATOR_OFF"\)/);
});

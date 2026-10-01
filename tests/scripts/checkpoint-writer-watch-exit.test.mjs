import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../deployment/watch-checkpoint-writers.mjs", import.meta.url), "utf8");
function extract(name, optional = false) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m"));
  if (optional && !match) return "";
  assert.ok(match, name);
  return match[0];
}

// Exercise the actual production Watch session and actual child lifecycle.
// Only the kubectl/API peer is a local executable; this is not a cluster test.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-watch-exit-"));
const executable = path.join(fixture, "kubectl-peer");
fs.writeFileSync(executable, `#!${process.execPath}
const mode = process.argv[process.argv.indexOf('--context') + 1];
const raw = process.argv[process.argv.indexOf('--raw') + 1];
if (!raw.includes('resourceVersion=initial-rv') || !raw.includes('watch=true')) process.exit(98);
switch (mode) {
  case 'eof': process.stderr.write('Unable to connect to the server: EOF private-token-sentinel'); process.exitCode = 37; break;
  case 'timeout': process.stderr.write('Unable to connect to the server: net/http: request canceled (Client.Timeout exceeded while awaiting headers) private-token-sentinel'); process.exitCode = 1; break;
  case 'authorization': process.stderr.write('Error from server (Forbidden): private-token-sentinel'); process.exitCode = 1; break;
  case 'flood': process.stderr.write('Unable to connect to the server: EOF ' + 'private-token-sentinel'.repeat(40000)); process.exitCode = 1; break;
  case 'event': process.stdout.write('not-json private-token-sentinel\\n'); setTimeout(() => {}, 5000); break;
  case 'signal': process.kill(process.pid, 'SIGTERM'); break;
  case 'bookmark-error': process.stdout.write(JSON.stringify({type:'BOOKMARK',object:{metadata:{resourceVersion:'next-rv'}}})+'\\n'); process.stderr.write('Unable to connect to the server: EOF private-token-sentinel'); process.exitCode = 1; break;
  case 'mixed': process.stderr.write('Unable to connect to the server: EOF private-token-sentinel\\nError from server (Forbidden): private-token-sentinel'); process.exitCode = 1; break;
  case 'early': break;
  case 'normal': process.stdout.write(JSON.stringify({type:'BOOKMARK',object:{metadata:{resourceVersion:'next-rv'}}})+'\\n'); setTimeout(() => {}, 1650); break;
  case 'deadline': setTimeout(() => {}, 5000); break;
  default: process.stderr.write('private-token-sentinel unknown failure'); process.exitCode = 1;
}
`, { mode: 0o700 });
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

function harness({ fastDeadline = false } = {}) {
  const activeChildren = new Set();
  const context = vm.createContext({
    spawn, performance, Buffer, URLSearchParams, setImmediate, clearTimeout,
    setTimeout: (fn, delay) => setTimeout(fn, fastDeadline && delay === 10000 ? 20 : delay),
    process: { env: {} }, activeChildren,
    WATCH_TIMEOUT_SECONDS: 2, MAX_EVENT_BYTES: 4 * 1024 * 1024,
    MAX_WATCH_STDERR_BYTES: 4096,
    parseJson: (text, code) => { try { return JSON.parse(text); } catch { const e = new Error(code); e.code = code; throw e; } },
    validateEvent: (_resource, event) => {
      if (event.type !== "BOOKMARK") throw new Error("unexpected fixture event");
      return event.object.metadata.resourceVersion;
    }
  });
  vm.runInContext([extract("fail"), extract("watchTransportHint", true),
    extract("reportWatchDiagnostic", true), extract("startWatchSession")].join("\n"), context);
  return { context, activeChildren };
}

async function result(mode, resource = "pods", options = {}) {
  const { context, activeChildren } = harness(options);
  const session = await context.startWatchSession({
    kubectl: options.missingExecutable ? path.join(fixture, "missing") : executable,
    context: mode, namespace: "hcce", resource,
    resourceVersion: "initial-rv", baseline: {}, state: {},
    allowFixtureImmediateBookmark: false, reportWatchFreshness: true
  });
  let error, value;
  try { value = await session.finish({ intentionalStop: options.intentionalStop === true }); } catch (e) { error = e; }
  assert.equal(activeChildren.size, 0, "all spawned Watch peers must be joined");
  let output = "";
  if (error && context.reportWatchDiagnostic) context.reportWatchDiagnostic(error, line => { output += line; });
  assert.doesNotMatch(output, /private-token-sentinel|initial-rv|next-rv|Unable to connect|Forbidden/);
  return { error, value, output };
}

for (const [mode, resource, code, signal, detail] of [
  ["eof", "deployments", 37, "none", "transport-eof"],
  ["timeout", "replicasets", 1, "none", "transport-timeout"],
  ["authorization", "pods", 1, "none", "authorization"],
  ["flood", "pods", 1, "none", "transport-eof"],
  ["unknown", "pods", 1, "none", "other"],
  ["mixed", "pods", 1, "none", "other"],
  ["bookmark-error", "pods", 1, "none", "transport-eof"],
  ["signal", "pods", null, "SIGTERM", "child-signal"]
]) {
  test(`Watch ${mode} retains original failure and closed diagnostic for ${resource}`, async () => {
    const { error, output } = await result(mode, resource);
    assert.equal(error?.code, "watch_terminated");
    assert.equal(error?.watchDiagnostic?.resource, resource);
    assert.equal(error.watchDiagnostic.exitCode, code);
    assert.equal(error.watchDiagnostic.signal, signal);
    assert.equal(error.watchDiagnostic.detail, detail);
    assert.match(output, new RegExp(`checkpoint_writer_watch_resource:${resource}\\n`));
    assert.match(output, new RegExp(`checkpoint_writer_watch_exit:${code === null ? "none" : code}\\n`));
    assert.ok(error.watchDiagnostic.elapsedMs >= 0);
  });
}

test("normal timed Watch advances its exact RV and emits no failure diagnostic", async () => {
  const { value, error, output } = await result("normal");
  assert.equal(error, undefined);
  assert.equal(value.resourceVersion, "next-rv");
  assert.equal(value.needsRefresh, false);
  assert.equal(output, "");
});

test("early clean EOF remains rejected, not relisted or accepted as success", async () => {
  const { error } = await result("early");
  assert.equal(error?.code, "watch_closed");
  assert.equal(error?.watchDiagnostic?.detail, "early-close");
});

test("an event-validation failure outranks termination caused by the monitor", async () => {
  const { error } = await result("event");
  assert.equal(error?.code, "watch_event_json");
  assert.equal(error?.watchDiagnostic?.detail, "event-invalid");
});

test("owned watchdog records deadline separately from an external signal", async () => {
  // Scale only this test's timer; production's timeoutSeconds+8 is unchanged.
  const { error } = await result("deadline", "pods", { fastDeadline: true });
  assert.equal(error?.code, "watch_terminated");
  assert.equal(error?.watchDiagnostic?.signal, "SIGKILL");
  assert.equal(error?.watchDiagnostic?.detail, "deadline");
});

test("intentional stop still requires the owned SIGTERM contract", async () => {
  const { error, value, output } = await result("deadline", "pods", { intentionalStop: true });
  assert.equal(error, undefined);
  assert.equal(value.resourceVersion, "initial-rv");
  assert.equal(value.needsRefresh, true);
  assert.equal(output, "");
});

test("spawn error is annotated without leaking the executable path", async () => {
  const { context } = harness();
  let error;
  try {
    await context.startWatchSession({ kubectl: path.join(fixture, "private-token-sentinel-missing"),
      context: "eof", namespace: "hcce", resource: "pods", resourceVersion: "initial-rv" });
  } catch (e) { error = e; }
  assert.equal(error?.code, "watch_spawn");
  assert.equal(error?.watchDiagnostic?.detail, "spawn");
  let output = "";
  context.reportWatchDiagnostic(error, text => { output += text; });
  assert.doesNotMatch(output, /private-token-sentinel|ENOENT|kubectl-peer/);
});

test("reporter rejects raw text or tampered diagnostic fields", () => {
  const { context } = harness();
  let output = "";
  context.reportWatchDiagnostic({ watchDiagnostic: {resource:"private-token-sentinel",exitCode:"private-token-sentinel",
    signal:"private-token-sentinel",detail:"private-token-sentinel",elapsedMs:"private-token-sentinel"}}, text => { output += text; });
  assert.equal(output, "checkpoint_writer_watch_resource:other\ncheckpoint_writer_watch_exit:none\n" +
    "checkpoint_writer_watch_signal:other\ncheckpoint_writer_watch_detail:other\ncheckpoint_writer_watch_elapsed_ms:none\n");
});

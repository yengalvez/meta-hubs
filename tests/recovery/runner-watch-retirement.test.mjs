import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nativeShellEnvironment, resolveNativeBash } from "./native-bash.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const library = path.join(root, "deployment/lib/recovery-safety.sh");
const shell = resolveNativeBash(process.env.PATH, process.env.YENHUBS_TEST_BASH);
const source = fs.readFileSync(library, "utf8");
const startToken = "    exec python3 -I -c '\n";
const finishToken = "\n' \"$owner_pid\" \"$owner_start_identity\" \"$failure_path\" \"$inventory_path\" node \"$" + '{watcher_args[@]}"';
const begin = source.indexOf(startToken, source.indexOf("recovery_start_no_managed_bot_runner_watch() {"));
const end = source.indexOf(finishToken, begin);
assert.ok(begin > 0 && end > begin, "original native supervisor launcher unavailable");
const nativeSource = source.slice(begin + startToken.length, end);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const metadataKeys = ["owner", "ownerIdentity", "supervisor", "identity"];
const gateKeys = ["primary", "primary_identity", "secondary", "secondary_identity", "node", "node_status", "ack", "eof", "uid", "group", "parent"];
const waitKeys = ["pid", "status", "waiter"];

function unsignedWitnessFrame(content, name, maximum = 255) {
  if (content === undefined || content === "" || !content.endsWith("\n")) return undefined;
  assert.match(content, /^(?:0|[1-9][0-9]*)\n$/, name + " must contain one complete canonical integer frame");
  const value = Number(content.slice(0, -1));
  assert.ok(Number.isSafeInteger(value) && value <= maximum, name + " integer frame is out of range");
  return value;
}

function jsonWitnessFrame(content, keys, name) {
  if (content === undefined || content === "" || !content.endsWith("\n")) return undefined;
  const frame = content.slice(0, -1);
  assert.match(frame, /^\{[^\n]*\}$/, name + " must contain one complete JSON object frame");
  let value;
  try { value = JSON.parse(frame); } catch { assert.fail(name + " has an invalid complete JSON frame"); }
  assert.ok(value && typeof value === "object" && !Array.isArray(value), name + " must be an object");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), name + " JSON fields must stay exact");
  if (keys.includes("status")) assert.ok(Number.isSafeInteger(value.status) && value.status >= 0 && value.status <= 65535,
    name + " native status must be an integer, never empty/null/string");
  return value;
}

function replaceExactlyOnce(input, expression, replacement, description) {
  assert.equal([...input.matchAll(expression)].length, 1, description + " must identify one original scheduling boundary");
  return input.replace(expression, replacement);
}

// Only the fixture copy contains these observers and scheduling gates. Every
// waitpid, status predicate, ACK, EOF, residual check and publisher remains
// native. B7 below is a real os._exit(7), never a substituted wait result.
function instrumentedLibrary(directory, secondaryExit) {
  const observers = `
import json
fixture_directory = ${JSON.stringify(directory)}
def fixture_note(name, value):
    descriptor = os.open(fixture_directory + "/" + name,
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        payload = (json.dumps(value, sort_keys=True) + "\\n").encode("ascii")
        if os.write(descriptor, payload) != len(payload):
            raise RuntimeError("fixture_observer_write")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
def fixture_retirement_gate():
    fixture_note("before-b-retire", {
        "primary": group, "primary_identity": leader_identity,
        "secondary": secondary_pid, "secondary_identity": secondary_identity,
        "node": node_pid, "node_status": node_status,
        "ack": completion_acknowledged, "eof": node_closed,
        "uid": os.getuid(), "group": os.getpgrp(), "parent": os.getppid()
    })
    while not os.path.exists(fixture_directory + "/retire-release"):
        time.sleep(0.005)
`;
  let instrumented = replaceExactlyOnce(nativeSource, /^import time\n/gm,
    "import time\n" + observers, "fixture observer preamble");
  instrumented = replaceExactlyOnce(instrumented, /^( +)node_status = status\n/gm,
    (_, indent) => indent + "node_status = status\n" + indent +
      'fixture_note("node-wait", {"pid": node_pid, "status": node_status, "waiter": os.getpid()})\n',
    "actual owned Node waitpid observation");
  instrumented = replaceExactlyOnce(instrumented, /^( +)# AUTHORIZED_B_RETIRE: residuals\/ambiguous probes never reach here\.\n/gm,
    (original, indent) => original + indent + "fixture_retirement_gate()\n",
    "post-residual pre-retire scheduling gate");
  instrumented = replaceExactlyOnce(instrumented, /^( +)if reaped:\n\1    if reaped != secondary_pid or not reap_authorized or not zero_exit\(status\):\n/gm,
    (_, indent) => indent + "if reaped:\n" + indent +
      '    fixture_note("b-wait", {"pid": secondary_pid, "status": status, "waiter": os.getpid()})\n' + indent +
      "    if reaped != secondary_pid or not reap_authorized or not zero_exit(status):\n",
    "actual owned guardian B waitpid observation");
  instrumented = replaceExactlyOnce(instrumented, /^( +)# Authorized B exit is still only an intent until A reaps us\.\n\1os\._exit\(0\)\n/gm,
    (_, indent) => indent + "# Authorized B exit is still only an intent until A reaps us.\n" + indent + "os._exit(" + secondaryExit + ")\n",
    "actual guardian B native exit");
  instrumented = replaceExactlyOnce(instrumented, /^( +)os\.fsync\(failure_fd\)\n/gm,
    (_, indent) => indent + "os.fsync(failure_fd)\n" + indent +
      'fixture_note("failure-fsync-" + str(os.getpid()), {"pid": os.getpid(), "dev": os.fstat(failure_fd).st_dev, "ino": os.fstat(failure_fd).st_ino, "size": os.fstat(failure_fd).st_size})\n',
    "original failure publisher real fsync observation");
  const waitLine = '    if wait "$target_pid" 2>/dev/null; then wait_status=0; else wait_status=$?; fi';
  const normalWaitLine = '    if wait "$target_pid"; then wait_status=0; else wait_status=$?; fi';
  let result = source.replace(nativeSource, instrumented);
  const note = '\n    printf \'{"pid":%s,"status":%s}\\n\' "$target_pid" "$wait_status" >"$RUNNER_RETIREMENT_FIXTURE/a-wait"';
  for (const line of [waitLine, normalWaitLine]) {
    assert.equal(result.split(line).length, 2, "original owned Bash wait boundary must stay exact");
    result = result.replace(line, line + note);
  }
  return result;
}

const stubSource = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.RUNNER_RETIREMENT_FIXTURE;
const args = process.argv.slice(2);
function reject() { fs.appendFileSync(path.join(directory, "rejects"), JSON.stringify(args)+"\\n", {mode:0o600}); process.exit(93); }
if (args[0] !== "--context" || args[1] !== "fixture-context" ||
    !/^--request-timeout=[1-9][0-9]*s$/.test(args[2]) || args[3] !== "get") reject();
fs.appendFileSync(path.join(directory, "gets"), JSON.stringify({pid:process.pid, parent:process.ppid, at:Date.now(), args})+"\\n", {mode:0o600});
if (args.slice(4).join(" ") === "namespace hcce-bot-runners --ignore-not-found -o json") {
  console.log(JSON.stringify({apiVersion:"v1",kind:"Namespace",metadata:{name:"hcce-bot-runners",uid:"fixture-runner-uid"}}));
} else {
  if (args.length !== 6 || args[4] !== "--raw") reject();
  const url = new URL(args[5], "https://fixture.invalid");
  if (!/^\\/api\\/v1\\/namespaces\\/(hcce|hcce-bot-runners)\\/pods$/.test(url.pathname)) reject();
  const watching = url.searchParams.get("watch") === "true";
  if (!watching && url.search !== "") reject();
  if (watching && (url.searchParams.size !== 4 || url.searchParams.get("allowWatchBookmarks") !== "true" ||
      !["2","65"].includes(url.searchParams.get("timeoutSeconds")) ||
      !["10","11"].includes(url.searchParams.get("resourceVersion")))) reject();
  if (watching) {
    // Both short and final requests close naturally; no descendant, observer
    // cleanup or test release can manufacture Node's successful native exit.
    setTimeout(() => console.log(JSON.stringify({type:"BOOKMARK",object:{metadata:{resourceVersion:"11"}}})),
      Number(url.searchParams.get("timeoutSeconds"))*1000);
  } else {
    console.log(JSON.stringify({apiVersion:"v1",kind:"PodList",metadata:{resourceVersion:"10"},items:[]}));
  }
}
`;

const ownerProgram = `set -euo pipefail
umask 077
source "$1"
dir="$2"
RECOVERY_SAFETY_DIR="$3"
NAMESPACE=hcce EXPECTED_KUBE_CONTEXT=fixture-context
export NAMESPACE EXPECTED_KUBE_CONTEXT
unset YENHUBS_RECOVERY_TEST_MODE RECOVERY_TEST_STABLE_ABSENCE_SECONDS RECOVERY_TEST_WATCHER_JOIN_TIMEOUT_SECONDS
owner_pid="$BASHPID"
owner_identity="$(recovery_process_start_identity "$owner_pid")"
watch_pid="" watch_identity=""
recovery_start_no_managed_bot_runner_watch "$dir/stop" "$dir/failure" "$dir/ready" watch_pid watch_identity "$dir/progress"
printf '{"owner":%s,"ownerIdentity":"%s","supervisor":%s,"identity":"%s"}\\n' "$owner_pid" "$owner_identity" "$watch_pid" "$watch_identity" >"$dir/metadata"
while [[ ! -e "$dir/stop-release" ]]; do sleep 0.02; done
if recovery_stop_no_managed_bot_runner_watch "$dir/stop" "$dir/failure" "$dir/ready" "$watch_pid" "$watch_identity"; then status=0; else status=$?; fi
printf '%s\\n' "$status" >"$dir/stop-status"
while [[ ! -e "$dir/owner-release" ]]; do sleep 0.02; done
`;

function members(group, remaining = 3000) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat=,comm="], {
    env: nativeShellEnvironment(), encoding: "utf8", timeout: Math.max(1, Math.min(3000, Math.floor(remaining)))
  });
  assert.equal(result.status, 0, "native process inventory unavailable");
  return result.stdout.trim().split("\n").filter(Boolean).map(line => {
    const [pid, ppid, pgid, uid, state, ...command] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), state, command: command.join(" ") };
  }).filter(member => group === undefined || member.pgid === group);
}

function identity(pid) {
  const result = spawnSync(shell, ["--noprofile", "--norc", "-c",
    'source "$1"; recovery_process_start_identity "$2"', "_", library, String(pid)], {
    env: nativeShellEnvironment(), encoding: "utf8", timeout: 3000
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function until(predicate, milliseconds, description) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    const matched = predicate(deadline - performance.now());
    if (performance.now() >= deadline) break;
    if (matched) return;
    await pause(Math.min(25, deadline - performance.now()));
  }
  assert.fail(description);
}

function fixture(t, secondaryExit) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-runner-retirement-"));
  fs.chmodSync(directory, 0o700);
  const write = (name, value = "") => fs.writeFileSync(path.join(directory, name), value, { flag: "wx", mode: 0o600 });
  const read = name => fs.readFileSync(path.join(directory, name), "utf8");
  const present = name => fs.existsSync(path.join(directory, name));
  const optional = name => present(name) ? read(name) : undefined;
  for (const name of ["stop", "failure", "ready", "progress", "gets", "rejects"]) write(name);
  const originalFailure = fs.statSync(path.join(directory, "failure"));
  write("library.sh", instrumentedLibrary(directory, secondaryExit));
  write("owner.sh", ownerProgram);
  write("kubectl", stubSource); fs.chmodSync(path.join(directory, "kubectl"), 0o700);
  const log = fs.openSync(path.join(directory, "owner.log"), "wx", 0o600);
  const owner = spawn(shell, ["--noprofile", "--norc", path.join(directory, "owner.sh"), path.join(directory, "library.sh"), directory, path.dirname(library)], {
    cwd: root, env: { ...nativeShellEnvironment(), PATH: `${directory}:${path.dirname(process.execPath)}:${nativeShellEnvironment().PATH}`,
      KUBECTL_BIN: path.join(directory, "kubectl"), RUNNER_RETIREMENT_FIXTURE: directory }, stdio: ["ignore", log, log]
  });
  let result, group;
  const pins = new Map();
  const closed = new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.once("close", (code, signal) => { result = { code, signal }; resolve(result); });
  });
  function pinGroup(id) {
    group = id;
    for (const member of members(id)) {
      const startIdentity = identity(member.pid);
      if (startIdentity) pins.set(member.pid, { ...member, startIdentity });
    }
  }
  t.after(async () => {
    if (!group && !result) {
      const supervisor = members().find(member => member.ppid === owner.pid && member.uid === process.getuid() && member.pid === member.pgid);
      if (supervisor) pinGroup(supervisor.pid);
    }
    if (!result) owner.kill("SIGKILL");
    await closed;
    if (group && members(group).length) {
      assert.ok(members(group).some(member => pins.has(member.pid) && pins.get(member.pid).uid === member.uid &&
        member.uid === process.getuid() && identity(member.pid) === pins.get(member.pid).startIdentity),
      "cleanup cannot adopt an unpinned native group; residual cleanup is never a PASS oracle");
      try { process.kill(-group, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await until(remaining => members(group, remaining).length === 0, 3000, "cleanup left a pinned group member");
    }
    fs.fsyncSync(log); fs.closeSync(log);
    if (process.env.YENHUBS_RECOVERY_TEST_KEEP_TMP === "1") {
      process.stderr.write("Retained runner retirement fixture: " + directory + "\n");
    } else fs.rmSync(directory, { recursive: true });
  });
  return { directory, owner, write, read, present, pinGroup, originalFailure, result: () => result, closed: () => closed,
    gets: () => read("gets").trim().split("\n").filter(Boolean).map(JSON.parse),
    status: name => unsignedWitnessFrame(optional(name), name),
    json: (name, keys) => jsonWitnessFrame(optional(name), keys, name) };
}

for (const secondaryExit of [7, 0]) {
  test(`aggregate STOP requires actual Node0/B${secondaryExit}/A exit before accepting retirement`, {
    concurrency: false, timeout: 120_000
  }, async t => {
    const f = fixture(t, secondaryExit);
    let metadata;
    await until(() => (metadata = f.json("metadata", metadataKeys)) !== undefined || f.result(), 10_000, "original helper did not reach exact READY");
    assert.equal(f.result(), undefined, "original owner must remain live");
    assert.equal(metadata.owner, f.owner.pid);
    assert.equal(identity(metadata.owner), metadata.ownerIdentity);
    assert.equal(identity(metadata.supervisor), metadata.identity);
    assert.equal(f.read("ready"), "ready\n");
    assert.ok(Number(f.read("progress")) >= 1);
    const initial = members(metadata.supervisor);
    assert.ok(initial.some(member => member.pid === metadata.supervisor && member.ppid === metadata.owner && member.uid === process.getuid()));
    const nodes = initial.filter(member => member.ppid === metadata.supervisor && /^node$/i.test(path.basename(member.command)));
    assert.equal(nodes.length, 1, "one original Node watcher must be owned by A");
    const node = { ...nodes[0], startIdentity: identity(nodes[0].pid) };
    assert.ok(node.startIdentity);
    f.pinGroup(metadata.supervisor);
    const stopStartedAt = performance.now();
    f.write("stop-release", "stop\n");
    let gate, stopStatus;
    await until(() => (gate = f.json("before-b-retire", gateKeys)) !== undefined ||
      (stopStatus = f.status("stop-status")) !== undefined, 90_000,
      "unshortened final WATCH did not reach actual Node0 and the post-residual retirement gate");
    assert.ok(gate, "a prior complete failure cannot stand in for the chosen B retirement boundary");
    const nodeWait = f.json("node-wait", waitKeys);
    assert.deepEqual(nodeWait, { pid: node.pid, status: 0, waiter: metadata.supervisor }, "only A's real waitpid Node0 is authoritative");
    assert.equal(gate.node_status, 0); assert.equal(gate.ack, true); assert.equal(gate.eof, true);
    assert.equal(gate.primary, metadata.supervisor); assert.equal(gate.primary_identity, metadata.identity);
    assert.equal(gate.parent, metadata.owner); assert.equal(gate.uid, process.getuid()); assert.equal(gate.group, metadata.supervisor);
    assert.equal(identity(gate.secondary), gate.secondary_identity);
    const retiring = members(metadata.supervisor);
    assert.equal(retiring.length, 2, "no Node, inventory observer or descendant may survive the residual check");
    assert.ok(retiring.some(member => member.pid === gate.secondary && member.ppid === metadata.supervisor && member.uid === process.getuid()));
    assert.ok(performance.now() - stopStartedAt >= 65_000, "production 61-second stability/65-second WATCH must not be shortened");
    const finalGets = f.gets().filter(entry => entry.args[4] === "--raw" &&
      new URL(entry.args[5], "https://fixture.invalid").searchParams.get("timeoutSeconds") === "65");
    assert.equal(finalGets.length, 2);
    assert.ok(finalGets.every(entry => entry.args[2] === "--request-timeout=75s" &&
      new URL(entry.args[5], "https://fixture.invalid").searchParams.get("resourceVersion") === "10"));
    assert.equal(f.read("failure"), "", "the clean fixture must not fail before the selected B retirement");
    f.write("retire-release", "release\n");
    let bWait, aWait, fsynced;
    await until(remaining => (stopStatus = f.status("stop-status")) !== undefined &&
      (bWait = f.json("b-wait", waitKeys)) !== undefined && (aWait = f.json("a-wait", ["pid", "status"])) !== undefined &&
      (secondaryExit !== 7 || (fsynced = f.json("failure-fsync-" + metadata.supervisor, ["pid", "dev", "ino", "size"])) !== undefined) &&
      members(metadata.supervisor, remaining).length === 0, 12_000,
      "original aggregate STOP must retire/revoke the group before observer cleanup");
    assert.deepEqual(bWait, { pid: gate.secondary, status: secondaryExit * 256, waiter: metadata.supervisor }, "B status must come from A's exact real owned waitpid");
    assert.equal(aWait.pid, metadata.supervisor, "Bash must wait the original supervisor A handle");
    assert.ok(aWait.status <= 255, "A's Bash wait frame must contain an actual shell exit status");
    assert.notEqual(aWait.status, 127, "an unavailable wait cannot count as A's native exit");
    const failure = fs.statSync(path.join(f.directory, "failure"));
    assert.equal(failure.dev, f.originalFailure.dev); assert.equal(failure.ino, f.originalFailure.ino);
    assert.equal(failure.uid, process.getuid()); assert.equal(failure.mode & 0o777, 0o600);
    if (secondaryExit === 7) {
      assert.notEqual(aWait.status, 0, "Node0 cannot hide native B7 in the aggregate A exit");
      assert.notEqual(stopStatus, 0, "full original STOP cannot accept a failed native participant");
      assert.equal(f.read("failure"), "runner_watch_failed\n"); assert.equal(failure.size, 20);
      assert.deepEqual(fsynced, { pid: metadata.supervisor, dev: failure.dev, ino: failure.ino, size: 20 },
        "A's original failure publisher must fsync the same twenty-byte inode before cleanup");
    } else {
      assert.equal(aWait.status, 0, "valid completion requires A's own native zero exit");
      assert.equal(stopStatus, 0, "full original STOP may accept only Node0/B0/A0 plus its original postguard");
      assert.equal(f.read("failure"), ""); assert.equal(failure.size, 0);
    }
    assert.equal(members(metadata.supervisor).length, 0, "group absence is required BEFORE fixture cleanup");
    assert.equal(f.read("rejects"), "", "the closed fixture must reject every non-GET or non-allowlisted request");
    assert.equal(f.result(), undefined); assert.equal(identity(metadata.owner), metadata.ownerIdentity);
    f.write("owner-release", "release\n");
    assert.deepEqual(await f.closed(), { code: 0, signal: null });
  });
}

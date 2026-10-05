import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { exactArguments } from "../../deployment/watch-bot-runner-pods.mjs";
import { nativeShellEnvironment, resolveNativeBash } from "./native-bash.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const library = path.join(root, "deployment/lib/recovery-safety.sh");
const watcher = path.join(root, "deployment/watch-bot-runner-pods.mjs");
const shell = resolveNativeBash(process.env.PATH, process.env.YENHUBS_TEST_BASH);
const shellExecutable = shell;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const metadataKeys = ["ownerPid", "ownerIdentity", "watchPid", "watchIdentity"];

function unsignedWitnessFrame(content, name, maximum = 255) {
  if (content === undefined || content === "" || !content.endsWith("\n")) return undefined;
  assert.match(content, /^(?:0|[1-9][0-9]*)\n$/, name + " must contain one complete canonical integer frame");
  const value = Number(content.slice(0, -1));
  assert.ok(Number.isSafeInteger(value) && value <= maximum, name + " integer frame is out of range");
  return value;
}

function jsonWitnessFrame(content, keys, name, newline = true) {
  if (content === undefined || content === "") return undefined;
  if (newline ? !content.endsWith("\n") : !content.endsWith("}")) return undefined;
  const frame = newline ? content.slice(0, -1) : content;
  assert.match(frame, /^\{[^\n]*\}$/, name + " must contain one complete JSON object frame");
  let value;
  try { value = JSON.parse(frame); } catch (error) {
    if (!newline && error instanceof SyntaxError) return undefined;
    assert.fail(name + " has an invalid complete JSON frame");
  }
  assert.ok(value && typeof value === "object" && !Array.isArray(value), name + " must be an object");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), name + " JSON fields must stay exact");
  return value;
}

async function until(predicate, milliseconds, description) {
  await untilBefore(predicate, performance.now() + milliseconds, description);
}

async function untilBefore(predicate, deadline, description) {
  while (performance.now() < deadline) {
    const matched = predicate(deadline - performance.now());
    // A native probe that returns true after its budget is not an on-time
    // revocation. Count both probe execution and owner-close delivery.
    if (performance.now() >= deadline) break;
    if (matched) return;
    await pause(Math.min(20, deadline - performance.now()));
  }
  assert.fail(description);
}

const probeTimeout = milliseconds => Math.max(1, Math.min(3000, Math.floor(milliseconds)));

function identity(pid, milliseconds = 3000) {
  const result = spawnSync(shell, ["--noprofile", "--norc", "-c",
    'source "$1"; recovery_process_start_identity "$2"', "_", library, String(pid)], {
    cwd: root, encoding: "utf8", timeout: probeTimeout(milliseconds),
    env: nativeShellEnvironment(), stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function members(group, milliseconds = 3000) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat=,comm="], {
    env: nativeShellEnvironment(), encoding: "utf8", timeout: probeTimeout(milliseconds)
  });
  assert.equal(result.status, 0, "native process inventory unavailable");
  return result.stdout.trim().split("\n").filter(Boolean).map(line => {
    const [pid, ppid, pgid, uid, state, ...command] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), state, command: command.join(" ") };
  }).filter(value => group === undefined || value.pgid === group);
}

function exactMember(capability, description) {
  assert.ok(capability.startIdentity, description + " requires a captured native identity");
  assert.equal(identity(capability.pid), capability.startIdentity, description + " identity changed before signal");
  const current = members(capability.pgid).find(member => member.pid === capability.pid);
  assert.ok(current, description + " original member disappeared before signal");
  assert.equal(current.uid, process.getuid(), description + " must belong to the fixture UID");
  assert.equal(current.uid, capability.uid, description + " UID changed before signal");
  assert.equal(current.ppid, capability.ppid, description + " parent changed before signal");
  assert.equal(current.pgid, capability.pgid, description + " group changed before signal");
  assert.ok(!/^[ZX]/.test(current.state), description + " cannot be a dead process");
  return current;
}

const stubSource = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dir = process.env.RUNNER_OWNER_FIXTURE;
const args = process.argv.slice(2);
const record = (name, value) => fs.writeFileSync(path.join(dir, name), value, { mode: 0o600 });
const reject = () => {
  fs.appendFileSync(path.join(dir, "rejects"), "reject\\n", { mode: 0o600 });
  process.exit(93);
};
if (args[0] !== "--context" || args[1] !== "fixture-context" ||
    !/^--request-timeout=[1-9][0-9]*s$/.test(args[2]) || args[3] !== "get") reject();
fs.appendFileSync(path.join(dir, "gets"), JSON.stringify({ pid: process.pid, args }) + "\\n", { mode: 0o600 });
if (args.slice(4).join(" ") === "namespace hcce-bot-runners --ignore-not-found -o json") {
  console.log(JSON.stringify({ apiVersion: "v1", kind: "Namespace",
    metadata: { name: "hcce-bot-runners", uid: "fixture-runner-uid" } }));
} else {
  if (args.length !== 6 || args[4] !== "--raw") reject();
  const url = new URL(args[5], "https://fixture.invalid");
  if (!/^\\/api\\/v1\\/namespaces\\/(hcce|hcce-bot-runners)\\/pods$/.test(url.pathname)) reject();
  const watching = url.searchParams.get("watch") === "true";
  if (watching && (url.searchParams.get("allowWatchBookmarks") !== "true" ||
      !["2", "65"].includes(url.searchParams.get("timeoutSeconds")) ||
      !url.searchParams.get("resourceVersion"))) reject();
  if (!watching && url.search !== "") reject();
  const finalGated = watching && url.searchParams.get("timeoutSeconds") === "65" &&
    process.env.RUNNER_OWNER_MODE === "final-watch";
  const blocked = (!watching && process.env.RUNNER_OWNER_MODE === "list-block") ||
    (watching && fs.existsSync(path.join(dir, "block"))) || finalGated;
  if (blocked) {
    process.on("SIGTERM", () => {});
    const descendantReady = "descendant-ready-" + process.pid;
    const descendant = spawn(process.execPath, ["-e",
      'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready",{mode:0o600});setInterval(()=>{},1000)',
      path.join(dir, descendantReady)], { stdio: "ignore" });
    record("blocked-" + process.pid + ".json", JSON.stringify({ pid: process.pid,
      parent: process.ppid, descendant: descendant.pid, descendantReady,
      namespace: url.pathname.split("/")[4], timeoutSeconds: url.searchParams.get("timeoutSeconds") }));
    const interval = setInterval(() => {
      if (finalGated && fs.existsSync(path.join(dir, "final-release"))) {
        clearInterval(interval);
        console.log(JSON.stringify({ type: "BOOKMARK", object: { metadata: { resourceVersion: "11" } } }));
        process.exit(0);
      }
    }, 20);
  } else if (watching) {
    setTimeout(() => console.log(JSON.stringify({ type: "BOOKMARK",
      object: { metadata: { resourceVersion: "11" } } })),
      Number(url.searchParams.get("timeoutSeconds")) * 1000);
  } else {
    console.log(JSON.stringify({ apiVersion: "v1", kind: "PodList",
      metadata: { resourceVersion: "10" }, items: [] }));
  }
}
`;

const ownerSource = `set -euo pipefail
umask 077
NAMESPACE=hcce
EXPECTED_KUBE_CONTEXT=fixture-context
export NAMESPACE EXPECTED_KUBE_CONTEXT
unset YENHUBS_RECOVERY_TEST_MODE RECOVERY_TEST_STABLE_ABSENCE_SECONDS
source "$1"
# Capture the real owner before command substitution creates its probe shell.
owner_pid="$BASHPID"
owner_identity="$(recovery_process_start_identity "$owner_pid")"
watch_pid="" watch_identity=""
if ! recovery_start_no_managed_bot_runner_watch \
  "$2/stop" "$2/failure" "$2/ready" watch_pid watch_identity "$2/progress"; then
  exit 21
fi
printf '{"ownerPid":%s,"ownerIdentity":"%s","watchPid":%s,"watchIdentity":"%s"}\\n' \
  "$owner_pid" "$owner_identity" "$watch_pid" "$watch_identity" >"$2/metadata"
while [[ ! -s "$2/finish" ]]; do
  if [[ -s "$2/observe-exit" && ! -s "$2/native-status" ]]; then
    if wait "$watch_pid"; then observed=0; else observed=$?; fi
    printf '%s\\n' "$observed" >"$2/native-status"
  fi
  sleep 0.02
done
if [[ "$RUNNER_OWNER_MODE" == final-watch ]]; then
  boundary_json="$(recovery_runner_watch_boundary_json)"
  recovery_signal_no_managed_bot_runner_watch_stop "$2/stop" "$boundary_json"
  wait "$watch_pid"
  printf 'handoff-completed\\n' >"$2/completed"
  exit 0
fi
recovery_discard_no_managed_bot_runner_watch "$2/stop" "$watch_pid" "$watch_identity"
printf 'discarded\\n' >"$2/completed"
`;

// This launch seam is used ONLY for startup/argument negatives. The central
// SIGKILL/blocked cases execute the actual Node binary and original helper.
const wrapperSource = `#!${shellExecutable}
set -euo pipefail
umask 077
printf '%s\\n' "$BASHPID" >"$RUNNER_OWNER_FIXTURE/launch-pid"
ps -o pgid= -p "$BASHPID" >"$RUNNER_OWNER_FIXTURE/launch-group"
if [[ "$RUNNER_OWNER_MODE" == startup-gate ]]; then
  while [[ ! -s "$RUNNER_OWNER_FIXTURE/gate" ]]; do sleep 0.02; done
fi
args=("$@")
if [[ "$RUNNER_OWNER_MODE" == identity-mismatch ]]; then
  for ((index=0; index < \${#args[@]}; index++)); do
    if [[ "\${args[index]}" == --owner-start-identity ]]; then
      replacement=0
      if [[ "\${args[index+1]##*:}" == 0 ]]; then replacement=1; fi
      args[index+1]="\${args[index+1]%:*}:$replacement"
    fi
  done
fi
exec "$RUNNER_OWNER_NODE" "\${args[@]}"
`;

function fixture(t, mode = "normal") {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-runner-owner-"));
  fs.chmodSync(directory, 0o700);
  const write = (name, value = "") => fs.writeFileSync(path.join(directory, name), value, { mode: 0o600 });
  const optional = name => fs.existsSync(path.join(directory, name)) ? fs.readFileSync(path.join(directory, name), "utf8") : undefined;
  for (const name of ["stop", "failure", "ready", "progress", "finish", "gets", "rejects", "completed", "observe-exit", "native-status"]) write(name);
  const originalFailure = fs.statSync(path.join(directory, "failure"));
  write("owner.sh", ownerSource);
  write("kubectl", stubSource);
  fs.chmodSync(path.join(directory, "kubectl"), 0o700);
  if (mode === "startup-gate" || mode === "identity-mismatch" || mode === "list-block") {
    write("node", wrapperSource);
    fs.chmodSync(path.join(directory, "node"), 0o700);
  }
  const env = { ...nativeShellEnvironment(), PATH: `${directory}:${path.dirname(process.execPath)}:${nativeShellEnvironment().PATH}`,
    KUBECTL_BIN: path.join(directory, "kubectl"), RUNNER_OWNER_FIXTURE: directory,
    RUNNER_OWNER_MODE: mode, RUNNER_OWNER_NODE: process.execPath };
  // Deliberately do not inherit timing capabilities or another fixture's env.
  let owner;
  let ownerResult;
  let ownerClosed;
  let group;
  const log = fs.openSync(path.join(directory, "owner.log"), "wx", 0o600);
  const pinnedMembers = new Map();
  function pin(pid, startIdentity) {
    const value = startIdentity || identity(pid);
    if (value) pinnedMembers.set(pid, { startIdentity: value, uid: process.getuid() });
  }
  function pinGroup(pid, startIdentity) {
    group = pid;
    pin(pid, startIdentity);
    for (const member of members(group)) pin(member.pid);
  }
  t.after(async () => {
    if (!group && owner && !ownerResult) {
      // Failed startup assertions can precede READY/metadata. A live direct
      // child of our still-unreaped owner, leading its own native PGID, is
      // still an exact fixture capability; capture it before killing owner.
      const child = members().find(member => member.ppid === owner.pid && member.pid === member.pgid);
      if (child) pinGroup(child.pid);
    }
    if (owner && !ownerResult) owner.kill("SIGKILL");
    if (ownerClosed) await ownerClosed;
    if (group && members(group).length) {
      // Signal only this fixture group while an original, native-identity
      // member still pins it. Never use a recycled positive PID fallback.
      const witness = members(group).some(member =>
        pinnedMembers.has(member.pid) && member.uid === pinnedMembers.get(member.pid).uid &&
        identity(member.pid) === pinnedMembers.get(member.pid).startIdentity);
      assert.ok(witness, "refusing cleanup without an exact original group member");
      try { process.kill(-group, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await until(remaining => members(group, remaining).length === 0, 3000, "fixture cleanup left a group member");
    }
    fs.fsyncSync(log); fs.closeSync(log);
    if (process.env.YENHUBS_RECOVERY_TEST_KEEP_TMP === "1") {
      process.stderr.write("Retained runner owner fixture: " + directory + "\n");
    } else fs.rmSync(directory, { recursive: true });
  });
  return {
    directory, env, write, pinGroup, originalFailure,
    read: name => fs.readFileSync(path.join(directory, name), "utf8"),
    status: (name, maximum = 255) => unsignedWitnessFrame(optional(name), name, maximum),
    pid: name => {
      const value = unsignedWitnessFrame(optional(name)?.replace(/^[ \t]+(?=[0-9])/, ""), name, 2147483647);
      if (value !== undefined) assert.ok(value > 0, name + " must be an original positive PID/PGID");
      return value;
    },
    json: (name, keys, newline = true) => jsonWitnessFrame(optional(name), keys, name, newline),
    nonempty: name => fs.existsSync(path.join(directory, name)) && fs.statSync(path.join(directory, name)).size > 0,
    gets() { return fs.readFileSync(path.join(directory, "gets"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); },
    blocked() { return fs.readdirSync(directory).filter(name => /^blocked-[0-9]+\.json$/.test(name)).map(name =>
      jsonWitnessFrame(optional(name), ["pid", "parent", "descendant", "descendantReady", "namespace", "timeoutSeconds"], name, false)).filter(Boolean); },
    start() {
      owner = spawn(shell, ["--noprofile", "--norc", path.join(directory, "owner.sh"), library, directory], {
        cwd: root, env, stdio: ["ignore", log, log]
      });
      // Do not inherit stdout/stderr pipes into the watcher or orphan. 'close'
      // is about the actual owner, not an unknowable non-child watcher exit.
      ownerClosed = new Promise((resolve, reject) => {
        owner.once("error", reject);
        owner.once("close", (code, signal) => { ownerResult = { code, signal }; resolve(ownerResult); });
      });
      return owner;
    },
    closed: () => ownerClosed,
    result: () => ownerResult,
    group: () => group
  };
}

async function ready(f, owner) {
  let metadata;
  await until(() => (metadata = f.json("metadata", metadataKeys)) !== undefined || f.result(), 10_000, "original helper did not become ready");
  assert.equal(f.result(), undefined, "owner exited before ready");
  assert.equal(metadata.ownerPid, owner.pid, "BASHPID must identify the real direct owner");
  assert.equal(identity(metadata.ownerPid), metadata.ownerIdentity, "metadata must pin the original Bash owner identity");
  assert.equal(f.read("ready"), "ready\n");
  assert.ok(Number(f.read("progress")) >= 1);
  assert.equal(identity(metadata.watchPid), metadata.watchIdentity);
  const group = members(metadata.watchPid);
  assert.ok(group.some(member => member.pid === metadata.watchPid && member.ppid === owner.pid &&
    member.uid === process.getuid()), "handle must be the exact supervisor A, a direct Bash child and PGID leader");
  const nodes = group.filter(member => member.ppid === metadata.watchPid &&
    /^node(?:\.exe)?$/i.test(path.basename(member.command)));
  assert.equal(nodes.length, 1, "expected one original Node watcher, directly owned by supervisor A");
  metadata.node = { ...nodes[0], startIdentity: identity(nodes[0].pid) };
  exactMember(metadata.node, "original Node watcher");
  f.pinGroup(metadata.watchPid, metadata.watchIdentity);
  return metadata;
}

async function ownerLoss(f, owner, readyWasExpected, afterKill) {
  const deadline = performance.now() + 3000;
  owner.kill("SIGKILL");
  if (afterKill) afterKill();
  await untilBefore(remaining => f.result() && f.nonempty("failure") && members(f.group(), remaining).length === 0,
    deadline, "owner loss did not durably fail and remove the exact isolated group within 3 seconds of SIGKILL");
  assert.deepEqual(f.result(), { code: null, signal: "SIGKILL" }, "the actual parent must receive SIGKILL");
  return revokedQuiet(f, readyWasExpected);
}

async function revokedQuiet(f, readyWasExpected) {
  assert.equal(f.read("failure"), "runner_watch_failed\n");
  assert.equal(f.read("completed"), "", "revocation cannot count as successful discard/handoff");
  if (!readyWasExpected) assert.equal(f.read("ready"), "", "startup orphan cannot become ready");
  const getsAtRevocation = f.gets().length;
  await pause(2500);
  assert.equal(members(f.group()).length, 0, "original group reappeared during quiet window");
  assert.equal(f.read("failure"), "runner_watch_failed\n", "revocation failure must remain durable");
  assert.equal(f.read("completed"), "", "revocation cannot later become successful discard");
  assert.equal(f.gets().length, getsAtRevocation, "GET continued after revocation");
  assert.equal(f.read("rejects"), "", "fixture saw a non-GET or non-allowlisted request");
  const failure = fs.statSync(path.join(f.directory, "failure"));
  assert.equal(failure.dev, f.originalFailure.dev); assert.equal(failure.ino, f.originalFailure.ino);
  assert.equal(failure.size, 20); assert.equal(failure.uid, process.getuid()); assert.equal(failure.mode & 0o777, 0o600);
  // The watcher is never this driver's child: do not infer an exit
  // code from liveness. Fixed failure + group absence is the available proof.
  return { originalWatcherStatus: "UNKNOWN", failure: "runner_watch_failed", group: "ABSENT" };
}

async function blockedWatch(f, metadata) {
  f.write("block", "block\n");
  await until(() => f.blocked().some(value => f.nonempty(value.descendantReady)), 5000,
    "GET-only WATCH stub/ignored-TERM descendant did not enter its blocking call");
  for (const blocked of f.blocked()) {
    const group = members(metadata.watchPid);
    assert.ok(group.some(member => member.pid === blocked.pid));
    assert.ok(group.some(member => member.pid === blocked.descendant), "real ignored-TERM descendant missing");
  }
  f.pinGroup(metadata.watchPid, metadata.watchIdentity);
}

async function stoppedBlockedWatch(f, metadata) {
  await blockedWatch(f, metadata);
  exactMember(metadata.node, "SIGSTOP original Node watcher");
  const deadline = performance.now() + 3000;
  process.kill(metadata.node.pid, "SIGSTOP");
  return deadline;
}

async function nativeFailure(f) {
  f.write("observe-exit", "observe-native-exit\n");
  let observed;
  await until(() => (observed = f.status("native-status")) !== undefined, 3000, "original Bash did not observe its complete real A exit frame");
  assert.notEqual(observed, 0, "native aggregate A cannot accept a revoked participant");
  assert.notEqual(observed, 127, "an unavailable wait is not an observed native aggregate failure");
}

function guardianPair(f, metadata) {
  const group = members(metadata.watchPid);
  const python = member => /^python(?:[0-9]+(?:\.[0-9]+)*)?$/i.test(path.basename(member.command));
  const pairs = group.filter(member => member.pid === metadata.watchPid && member.ppid === metadata.ownerPid &&
    member.uid === process.getuid() && python(member)).flatMap(first =>
    group.filter(member => member.ppid === first.pid && member.uid === process.getuid() && python(member)).map(second => [first, second]));
  assert.equal(pairs.length, 1, "expected the exact Bash -> supervisor A -> {Node, guardian B} tree in the owned PGID");
  const pair = pairs[0].map(member => ({ ...member, startIdentity: identity(member.pid) }));
  assert.ok(pair.every(member => member.startIdentity), "both guardians require native start identities");
  f.pinGroup(metadata.watchPid, metadata.watchIdentity);
  return pair;
}

async function guardianLoss(f, owner, guardian, metadata) {
  assert.equal(f.result(), undefined, "original owner must still be live before guardian loss");
  const ownerIdentity = identity(owner.pid);
  assert.ok(ownerIdentity, "original owner requires a native start identity");
  assert.ok(!exactMember(metadata.node, "original Node before guardian SIGKILL").state.startsWith("T"),
    "guardian SIGKILL must be the selected cause, not an earlier Node SIGSTOP");
  exactMember(guardian, "SIGKILL original guardian");
  const deadline = performance.now() + 3000;
  process.kill(guardian.pid, "SIGKILL");
  await untilBefore(remaining => f.nonempty("failure") && members(f.group(), remaining).length === 0,
    deadline, "individual guardian loss did not durably fail and revoke the entire owned PGID within 3 seconds of SIGKILL");
  assert.equal(f.result(), undefined, "guardian loss case must not kill the live original owner");
  await nativeFailure(f);
  await revokedQuiet(f, true);
  assert.equal(f.result(), undefined, "original owner must survive the guardian-loss quiet window");
  assert.equal(identity(owner.pid), ownerIdentity, "the same original owner must remain natively live");
}

async function finalWatchGate(f, owner) {
  const metadata = await ready(f, owner);
  f.write("finish", "final-watch\n");
  await until(() => {
    const blocked = f.blocked().filter(value => value.timeoutSeconds === "65" && f.nonempty(value.descendantReady));
    return new Set(blocked.map(value => value.namespace)).size === 2;
  }, 5000, "both actual final WATCH requests did not reach the external gate");
  const finalGets = f.gets().filter(entry => entry.args.includes("--raw") &&
    new URL(entry.args[5], "https://fixture.invalid").searchParams.get("timeoutSeconds") === "65");
  assert.equal(finalGets.length, 2, "gate must hold both unshortened final WATCH requests");
  assert.ok(finalGets.every(entry => entry.args[2] === "--request-timeout=75s"));
  const stop = JSON.parse(f.read("stop"));
  assert.deepEqual(stop, { stop: true, boundaries: [
    { namespace: "hcce", resourceVersion: "10" },
    { namespace: "hcce-bot-runners", resourceVersion: "10" }
  ] }, "final WATCH must originate at the real helper's exact LIST boundaries");
  for (const blocked of f.blocked()) {
    const group = members(metadata.watchPid);
    assert.ok(group.some(member => member.pid === blocked.pid && member.ppid === metadata.node.pid && member.uid === process.getuid()));
    assert.ok(group.some(member => member.pid === blocked.descendant && member.ppid === blocked.pid));
  }
  f.pinGroup(metadata.watchPid, metadata.watchIdentity);
  return metadata;
}

test("real owner SIGKILL after the original helper's READY revokes the WATCH group", { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const owner = f.start();
  await ready(f, owner);
  assert.equal((await ownerLoss(f, owner, true)).originalWatcherStatus, "UNKNOWN");
});

// Under the new Bash -> A -> {Node,B} graph, Node SIGSTOP is itself a
// revocation condition. Keep it separate from guardian loss: after stopping
// Node there may be no live guardian left to receive a later SIGKILL.
test("Node SIGSTOP revokes blocked WATCH descendants that ignore TERM while the real owner remains live", { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const owner = f.start();
  const metadata = await ready(f, owner);
  const deadline = await stoppedBlockedWatch(f, metadata);
  await untilBefore(remaining => f.nonempty("failure") && members(metadata.watchPid, remaining).length === 0,
    deadline, "Node SIGSTOP did not durably revoke the original group within 3 seconds");
  assert.equal(f.result(), undefined, "the same original owner must remain live after Node SIGSTOP");
  assert.equal(identity(owner.pid), metadata.ownerIdentity);
  await nativeFailure(f);
  await revokedQuiet(f, true);
  assert.equal(f.result(), undefined); assert.equal(identity(owner.pid), metadata.ownerIdentity);
});

for (const [name, index] of [["A", 0], ["B", 1]]) {
  test(`guardian ${name} SIGKILL revokes the live original Node and blocked TERM-ignoring WATCH descendants`, { timeout: 20_000 }, async t => {
    const f = fixture(t);
    const owner = f.start();
    const metadata = await ready(f, owner);
    const guardians = guardianPair(f, metadata);
    await blockedWatch(f, metadata);
    await guardianLoss(f, owner, guardians[index], metadata);
  });
}

test("owner loss revokes an actual final WATCH timeout65 while its request is in flight", { timeout: 20_000 }, async t => {
  const f = fixture(t, "final-watch");
  const owner = f.start();
  await finalWatchGate(f, owner);
  await ownerLoss(f, owner, true);
});

test("owner loss before final WATCH close fails after an unshortened 65-second external gate", { timeout: 90_000 }, async t => {
  const f = fixture(t, "final-watch");
  const owner = f.start();
  const metadata = await finalWatchGate(f, owner);
  const observedAt = performance.now();
  const heldUntil = observedAt + 65_000;
  while (performance.now() < heldUntil) await pause(Math.min(1000, heldUntil - performance.now()));
  assert.ok(performance.now() - observedAt >= 65_000, "external gate must not shorten the production final WATCH");
  assert.equal(f.result(), undefined, "the original owner must reach the final pre-close boundary live");
  assert.equal(f.read("failure"), "", "the external gate must not fail before owner loss");
  assert.equal(f.read("completed"), "", "the external gate must not complete before owner loss");
  exactMember(metadata.node, "original Node at the final gate");
  const group = members(metadata.watchPid);
  assert.ok(f.blocked().every(blocked => group.some(member =>
    member.pid === blocked.pid && member.ppid === metadata.node.pid && member.uid === process.getuid())), "both final requests must still be in flight before release");
  // The driver retains the actual ChildProcess capability. Kill its original
  // owner before releasing real kubectl responses, not via a bare PID in the
  // stub. This covers pre-close loss, not the exact completion handshake.
  await ownerLoss(f, owner, true, () => f.write("final-release", "release\n"));
});

test("independent owner revocation interrupts the watcher's synchronous startup LIST", { timeout: 15_000 }, async t => {
  const f = fixture(t, "list-block");
  const owner = f.start();
  let pid, group;
  await until(() => (pid = f.pid("launch-pid")) !== undefined && (group = f.pid("launch-group")) !== undefined &&
    f.blocked().some(value => f.nonempty(value.descendantReady)),
    5000, "real LIST/ignored-TERM descendant did not block");
  assert.ok(members(group).some(member => member.pid === group && member.ppid === owner.pid && member.uid === process.getuid()));
  assert.ok(members(group).some(member => member.pid === pid && member.ppid === group && member.uid === process.getuid()));
  f.pinGroup(group);
  await ownerLoss(f, owner, false);
});

test("a real startup orphan fails before any Pod LIST or ready handshake", { timeout: 15_000 }, async t => {
  const f = fixture(t, "startup-gate");
  const owner = f.start();
  let pid, group;
  await until(() => (pid = f.pid("launch-pid")) !== undefined && (group = f.pid("launch-group")) !== undefined,
    5000, "launcher did not reach the complete startup PID/PGID seam");
  assert.ok(members(group).some(member => member.pid === group && member.ppid === owner.pid && member.uid === process.getuid()));
  assert.ok(members(group).some(member => member.pid === pid && member.ppid === group && member.uid === process.getuid()));
  f.pinGroup(group);
  assert.equal(f.gets().filter(entry => entry.args.includes("--raw")).length, 0);
  await ownerLoss(f, owner, false);
});

test("normal discard retires the guardian without a failure or surviving group", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const owner = f.start();
  const metadata = await ready(f, owner);
  f.write("finish", "discard\n");
  assert.deepEqual(await f.closed(), { code: 0, signal: null });
  await until(remaining => members(metadata.watchPid, remaining).length === 0, 3000, "normal discard left guardian/group alive");
  assert.equal(f.read("stop"), "discard\n");
  assert.equal(f.read("completed"), "discarded\n");
  assert.equal(f.read("failure"), "");
  assert.equal(f.read("rejects"), "");
});

test("valid-looking but incorrect native owner identity cannot start a Pod GET", { timeout: 15_000 }, async t => {
  const f = fixture(t, "identity-mismatch");
  f.start();
  const result = await f.closed();
  assert.notEqual(result.code, 0);
  assert.equal(f.read("failure"), "runner_watch_failed\n");
  assert.equal(f.read("ready"), "");
  assert.equal(f.gets().filter(entry => entry.args.includes("--raw")).length, 0);
  const group = f.pid("launch-group");
  assert.notEqual(group, undefined, "rejected startup must retain its complete original PGID witness");
  f.pinGroup(group);
  await until(remaining => members(group, remaining).length === 0, 3000, "rejected owner identity left a group");
  assert.equal(f.read("rejects"), "");
});

test("owner CLI rejects omitted, duplicate, malformed or non-socket capabilities", t => {
  const nativeIdentity = identity(process.pid);
  assert.ok(nativeIdentity, "native identity prerequisite unavailable");
  const f = fixture(t);
  const args = ["--context", "fixture-context", "--namespace", "hcce", "--runner-namespace", "hcce-bot-runners",
    "--stop", path.join(f.directory, "stop"), "--failure", path.join(f.directory, "failure"),
    "--ready", path.join(f.directory, "ready"), "--owner-pid", String(process.pid),
    "--owner-start-identity", nativeIdentity, "--owner-control-fd", "3"];
  assert.equal(exactArguments(args).get("--owner-start-identity"), nativeIdentity);
  const replace = (flag, value) => args.map((item, index) => args[index - 1] === flag ? value : item);
  for (const invalid of [args.slice(0, 12), args.concat(["--owner-pid", String(process.pid)]),
    replace("--owner-pid", "0"), replace("--owner-pid", "2147483648"),
    replace("--owner-start-identity", "recycled-or-low-resolution"),
    replace("--owner-control-fd", "2"), replace("--owner-control-fd", "3x")]) {
    assert.throws(() => exactArguments(invalid));
  }
  const descriptor = fs.openSync(path.join(f.directory, "stop"), "r");
  try {
    for (const input of [args, replace("--owner-pid", "1")]) {
      f.write("failure");
      const result = spawnSync(process.execPath, [watcher, ...input], {
        cwd: root, env: f.env, stdio: ["ignore", "ignore", "ignore", descriptor], timeout: 3000
      });
      assert.equal(result.status, 1);
      assert.equal(f.read("failure"), "runner_watch_failed\n");
      assert.equal(f.read("ready"), "");
      assert.equal(f.gets().length, 0);
    }
  } finally {
    fs.closeSync(descriptor);
  }
});

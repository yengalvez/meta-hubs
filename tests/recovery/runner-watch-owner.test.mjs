import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { exactArguments } from "../../deployment/watch-bot-runner-pods.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const library = path.join(root, "deployment/lib/recovery-safety.sh");
const watcher = path.join(root, "deployment/watch-bot-runner-pods.mjs");
const shell = process.env.YENHUBS_TEST_BASH || "bash";
const shellExecutable = spawnSync(shell, ["-c", 'printf "%s" "$BASH"'], {
  encoding: "utf8", timeout: 3000
}).stdout?.trim();
assert.ok(shellExecutable && path.isAbsolute(shellExecutable), "supported Bash executable unavailable");
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
  const result = spawnSync(shell, ["-c",
    'source "$1"; recovery_process_start_identity "$2"', "_", library, String(pid)], {
    cwd: root, encoding: "utf8", timeout: probeTimeout(milliseconds),
    env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function members(group, milliseconds = 3000) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,comm="], {
    encoding: "utf8", timeout: probeTimeout(milliseconds)
  });
  assert.equal(result.status, 0, "native process inventory unavailable");
  return result.stdout.trim().split("\n").filter(Boolean).map(line => {
    const [pid, ppid, pgid, state, ...command] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state, command: command.join(" ") };
  }).filter(value => group === undefined || value.pgid === group);
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
watch_pid="" watch_identity=""
if ! recovery_start_no_managed_bot_runner_watch \
  "$2/stop" "$2/failure" "$2/ready" watch_pid watch_identity "$2/progress"; then
  exit 21
fi
printf '{"ownerPid":%s,"watchPid":%s,"watchIdentity":"%s"}\\n' \
  "$BASHPID" "$watch_pid" "$watch_identity" >"$2/metadata"
while [[ ! -s "$2/finish" ]]; do sleep 0.02; done
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
  for (const name of ["stop", "failure", "ready", "progress", "finish", "gets", "rejects", "completed"]) write(name);
  write("owner.sh", ownerSource);
  write("kubectl", stubSource);
  fs.chmodSync(path.join(directory, "kubectl"), 0o700);
  if (mode === "startup-gate" || mode === "identity-mismatch" || mode === "list-block") {
    write("node", wrapperSource);
    fs.chmodSync(path.join(directory, "node"), 0o700);
  }
  const env = { PATH: `${directory}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    KUBECTL_BIN: path.join(directory, "kubectl"), RUNNER_OWNER_FIXTURE: directory,
    RUNNER_OWNER_MODE: mode, RUNNER_OWNER_NODE: process.execPath };
  // Deliberately do not inherit timing capabilities or another fixture's env.
  let owner;
  let ownerResult;
  let ownerClosed;
  let group;
  const pinnedMembers = new Map();
  function pin(pid, startIdentity) {
    const value = startIdentity || identity(pid);
    if (value) pinnedMembers.set(pid, value);
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
        pinnedMembers.has(member.pid) && identity(member.pid) === pinnedMembers.get(member.pid));
      assert.ok(witness, "refusing cleanup without an exact original group member");
      try { process.kill(-group, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await until(remaining => members(group, remaining).length === 0, 3000, "fixture cleanup left a group member");
    }
    fs.rmSync(directory, { recursive: true });
  });
  return {
    directory, env, write, pinGroup,
    read: name => fs.readFileSync(path.join(directory, name), "utf8"),
    nonempty: name => fs.existsSync(path.join(directory, name)) && fs.statSync(path.join(directory, name)).size > 0,
    gets() { return fs.readFileSync(path.join(directory, "gets"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); },
    blocked() { return fs.readdirSync(directory).filter(name => /^blocked-[0-9]+\.json$/.test(name)).map(name =>
      JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))); },
    start() {
      owner = spawn(shell, [path.join(directory, "owner.sh"), library, directory], {
        cwd: root, env, stdio: "ignore"
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
  await until(() => f.nonempty("metadata") || f.result(), 10_000, "original helper did not become ready");
  assert.equal(f.result(), undefined, "owner exited before ready");
  const metadata = JSON.parse(f.read("metadata"));
  assert.equal(metadata.ownerPid, owner.pid, "BASHPID must identify the real direct owner");
  assert.equal(f.read("ready"), "ready\n");
  assert.ok(Number(f.read("progress")) >= 1);
  assert.equal(identity(metadata.watchPid), metadata.watchIdentity);
  assert.ok(members(metadata.watchPid).some(member => member.pid === metadata.watchPid && member.ppid === owner.pid));
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
  // The watcher is never this driver's child: do not infer an exit
  // code from liveness. Fixed failure + group absence is the available proof.
  return { originalWatcherStatus: "UNKNOWN", failure: "runner_watch_failed", group: "ABSENT" };
}

async function stoppedBlockedWatch(f, metadata) {
  f.write("block", "block\n");
  await until(() => f.blocked().some(value => f.nonempty(value.descendantReady)), 5000,
    "GET-only WATCH stub/ignored-TERM descendant did not enter its blocking call");
  for (const blocked of f.blocked()) {
    const group = members(metadata.watchPid);
    assert.ok(group.some(member => member.pid === blocked.pid));
    assert.ok(group.some(member => member.pid === blocked.descendant), "real ignored-TERM descendant missing");
  }
  f.pinGroup(metadata.watchPid, metadata.watchIdentity);
  assert.equal(identity(metadata.watchPid), metadata.watchIdentity, "SIGSTOP requires the original Node identity");
  process.kill(metadata.watchPid, "SIGSTOP");
  await until(remaining => members(metadata.watchPid, remaining).some(member =>
    member.pid === metadata.watchPid && member.state.startsWith("T")), 1000, "actual Node watcher was not stopped");
}

function guardianPair(f, metadata) {
  const group = members(metadata.watchPid);
  const python = member => /^python(?:[0-9]+(?:\.[0-9]+)*)?$/i.test(path.basename(member.command));
  const pairs = group.filter(member => member.ppid === metadata.watchPid && python(member)).flatMap(first =>
    group.filter(member => member.ppid === first.pid && python(member)).map(second => [first, second]));
  assert.equal(pairs.length, 1, "expected one exact native Node -> guardian A -> guardian B tree in the owned PGID");
  const pair = pairs[0].map(member => ({ ...member, startIdentity: identity(member.pid) }));
  assert.ok(pair.every(member => member.startIdentity), "both guardians require native start identities");
  f.pinGroup(metadata.watchPid, metadata.watchIdentity);
  return pair;
}

async function guardianLoss(f, owner, guardian) {
  assert.equal(f.result(), undefined, "original owner must still be live before guardian loss");
  const ownerIdentity = identity(owner.pid);
  assert.ok(ownerIdentity, "original owner requires a native start identity");
  assert.equal(identity(guardian.pid), guardian.startIdentity, "SIGKILL requires the original guardian identity");
  assert.ok(members(f.group()).some(member => member.pid === guardian.pid && member.ppid === guardian.ppid),
    "SIGKILL requires the original guardian's exact parent and owned PGID");
  const deadline = performance.now() + 3000;
  process.kill(guardian.pid, "SIGKILL");
  await untilBefore(remaining => f.nonempty("failure") && members(f.group(), remaining).length === 0,
    deadline, "individual guardian loss did not durably fail and revoke the entire owned PGID within 3 seconds of SIGKILL");
  assert.equal(f.result(), undefined, "guardian loss case must not kill the live original owner");
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
    assert.ok(group.some(member => member.pid === blocked.pid && member.ppid === metadata.watchPid));
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

test("owner loss cancels a SIGSTOP watcher and WATCH descendants that ignore TERM", { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const owner = f.start();
  const metadata = await ready(f, owner);
  await stoppedBlockedWatch(f, metadata);
  await ownerLoss(f, owner, true);
});

for (const [name, index] of [["A", 0], ["B", 1]]) {
  test(`guardian ${name} SIGKILL revokes a SIGSTOP Node and blocked TERM-ignoring WATCH descendants`, { timeout: 20_000 }, async t => {
    const f = fixture(t);
    const owner = f.start();
    const metadata = await ready(f, owner);
    const guardians = guardianPair(f, metadata);
    await stoppedBlockedWatch(f, metadata);
    await guardianLoss(f, owner, guardians[index]);
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
  assert.equal(identity(metadata.watchPid), metadata.watchIdentity, "the original watcher must remain at the final gate");
  const group = members(metadata.watchPid);
  assert.ok(f.blocked().every(blocked => group.some(member =>
    member.pid === blocked.pid && member.ppid === metadata.watchPid)), "both final requests must still be in flight before release");
  // The driver retains the actual ChildProcess capability. Kill its original
  // owner before releasing real kubectl responses, not via a bare PID in the
  // stub. This covers pre-close loss, not the exact completion handshake.
  await ownerLoss(f, owner, true, () => f.write("final-release", "release\n"));
});

test("independent owner revocation interrupts the watcher's synchronous startup LIST", { timeout: 15_000 }, async t => {
  const f = fixture(t, "list-block");
  const owner = f.start();
  await until(() => f.nonempty("launch-pid") && f.blocked().some(value => f.nonempty(value.descendantReady)),
    5000, "real LIST/ignored-TERM descendant did not block");
  const pid = Number(f.read("launch-pid"));
  assert.ok(members(pid).some(member => member.pid === pid && member.ppid === owner.pid));
  f.pinGroup(pid);
  await ownerLoss(f, owner, false);
});

test("a real startup orphan fails before any Pod LIST or ready handshake", { timeout: 15_000 }, async t => {
  const f = fixture(t, "startup-gate");
  const owner = f.start();
  await until(() => f.nonempty("launch-pid"), 5000, "launcher did not reach the startup seam");
  const pid = Number(f.read("launch-pid"));
  assert.ok(members(pid).some(member => member.pid === pid && member.ppid === owner.pid));
  f.pinGroup(pid);
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
  const pid = Number(f.read("launch-pid"));
  f.pinGroup(pid);
  await until(remaining => members(pid, remaining).length === 0, 3000, "rejected owner identity left a group");
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

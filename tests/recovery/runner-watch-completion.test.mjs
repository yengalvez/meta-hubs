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
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const source = fs.readFileSync(library, "utf8");
const startToken = "    exec python3 -I -c '\n";
const finishToken = "\n' \"$owner_pid\" \"$owner_start_identity\" \"$failure_path\" \"$inventory_path\" node \"$" + '{watcher_args[@]}"';
const begin = source.indexOf(startToken, source.indexOf("recovery_start_no_managed_bot_runner_watch() {"));
const end = source.indexOf(finishToken, begin);
assert.ok(begin > 0 && end > begin, "original native owner launcher unavailable");
const nativeSource = source.slice(begin + startToken.length, end);
const metadataKeys = ["owner", "watcher", "identity", "ownerIdentity"];
const gateKeys = ["primary", "primary_identity", "secondary", "secondary_identity", "node", "node_status", "ack", "eof", "uid", "group", "parent"];
const waitKeys = ["pid", "status", "waiter"];

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
  if (keys.includes("status")) assert.ok(Number.isSafeInteger(value.status) && value.status >= 0 && value.status <= 65535,
    name + " native status must be an integer, never empty/null/string");
  return value;
}

function replaceExactlyOnce(input, expression, replacement, description) {
  assert.equal([...input.matchAll(expression)].length, 1, description + " must identify one original boundary");
  return input.replace(expression, replacement);
}

// The copy-only seams delay scheduling or observe native waits. They never
// replace waitpid/results, peer predicates, ACKs, EOF or the residual check.
function fixtureLauncher(directory, mode) {
  const preamble = `
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
def fixture_gate(name):
    fixture_note(name, {
        "primary": group, "primary_identity": leader_identity,
        "secondary": secondary_pid, "secondary_identity": secondary_identity,
        "node": node_pid, "node_status": node_status,
        "ack": completion_acknowledged, "eof": node_closed,
        "uid": os.getuid(), "group": os.getpgrp(), "parent": os.getppid()
    })
    while not os.path.exists(fixture_directory + "/" + name + "-release"):
        time.sleep(0.005)
`;
  let result = replaceExactlyOnce(nativeSource, /^import time\n/gm,
    "import time\n" + preamble, "copy-only observer preamble");
  result = replaceExactlyOnce(result, /^( +)node_status = status\n/gm,
    (original, indent) => original + indent +
      'fixture_note("node-wait", {"pid": node_pid, "status": node_status, "waiter": os.getpid()})\n',
    "actual owned Node waitpid observation");
  if (mode === "exit-seven" || mode === "initial-failure") {
    result = replaceExactlyOnce(result, /^( +)if \(reaped != node_pid or not completion_acknowledged or\n\1        not node_closed or not zero_exit\(status\)\):\n/gm,
      (original, indent) => indent +
        'fixture_note("node-native-wait", {"pid": node_pid, "status": status, "waiter": os.getpid(), "ack": completion_acknowledged, "eof": node_closed})\n' + original,
      "real owned Node status after original EOF and before original zero-exit predicate");
  }
  result = replaceExactlyOnce(result, /^( +)if reaped:\n\1    if reaped != secondary_pid or not reap_authorized or not zero_exit\(status\):\n/gm,
    (_, indent) => indent + "if reaped:\n" + indent +
      '    fixture_note("b-wait", {"pid": secondary_pid, "status": status, "waiter": os.getpid()})\n' + indent +
      "    if reaped != secondary_pid or not reap_authorized or not zero_exit(status):\n",
    "actual owned B waitpid observation");
  if (mode === "exit-after-select" || mode === "exit-after-select-fresh-b" || mode === "retained-eof") {
    const seam = [
      '        if completion_acknowledged and not node_closed and not os.path.exists(fixture_directory + "/after-select"):',
      '            with open(fixture_directory + "/after-select", "x", encoding="ascii") as witness:',
      '                witness.write("after_select:ack=1:eof=0\\n")',
      "            seam_deadline = time.monotonic() + 2",
      "            while pending_child_is_live(node_pid, node_identity) and time.monotonic() < seam_deadline:",
      "                time.sleep(0.002)",
      "            if pending_child_is_live(node_pid, node_identity):",
      "                revoke()"
    ].join("\n") + "\n";
    result = replaceExactlyOnce(result, /^        # ACK does not synthesize EOF\.[^\n]*\n/gm,
      original => seam + original, "post-select pre-EOF scheduling gap");
  }
  if (mode === "exit-after-select-fresh-b") {
    const seam = [
      '            if completing and node_live and not os.path.exists(fixture_directory + "/b-live-sample"):',
      '                fixture_note("b-live-sample", {"pid": os.getpid(), "parent": os.getppid(), "group": os.getpgrp(), "node": node_pid, "node_live": node_live, "completing": completing})',
      '                while not os.path.exists(fixture_directory + "/b-sample-release"):',
      '                    if select.select([secondary_peer], [], [], 0)[0] and not os.path.exists(fixture_directory + "/b-retire-pending"):',
      '                        fixture_note("b-retire-pending", {"readable": True})',
      '                    time.sleep(0.005)'
    ].join("\n") + "\n";
    result = replaceExactlyOnce(result,
      /^            node_live = node_pid is not None and pending_child_is_live\(node_pid, node_identity\)\n/gm,
      original => original + seam, "original B pre-select live sample copy-only gate");
  }
  if (mode.startsWith("retirement-")) {
    result = replaceExactlyOnce(result, /^( +)# AUTHORIZED_B_RETIRE: residuals\/ambiguous probes never reach here\.\n/gm,
      (original, indent) => original + indent + 'fixture_gate("retirement")\n', "post-residual native retirement gate");
  }
  if (mode === "after-b-zero-stop") {
    result = replaceExactlyOnce(result, /^( +)# ORIGINAL_B_REAP_ZERO: no external operation follows B real zero\.\n/gm,
      (original, indent) => original + indent + 'fixture_gate("after-b-zero")\n', "native B0 pre-A-exit scheduling gap");
  }
  if (mode === "observer-pending") {
    const pendingProbe = `
def fixture_owned_observer_pending(observer, observer_pid, check):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        require_retirement_peers()
        try:
            snapshot = native_snapshot(observer_pid)
        except (OSError, ProcessUnavailable):
            phase = "unavailable"
            snapshot = None
            break
        if snapshot[1:4] != (group, group, False):
            revoke()
        if snapshot[4]:
            phase = "zombie"
            break
        time.sleep(0.002)
    else:
        revoke()
    # No wait/poll/communicate has reaped this actual Popen child. Invoke the
    # ORIGINAL tolerant check at real inventory pipe EOF, before frame/reap.
    check()
    fixture_note("inventory-pending", {"pid": observer_pid, "waiter": os.getpid(),
        "phase": phase, "snapshot": snapshot, "unreaped": observer.returncode is None})
`;
    result = replaceExactlyOnce(result, /^buffers = \{\}\n/gm,
      original => pendingProbe + "\n" + original, "copy-only native inventory pending probe helper");
    result = replaceExactlyOnce(result, /^( +)if not chunk:\n\1    break\n/gm,
      (_, indent) => indent + "if not chunk:\n" + indent +
        "    fixture_owned_observer_pending(observer, observer_pid, check_owned_observer)\n" + indent + "    break\n",
      "real inventory EOF drain before the original complete frame and owned wait");
    result = replaceExactlyOnce(result, /^( +)observer\.returncode = 0\n/gm,
      (original, indent) => original + indent +
        'fixture_note("inventory-native-wait", {"pid": observer_pid, "reaped": reaped, "status": status, "waiter": os.getpid(), "frame_bytes": len(output), "members": members})\n',
      "original owned inventory wait0 after original full frame validation");
  }
  return result;
}

const participant = [
  'import fs from "node:fs";',
  'import {spawn} from "node:child_process";',
  'const [dir,mode,...rest]=process.argv.slice(2);',
  'const ownerPid=rest[rest.indexOf("--owner-pid")+1],ownerIdentity=rest[rest.indexOf("--owner-start-identity")+1];',
  'const fd=Number(rest[rest.indexOf("--owner-control-fd")+1]);',
  'if(process.ppid!==Number(ownerPid)||!fs.fstatSync(fd).isSocket())process.exit(92);',
  'function exchange(message,reply){const bytes=Buffer.from(message+"\\n","ascii");if(fs.writeSync(fd,bytes)!==bytes.length)process.exit(93);const byte=Buffer.alloc(1);let response="";while(response.length<256){if(fs.readSync(fd,byte,0,1,null)!==1)process.exit(94);response+=byte.toString("ascii");if(response.endsWith("\\n"))break;}if(response!==reply+"\\n")process.exit(95);}',
  'exchange("start:"+ownerPid+":"+ownerIdentity,"ready");',
  'fs.writeFileSync(dir+"/node-metadata",JSON.stringify({pid:process.pid,parent:process.ppid}),{mode:0o600});',
  'if(mode==="without-complete"||mode==="partial-complete"){fs.writeFileSync(dir+"/started-only","ready\\n",{mode:0o600});if(mode==="partial-complete")fs.writeSync(fd,Buffer.from("complete","ascii"));fs.closeSync(fd);process.exit(0);}',
  'if(mode==="exit-seven"||mode==="initial-failure"){fs.writeFileSync(dir+"/ready","ready\\n",{mode:0o600});const interval=setInterval(()=>{if(fs.statSync(dir+"/stop").size>0){clearInterval(interval);exchange("complete","complete");fs.writeFileSync(dir+"/complete-acked","acked\\n",{mode:0o600});fs.closeSync(fd);setTimeout(()=>process.exit(mode==="exit-seven"?7:0),150);}},5);}',
  'else{',
  'exchange("complete","complete");',
  'fs.writeFileSync(dir+"/complete-acked","acked\\n",{mode:0o600});',
  'if(mode==="ordered-eof"||mode==="observer-pending"||mode.startsWith("retirement-")||mode==="after-b-zero-stop"){fs.closeSync(fd);setTimeout(()=>process.exit(0),150);}',
  'else if(mode==="residual-descendant"){spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready\\\\n",{mode:0o600});setInterval(()=>{},1000)\',dir+"/holder-ready"],{stdio:"ignore"});const interval=setInterval(()=>{if(fs.existsSync(dir+"/holder-ready")){clearInterval(interval);fs.closeSync(fd);process.exit(0);}},5);}',
  'else{',
  '  if(mode==="retained-eof"){spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready\\\\n",{mode:0o600});setInterval(()=>{},1000)\',dir+"/holder-ready"],{stdio:["ignore","ignore","ignore",fd]});}',
  '  const interval=setInterval(()=>{if(fs.existsSync(dir+"/exit-release")){clearInterval(interval);fs.closeSync(fd);process.exit(0);}},5);',
  '}',
  '}'
].join("\n") + "\n";
const ownerProgram = [
  "set -euo pipefail", "umask 077", 'source "$1"', 'dir="$2"', 'RECOVERY_SAFETY_DIR="$5"',
  'owner_pid="$BASHPID"', 'owner_identity="$(recovery_process_start_identity "$owner_pid")"',
  'python3 -I "$dir/launcher.py" "$owner_pid" "$owner_identity" "$dir/failure" "$5/darwin-process-group-inventory.py" "$3" "$dir/participant.mjs" "$dir" "$4" --owner-pid "$owner_pid" --owner-start-identity "$owner_identity" &',
  "watcher=$!", 'watch_identity="$(recovery_process_start_identity "$watcher")"',
  'printf \'{"owner":%s,"watcher":%s,"identity":"%s","ownerIdentity":"%s"}\\n\' "$owner_pid" "$watcher" "$watch_identity" "$owner_identity" >"$dir/metadata"',
  'if [[ "$4" == after-b-zero-stop ]]; then',
  '  NAMESPACE=hcce EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid EXPECTED_RET_PVC_UID=fixture-pvc-uid',
  '  YENHUBS_RECOVERY_TEST_MODE=local-fixture RECOVERY_TEST_WATCHER_JOIN_TIMEOUT_SECONDS=4',
  '  export NAMESPACE EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID EXPECTED_RET_PVC_UID YENHUBS_RECOVERY_TEST_MODE RECOVERY_TEST_WATCHER_JOIN_TIMEOUT_SECONDS',
  '  printf \'discard\\n\' >"$dir/stop"',
  '  if recovery_wait_isolated_process_bounded "$watcher" "$watch_identity" "$dir/stop"; then joined=0; else joined=$?; fi',
  '  printf \'%s\\n\' "$joined" >"$dir/join-status"',
  'elif [[ "$4" == exit-seven || "$4" == initial-failure ]]; then',
  '  NAMESPACE=hcce EXPECTED_KUBE_CONTEXT=fixture-context',
  '  export NAMESPACE EXPECTED_KUBE_CONTEXT',
  '  while [[ ! -s "$dir/ready" ]]; do sleep 0.02; done',
  '  if [[ "$4" == initial-failure ]]; then printf \'preexisting-invalid\\n\' >"$dir/failure"; printf \'armed\\n\' >"$dir/initial-failure-armed"; fi',
  '  if recovery_stop_no_managed_bot_runner_watch "$dir/stop" "$dir/failure" "$dir/ready" "$watcher" "$watch_identity"; then stopped=0; else stopped=$?; fi',
  '  printf \'%s\\n\' "$stopped" >"$dir/stop-status"',
  'else',
  '  if wait "$watcher"; then observed=0; else observed=$?; fi',
  '  printf \'%s\\n\' "$observed" >"$dir/wait-exit"',
  'fi',
  'while [[ ! -e "$dir/owner-release" ]]; do sleep 0.02; done'
].join("\n") + "\n";

// Only the last-A-stop case uses the existing local join attestation. This
// exact read-only context lookup plus two identity GETs is the whole allowlist;
// every other argument is rejected, and no real kubeconfig/network is used.
const attestationStub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const directory = process.env.RUNNER_COMPLETION_FIXTURE;
fs.appendFileSync(path.join(directory,"attestation-calls"),JSON.stringify(args)+"\\n",{mode:0o600});
const value = new Map([
  ["--request-timeout=45s config current-context","fixture-context"],
  ["--context fixture-context --request-timeout=45s get namespace hcce -o jsonpath={.metadata.uid}","fixture-uid"],
  ["--context fixture-context --request-timeout=45s get pvc ret-pvc -n hcce -o jsonpath={.metadata.uid}","fixture-pvc-uid"]
]).get(args.join(" "));
if(value===undefined){fs.appendFileSync(path.join(directory,"rejects"),"reject\\n",{mode:0o600});process.exit(93);}
console.log(value);
`;

// GET-only allowlist for the fake-Node mechanism STOP cases. There are no
// watch streams or timing overrides; these cases do not certify 61/65s.
const mechanismStopStub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2), directory = process.env.RUNNER_COMPLETION_FIXTURE;
function reject(){fs.appendFileSync(path.join(directory,"rejects"),"unexpected-kubectl\\n",{mode:0o600});process.exit(93);}
if(args[0]!=="--context"||args[1]!=="fixture-context"||args[2]!=="--request-timeout=45s"||args[3]!=="get")reject();
if(args.slice(4).join(" ")==="namespace hcce-bot-runners --ignore-not-found -o json"){
  console.log(JSON.stringify({apiVersion:"v1",kind:"Namespace",metadata:{name:"hcce-bot-runners",uid:"fixture-runner-uid"}}));
}else{
  if(args.length!==6||args[4]!=="--raw"||!/^\\/api\\/v1\\/namespaces\\/(hcce|hcce-bot-runners)\\/pods$/.test(args[5]))reject();
  console.log(JSON.stringify({apiVersion:"v1",kind:"PodList",metadata:{resourceVersion:"10"},items:[]}));
}
`;

function joinFixtureLibrary() {
  let result = source;
  for (const waitLine of ['    if wait "$target_pid"; then wait_status=0; else wait_status=$?; fi',
    '    if wait "$target_pid" 2>/dev/null; then wait_status=0; else wait_status=$?; fi']) {
    assert.equal(result.split(waitLine).length, 2, "original bounded join must retain each exact real Bash wait");
    result = result.replace(waitLine, waitLine + '\n    printf \'%s\\n\' "$wait_status" >"$RUNNER_COMPLETION_FIXTURE/wait-exit"');
  }
  return result;
}

function members(group, remaining = 3000) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat=,comm="], {
    env: nativeShellEnvironment(), encoding: "utf8", timeout: Math.max(1, Math.min(3000, Math.floor(remaining)))
  });
  assert.equal(result.status, 0, "native process inventory unavailable");
  return result.stdout.trim().split("\n").filter(Boolean).map(line => {
    const [pid, ppid, pgid, uid, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), state };
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
  await untilBefore(predicate, performance.now() + milliseconds, description);
}
async function untilBefore(predicate, deadline, description) {
  while (performance.now() < deadline) {
    const matched = predicate(deadline - performance.now());
    if (performance.now() >= deadline) break;
    if (matched) return;
    await pause(Math.min(10, deadline - performance.now()));
  }
  assert.fail(description);
}
function fixture(t, mode) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-runner-completion-"));
  fs.chmodSync(directory, 0o700);
  const write = (name, content = "") => fs.writeFileSync(path.join(directory, name), content, { mode: 0o600, flag: "wx" });
  const read = name => fs.readFileSync(path.join(directory, name), "utf8");
  const present = name => fs.existsSync(path.join(directory, name));
  const optional = name => present(name) ? read(name) : undefined;
  const boundedLastA = mode === "after-b-zero-stop";
  const mechanismStop = mode === "exit-seven" || mode === "initial-failure";
  write("failure"); write("stop"); write("ready"); write("rejects"); write("participant.mjs", participant); write("owner.sh", ownerProgram);
  const originalFailure = fs.statSync(path.join(directory, "failure"));
  write("launcher.py", fixtureLauncher(directory, mode));
  write("kubectl", boundedLastA ? attestationStub : mechanismStop ? mechanismStopStub : `#!${process.execPath}\nrequire("node:fs").appendFileSync(require("node:path").join(process.env.RUNNER_COMPLETION_FIXTURE,"rejects"),"unexpected-kubectl\\n",{mode:0o600});process.exit(93);\n`);
  fs.chmodSync(path.join(directory, "kubectl"), 0o700);
  if (boundedLastA || mechanismStop) write("library.sh", joinFixtureLibrary());
  if (boundedLastA) {
    write("attestation-calls");
  }
  const log = fs.openSync(path.join(directory, "owner.log"), "wx", 0o600);
  const owner = spawn(shell, ["--noprofile", "--norc", path.join(directory, "owner.sh"), boundedLastA || mechanismStop ? path.join(directory, "library.sh") : library, directory, process.execPath, mode, path.dirname(library)], {
    cwd: root, env: { ...nativeShellEnvironment(), PATH: `${directory}:${nativeShellEnvironment().PATH}`,
      KUBECTL_BIN: path.join(directory, "kubectl"), RUNNER_COMPLETION_FIXTURE: directory },
    stdio: ["ignore", log, log]
  });
  let result, group, pins = [];
  const closed = new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.once("close", (code, signal) => { result = { code, signal }; resolve(result); });
  });
  function pinGroup(id) {
    group = id;
    pins = members(group).map(member => ({ ...member, identity: identity(member.pid) }));
  }
  t.after(async () => {
    if (!group && !result) {
      const leader = members().find(member => member.ppid === owner.pid && member.pid === member.pgid && member.uid === process.getuid());
      if (leader) pinGroup(leader.pid);
    }
    if (!result) owner.kill("SIGKILL");
    await closed;
    if (group && members(group).length) {
      assert.ok(members(group).some(member => pins.some(pin => pin.pid === member.pid &&
        pin.uid === member.uid && member.uid === process.getuid() &&
        pin.identity && identity(member.pid) === pin.identity)), "cleanup cannot adopt an unpinned native group");
      try { process.kill(-group, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await until(remaining => members(group, remaining).length === 0, 3000, "cleanup left an original group member");
    }
    fs.fsyncSync(log); fs.closeSync(log);
    if (process.env.YENHUBS_RECOVERY_TEST_KEEP_TMP === "1") {
      process.stderr.write("Retained runner completion fixture: " + directory + "\n");
    } else fs.rmSync(directory, { recursive: true });
  });
  return { directory, owner, write, read, present, pinGroup, originalFailure, closed: () => closed, result: () => result,
    nonempty: name => present(name) && fs.statSync(path.join(directory, name)).size > 0,
    status: name => unsignedWitnessFrame(optional(name), name),
    json: (name, keys, newline = true) => jsonWitnessFrame(optional(name), keys, name, newline) };
}

function gateCapability(f, metadata, gate, role) {
  assert.equal(gate.primary, metadata.watcher); assert.equal(gate.primary_identity, metadata.identity);
  assert.equal(gate.group, metadata.watcher); assert.equal(gate.uid, process.getuid()); assert.equal(gate.parent, metadata.owner);
  assert.equal(gate.node_status, 0); assert.equal(gate.ack, true); assert.equal(gate.eof, true);
  const pid = role === "A" ? gate.primary : gate.secondary;
  const expectedIdentity = role === "A" ? gate.primary_identity : gate.secondary_identity;
  const expectedParent = role === "A" ? metadata.owner : metadata.watcher;
  assert.equal(identity(pid), expectedIdentity, "signal must use the original native role identity");
  const member = members(gate.group).find(value => value.pid === pid);
  assert.ok(member, "selected original role must still be live before the signal");
  assert.equal(member.ppid, expectedParent); assert.equal(member.pgid, metadata.watcher); assert.equal(member.uid, process.getuid());
  assert.ok(!/^[TtZX]/.test(member.state), "a previously stopped/dead role cannot be adopted as this signal capability");
  f.pinGroup(metadata.watcher);
  return { ...member, identity: expectedIdentity };
}

function assertNativeFailure(f, metadata) {
  const observed = f.status("wait-exit");
  assert.notEqual(observed, undefined, "an incomplete native status must remain pending, not count as failure");
  assert.notEqual(observed, 0, "an independently revoked role cannot produce accepted aggregate A0");
  assert.notEqual(observed, 127, "unavailable wait is not a real observed native failure");
  assert.equal(f.result(), undefined); assert.equal(identity(metadata.owner), metadata.ownerIdentity);
  assert.equal(members(metadata.watcher).length, 0, "native group must be absent BEFORE fixture cleanup");
}

for (const [role, signal] of [["A", "SIGKILL"], ["A", "SIGSTOP"], ["B", "SIGKILL"], ["B", "SIGSTOP"]]) {
  test(`native retirement ${role} ${signal} cannot accept an incomplete live participant set`, {
    concurrency: false, timeout: 20_000
  }, async t => {
    const f = fixture(t, `retirement-${role}-${signal}`);
    let metadata, gate;
    await until(() => (metadata = f.json("metadata", metadataKeys)) !== undefined &&
      (gate = f.json("retirement", gateKeys)) !== undefined, 5000, "actual Node0 post-residual retirement gate was not reached");
    assert.equal(metadata.owner, f.owner.pid);
    assert.deepEqual(f.json("node-wait", waitKeys), { pid: gate.node, status: 0, waiter: metadata.watcher });
    assert.equal(members(metadata.watcher).length, 2, "retirement signals require only the exact A/B participants remaining");
    const capability = gateCapability(f, metadata, gate, role);
    const deadline = performance.now() + 3000;
    process.kill(capability.pid, signal);
    // B SIGSTOP cannot reply; A must resume its ORIGINAL peer checks. A loss
    // is independently observed by the still-live B, never by driver cleanup.
    f.write("retirement-release", "release\n");
    await untilBefore(remaining => f.status("wait-exit") !== undefined && f.read("failure") === "runner_watch_failed\n" &&
      members(metadata.watcher, remaining).length === 0, deadline,
    "retirement signal did not durably fail and revoke the original group within 3 seconds");
    assertNativeFailure(f, metadata);
    const failure = fs.statSync(path.join(f.directory, "failure"));
    assert.equal(failure.dev, f.originalFailure.dev); assert.equal(failure.ino, f.originalFailure.ino);
    assert.equal(failure.size, 20); assert.equal(failure.mode & 0o777, 0o600); assert.equal(failure.uid, process.getuid());
    f.write("owner-release", "release\n");
    assert.deepEqual(await f.closed(), { code: 0, signal: null });
  });
}

test("native retirement rejects an empty private replacement of the original failure inode", {
  concurrency: false, timeout: 20_000
}, async t => {
  const f = fixture(t, "retirement-marker-replacement");
  let metadata, gate;
  await until(() => (metadata = f.json("metadata", metadataKeys)) !== undefined &&
    (gate = f.json("retirement", gateKeys)) !== undefined, 5000, "post-residual retirement marker boundary was not reached");
  gateCapability(f, metadata, gate, "A"); gateCapability(f, metadata, gate, "B");
  assert.equal(f.read("failure"), "");
  f.write("replacement-failure");
  // Preserve the original bytes/inode under another private fixture name;
  // this negative deliberately substitutes another empty 0600 inode.
  fs.renameSync(path.join(f.directory, "failure"), path.join(f.directory, "original-failure"));
  fs.renameSync(path.join(f.directory, "replacement-failure"), path.join(f.directory, "failure"));
  const replacement = fs.statSync(path.join(f.directory, "failure"));
  assert.notEqual(replacement.ino, f.originalFailure.ino); assert.equal(replacement.size, 0);
  assert.equal(replacement.uid, process.getuid()); assert.equal(replacement.mode & 0o777, 0o600);
  const deadline = performance.now() + 3000;
  f.write("retirement-release", "release\n");
  await untilBefore(remaining => f.status("wait-exit") !== undefined && members(metadata.watcher, remaining).length === 0,
    deadline, "empty replacement marker must fail closed before cleanup");
  assertNativeFailure(f, metadata);
  assert.equal(f.read("failure"), "", "observer replacement bytes cannot count as a native publisher failure frame");
  assert.equal(fs.statSync(path.join(f.directory, "failure")).ino, replacement.ino);
  assert.equal(fs.statSync(path.join(f.directory, "original-failure")).ino, f.originalFailure.ino);
  f.write("owner-release", "release\n");
  assert.deepEqual(await f.closed(), { code: 0, signal: null });
});

test("native retirement A SIGSTOP after actual B0 is bounded by the original attested join watchdog", {
  concurrency: false, timeout: 25_000
}, async t => {
  const f = fixture(t, "after-b-zero-stop");
  let metadata, gate;
  await until(() => (metadata = f.json("metadata", metadataKeys)) !== undefined &&
    (gate = f.json("after-b-zero", gateKeys)) !== undefined, 5000, "actual B0 pre-A-exit scheduling gap was not reached");
  const bWait = f.json("b-wait", waitKeys);
  assert.deepEqual(bWait, { pid: gate.secondary, status: 0, waiter: metadata.watcher });
  assert.deepEqual(f.json("node-wait", waitKeys), { pid: gate.node, status: 0, waiter: metadata.watcher });
  assert.equal(members(metadata.watcher).length, 1, "only original A may remain after real B0");
  const capability = gateCapability(f, metadata, gate, "A");
  const stoppedAt = performance.now();
  process.kill(capability.pid, "SIGSTOP");
  await until(remaining => members(metadata.watcher, remaining).some(member => member.pid === capability.pid && member.state.startsWith("T")),
    1000, "original A did not enter native SIGSTOP");
  // Existing attested join=4s + the ORIGINAL watchdog's 2s TERM/KILL grace,
  // with native inventory delivery budget. Do not claim a false 3s guarantee.
  let joined;
  await until(remaining => f.status("wait-exit") !== undefined && (joined = f.status("join-status")) !== undefined &&
    members(metadata.watcher, remaining).length === 0,
    9000 - (performance.now() - stoppedAt), "original bounded join left stopped A alive or accepted zero");
  assertNativeFailure(f, metadata);
  assert.notEqual(joined, 0, "bounded original join cannot accept pending/stopped A");
  assert.equal(f.read("failure"), "", "after B0 no native publisher remains; only a real nonzero A wait authorizes failure");
  const calls = f.read("attestation-calls").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(calls, [
    ["--request-timeout=45s", "config", "current-context"],
    ["--context", "fixture-context", "--request-timeout=45s", "get", "namespace", "hcce", "-o", "jsonpath={.metadata.uid}"],
    ["--context", "fixture-context", "--request-timeout=45s", "get", "pvc", "ret-pvc", "-n", "hcce", "-o", "jsonpath={.metadata.uid}"]
  ], "only the original exact local attestation read surface may run");
  assert.equal(f.read("rejects"), "");
  f.write("owner-release", "release\n");
  assert.deepEqual(await f.closed(), { code: 0, signal: null });
});

for (const [mode, title, expectedNodeStatus] of [
  ["exit-seven", "fake Node mechanism rejects real exit7 after mutual ACK and EOF", 7 * 256],
  ["initial-failure", "fake Node mechanism closes the aggregate when the initial failure marker is invalid", 0]
]) {
  test(title, { concurrency: false, timeout: 25_000 }, async t => {
    const f = fixture(t, mode);
    let metadata, node;
    await until(() => (metadata = f.json("metadata", metadataKeys)) !== undefined &&
      (node = f.json("node-metadata", ["pid", "parent"], false)) !== undefined &&
      f.read("ready") === "ready\n", 5000, "fake Node mechanism did not complete its native start handshake");
    assert.equal(metadata.owner, f.owner.pid); assert.equal(node.parent, metadata.watcher);
    assert.ok(Number.isSafeInteger(node.pid) && node.pid > 0, "mechanism witness must identify the actual Node child");
    f.pinGroup(metadata.watcher);
    let stopped, nativeNode;
    await until(remaining => (stopped = f.status("stop-status")) !== undefined &&
      f.status("wait-exit") !== undefined &&
      (nativeNode = f.json("node-native-wait", ["pid", "status", "waiter", "ack", "eof"])) !== undefined &&
      members(metadata.watcher, remaining).length === 0,
    10_000, "original STOP must observe a real nonzero A wait and close the original aggregate before cleanup");
    assert.notEqual(stopped, 0, "original STOP cannot accept a real Node7 or an invalid initial marker");
    assertNativeFailure(f, metadata);
    assert.deepEqual(nativeNode, { pid: node.pid, status: expectedNodeStatus, waiter: metadata.watcher, ack: true, eof: true },
      "ACK/EOF cannot synthesize the real owned Node wait status");
    assert.equal(f.read("complete-acked"), "acked\n");
    assert.equal(f.present("b-wait"), false, "both selected failures must precede authorized B retirement");
    if (mode === "exit-seven") {
      const boundary = f.json("stop", ["stop", "boundaries"]);
      assert.equal(boundary.stop, true, "Node7 must follow an original valid STOP boundary, not an invalid setup");
      assert.ok(boundary.boundaries.length > 0);
      assert.equal(f.present("node-wait"), false, "the raw native Node7 must never become the validated Node0 witness");
    } else {
      assert.equal(f.read("initial-failure-armed"), "armed\n");
      assert.equal(f.read("stop"), "discard\n", "invalid initial failure metadata must enter the original discard/join close path");
      assert.deepEqual(f.json("node-wait", waitKeys), { pid: node.pid, status: 0, waiter: metadata.watcher });
    }
    assert.equal(f.read("failure"), "runner_watch_failed\n", "only the original native publisher may close the failure marker");
    const failure = fs.statSync(path.join(f.directory, "failure"));
    assert.equal(failure.dev, f.originalFailure.dev); assert.equal(failure.ino, f.originalFailure.ino);
    assert.equal(failure.size, 20); assert.equal(failure.mode & 0o777, 0o600); assert.equal(failure.uid, process.getuid());
    assert.equal(f.read("rejects"), "", "mechanism STOP must stay inside the closed GET-only fixture");
    f.write("owner-release", "release\n");
    assert.deepEqual(await f.closed(), { code: 0, signal: null });
  });
}

test("fake Node mechanism keeps a real unreaped inventory zombie or unavailable snapshot pending until full frame and native wait0", {
  concurrency: false, timeout: 25_000
}, async t => {
  const f = fixture(t, "observer-pending");
  let metadata, node;
  await until(() => (metadata = f.json("metadata", metadataKeys)) !== undefined &&
    (node = f.json("node-metadata", ["pid", "parent"], false)) !== undefined &&
    f.present("complete-acked") && f.read("complete-acked") === "acked\n",
  5000, "fake Node mechanism did not complete its native mutual ACK");
  assert.equal(metadata.owner, f.owner.pid); assert.equal(node.parent, metadata.watcher);
  f.pinGroup(metadata.watcher);
  let exited, pending, observed;
  await until(remaining => (exited = f.status("wait-exit")) !== undefined &&
    (pending = f.json("inventory-pending", ["pid", "waiter", "phase", "snapshot", "unreaped"])) !== undefined &&
    (observed = f.json("inventory-native-wait", ["pid", "reaped", "status", "waiter", "frame_bytes", "members"])) !== undefined &&
    members(metadata.watcher, remaining).length === 0,
  10_000, "unreaped inventory snapshot must stay pending and then satisfy the original full frame plus native wait0");
  assert.equal(exited, 0, "only a real owned A0 can accept the original observer closure");
  assert.equal(pending.waiter, metadata.watcher); assert.equal(pending.unreaped, true);
  assert.ok(["zombie", "unavailable"].includes(pending.phase), "a live snapshot does not exercise the selected pending state");
  assert.equal(observed.pid, pending.pid); assert.equal(observed.reaped, pending.pid);
  assert.equal(observed.waiter, metadata.watcher); assert.equal(observed.status, 0);
  assert.ok(Number.isSafeInteger(pending.pid) && pending.pid > 0);
  if (pending.phase === "zombie") {
    assert.equal(pending.snapshot.length, 5); assert.ok(pending.snapshot[0]);
    assert.deepEqual(pending.snapshot.slice(1), [metadata.watcher, metadata.watcher, false, true],
      "the original zombie snapshot must still bind the exact parent and PGID");
  } else assert.equal(pending.snapshot, null, "snapshot absence is pending, never an invented identity or native status");
  assert.ok(Number.isSafeInteger(observed.frame_bytes) && observed.frame_bytes > 0 && observed.frame_bytes <= 1048576,
    "original inventory must supply a complete bounded nonempty frame before native wait0");
  assert.deepEqual(f.json("node-wait", waitKeys), { pid: node.pid, status: 0, waiter: metadata.watcher });
  const bWait = f.json("b-wait", waitKeys);
  assert.equal(bWait.status, 0); assert.equal(bWait.waiter, metadata.watcher);
  assert.deepEqual(Object.keys(observed.members).sort(), [metadata.watcher, bWait.pid, pending.pid].map(String).sort(),
    "the unchanged full frame must contain exactly the original A/B and actual owned inventory child");
  for (const [pid, [parent, uid, state]] of Object.entries(observed.members)) {
    assert.equal(parent, Number(pid) === metadata.watcher ? metadata.owner : metadata.watcher);
    assert.equal(uid, process.getuid()); assert.ok(typeof state === "string" && state.length > 0);
    assert.ok(!/^[TtX]/.test(state));
    if (Number(pid) !== pending.pid) assert.ok(!state.startsWith("Z"));
  }
  assert.equal(f.result(), undefined); assert.equal(identity(metadata.owner), metadata.ownerIdentity);
  assert.equal(f.read("failure"), "");
  const failure = fs.statSync(path.join(f.directory, "failure"));
  assert.equal(failure.dev, f.originalFailure.dev); assert.equal(failure.ino, f.originalFailure.ino);
  assert.equal(failure.size, 0); assert.equal(failure.mode & 0o777, 0o600); assert.equal(failure.uid, process.getuid());
  assert.equal(f.read("rejects"), "");
  f.write("owner-release", "release\n");
  assert.deepEqual(await f.closed(), { code: 0, signal: null });
});

for (const [mode, failure] of [
  ["ordered-eof", ""],
  ["exit-after-select", ""],
  ["exit-after-select-fresh-b", ""],
  ["retained-eof", "runner_watch_failed\n"],
  ["residual-descendant", "runner_watch_failed\n"],
  ["without-complete", "runner_watch_failed\n"],
  ["partial-complete", "runner_watch_failed\n"]
]) {
  test("native completion " + mode + " requires mutual ACK, exact EOF and real exit", {
    concurrency: false, timeout: 25_000
  }, async t => {
    const f = fixture(t, mode);
    const startOnly = mode === "without-complete" || mode === "partial-complete";
    const handshakeName = startOnly ? "started-only" : "complete-acked";
    let metadata, node;
    await until(() => (metadata = f.json("metadata", metadataKeys)) !== undefined &&
      (node = f.json("node-metadata", ["pid", "parent"], false)) !== undefined &&
      f.present(handshakeName) && f.read(handshakeName) === (startOnly ? "ready\n" : "acked\n"),
    5000, "complete native handshake witnesses were not reached");
    assert.equal(metadata.owner, f.owner.pid);
    assert.equal(f.result(), undefined, "original owner must remain live");
    if (mode === "exit-after-select" || mode === "exit-after-select-fresh-b" || mode === "retained-eof") {
      await until(() => f.present("after-select") && f.read("after-select") === "after_select:ack=1:eof=0\n" &&
        (mode !== "retained-eof" || f.present("holder-ready")), 3000, "controlled post-select boundary was not reached");
      assert.equal(f.read("after-select"), "after_select:ack=1:eof=0\n");
      assert.equal(identity(metadata.watcher), metadata.identity, "original supervisor A must be live before the forced Node exit");
      const nodeIdentity = identity(node.pid);
      assert.ok(nodeIdentity, "forced exit requires the live original Node identity");
      assert.equal(node.parent, metadata.watcher, "Node must be the direct supervisor A child");
      assert.ok(members(metadata.watcher).some(member => member.pid === node.pid &&
        member.ppid === metadata.watcher && member.uid === process.getuid()), "forced exit requires the exact Node parent/UID/PGID");
      f.pinGroup(metadata.watcher);
      if (mode === "exit-after-select-fresh-b") {
        await until(() => f.present("b-live-sample"), 1000,
          "B must retain its original live Node sample before the actual Node exit");
        const sampled = f.json("b-live-sample", ["pid", "parent", "group", "node", "node_live", "completing"]);
        assert.equal(sampled.parent, metadata.watcher); assert.equal(sampled.group, metadata.watcher);
        assert.ok(members(metadata.watcher).some(member => member.pid === sampled.pid &&
          member.ppid === metadata.watcher && member.uid === process.getuid()),
        "controlled retirement must use the original direct B child and PGID");
        assert.equal(sampled.node, node.pid); assert.equal(sampled.node_live, true); assert.equal(sampled.completing, true);
      }
      f.write("exit-release", "release\n");
      if (mode === "exit-after-select-fresh-b") {
        await until(() => f.present("b-retire-pending"), 2000,
          "A's original retirement message must become readable after actual Node0");
        assert.deepEqual(f.json("node-wait", waitKeys), { pid: node.pid, status: 0, waiter: metadata.watcher });
        assert.deepEqual(f.json("b-retire-pending", ["readable"]), { readable: true });
        f.write("b-sample-release", "release\n");
      }
    }
    let supervisorExit;
    await until(remaining => (supervisorExit = f.status("wait-exit")) !== undefined && members(metadata.watcher, remaining).length === 0,
      3000, "native completion did not retire/revoke the exact group");
    if (failure) assert.notEqual(supervisorExit, 0, "native A exit cannot accept a missing ACK/EOF or residual descendant");
    else assert.equal(supervisorExit, 0, "authorized completion requires a native zero exit from the owned supervisor A");
    if (!failure) {
      assert.deepEqual(f.json("node-wait", waitKeys), { pid: node.pid, status: 0, waiter: metadata.watcher });
      const bWait = f.json("b-wait", waitKeys);
      assert.equal(bWait.status, 0); assert.equal(bWait.waiter, metadata.watcher);
    }
    if (mode === "residual-descendant") {
      assert.ok(f.present("holder-ready"), "the residual must actually have entered its TERM-ignoring handler");
      assert.deepEqual(f.json("node-wait", waitKeys), { pid: node.pid, status: 0, waiter: metadata.watcher },
        "a failed Node cannot substitute for a residual after successful native Node0");
      assert.equal(f.present("b-wait"), false, "residual rejection must precede authorized B retirement");
    }
    assert.equal(f.result(), undefined, "original owner must survive native completion");
    assert.equal(identity(metadata.owner), metadata.ownerIdentity);
    assert.equal(f.read("failure"), failure, "never confuse an unread EOF with absent authorization");
    const currentFailure = fs.statSync(path.join(f.directory, "failure"));
    assert.equal(currentFailure.dev, f.originalFailure.dev); assert.equal(currentFailure.ino, f.originalFailure.ino);
    assert.equal(currentFailure.uid, process.getuid()); assert.equal(currentFailure.mode & 0o777, 0o600);
    assert.equal(currentFailure.size, failure ? 20 : 0);
    assert.equal(f.read("rejects"), "");
    f.write("owner-release", "release\n");
    assert.deepEqual(await f.closed(), { code: 0, signal: null });
  });
}

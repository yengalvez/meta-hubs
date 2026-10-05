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
const finishToken = "\n' \"$owner_pid\" \"$owner_start_identity\" \"$failure_path\" node \"$" + '{watcher_args[@]}"';
const begin = source.indexOf(startToken, source.indexOf("recovery_start_no_managed_bot_runner_watch() {"));
const end = source.indexOf(finishToken, begin);
assert.ok(begin > 0 && end > begin, "original native owner launcher unavailable");
const nativeSource = source.slice(begin + startToken.length, end);
const seam = "                leader_live = leader_is_live()\n                if not leader_live:\n";
assert.equal(nativeSource.split(seam).length, 2, "review the scheduling seam if the native loop changes");
// Force only a legitimate scheduling gap after select, before the subsequent
// native-exit probe. No predicate/result/ACK/EOF is replaced or fabricated.
const schedulingSeam = [
  '                seam_dir = os.environ.get("RUNNER_COMPLETION_SEAM", "")',
  '                if completion_acknowledged and not node_closed and seam_dir and not os.path.exists(seam_dir + "/after-select"):',
  '                    with open(seam_dir + "/after-select", "x", encoding="ascii") as witness:',
  '                        witness.write("after_select:ack=1:eof=0\\n")',
  "                    seam_deadline = time.monotonic() + 2",
  "                    while leader_is_live() and time.monotonic() < seam_deadline:",
  "                        time.sleep(0.002)",
  "                    if leader_is_live():",
  "                        revoke()"
].join("\n") + "\n";

const participant = [
  'import fs from "node:fs";',
  'import {spawn} from "node:child_process";',
  'const [dir,mode,ownerPid,ownerIdentity,...rest]=process.argv.slice(2);',
  'const fd=Number(rest[rest.indexOf("--owner-control-fd")+1]);',
  'if(process.ppid!==Number(ownerPid)||!fs.fstatSync(fd).isSocket())process.exit(92);',
  'function exchange(message,reply){const bytes=Buffer.from(message+"\\n","ascii");if(fs.writeSync(fd,bytes)!==bytes.length)process.exit(93);const byte=Buffer.alloc(1);let response="";while(response.length<256){if(fs.readSync(fd,byte,0,1,null)!==1)process.exit(94);response+=byte.toString("ascii");if(response.endsWith("\\n"))break;}if(response!==reply+"\\n")process.exit(95);}',
  'exchange("start:"+ownerPid+":"+ownerIdentity,"ready");',
  'if(mode==="without-complete"){fs.writeFileSync(dir+"/started-only","ready\\n",{mode:0o600});fs.closeSync(fd);process.exit(0);}',
  'exchange("complete","complete");',
  'fs.writeFileSync(dir+"/complete-acked","acked\\n",{mode:0o600});',
  'if(mode==="ordered-eof"){fs.closeSync(fd);setTimeout(()=>process.exit(0),150);}',
  'else{',
  '  if(mode==="retained-eof"){spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready\\\\n",{mode:0o600});setInterval(()=>{},1000)\',dir+"/holder-ready"],{stdio:["ignore","ignore","ignore",fd]});}',
  '  const interval=setInterval(()=>{if(fs.existsSync(dir+"/exit-release")){clearInterval(interval);fs.closeSync(fd);process.exit(0);}},5);',
  '}'
].join("\n") + "\n";
const ownerProgram = [
  "set -euo pipefail", "umask 077", 'source "$1"', 'dir="$2"',
  'owner_pid="$BASHPID"', 'owner_identity="$(recovery_process_start_identity "$owner_pid")"',
  'python3 -I "$dir/launcher.py" "$owner_pid" "$owner_identity" "$dir/failure" "$3" "$dir/participant.mjs" "$dir" "$4" "$owner_pid" "$owner_identity" &',
  "watcher=$!", 'watch_identity="$(recovery_process_start_identity "$watcher")"',
  'printf \'{"owner":%s,"watcher":%s,"identity":"%s","ownerIdentity":"%s"}\\n\' "$owner_pid" "$watcher" "$watch_identity" "$owner_identity" >"$dir/metadata"',
  'if wait "$watcher"; then observed=0; else observed=$?; fi',
  'printf \'%s\\n\' "$observed" >"$dir/wait-exit"',
  'while [[ ! -e "$dir/owner-release" ]]; do sleep 0.02; done'
].join("\n") + "\n";

function members(group, remaining = 3000) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,comm="], {
    env: nativeShellEnvironment(), encoding: "utf8", timeout: Math.max(1, Math.min(3000, Math.floor(remaining)))
  });
  assert.equal(result.status, 0, "native process inventory unavailable");
  return result.stdout.trim().split("\n").filter(Boolean).map(line => {
    const [pid, ppid, pgid, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state };
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
  const forced = mode === "exit-after-select" || mode === "retained-eof";
  write("failure"); write("participant.mjs", participant); write("owner.sh", ownerProgram);
  write("launcher.py", forced ? nativeSource.replace(seam, schedulingSeam + seam) : nativeSource);
  const log = fs.openSync(path.join(directory, "owner.log"), "wx", 0o600);
  const owner = spawn(shell, ["--noprofile", "--norc", path.join(directory, "owner.sh"), library, directory, process.execPath, mode], {
    cwd: root, env: { ...nativeShellEnvironment(), ...(forced ? { RUNNER_COMPLETION_SEAM: directory } : {}) },
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
      const leader = members().find(member => member.ppid === owner.pid && member.pid === member.pgid);
      if (leader) pinGroup(leader.pid);
    }
    if (!result) owner.kill("SIGKILL");
    await closed;
    if (group && members(group).length) {
      assert.ok(members(group).some(member => pins.some(pin => pin.pid === member.pid &&
        pin.identity && identity(member.pid) === pin.identity)), "cleanup cannot adopt an unpinned native group");
      try { process.kill(-group, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await until(remaining => members(group, remaining).length === 0, 3000, "cleanup left an original group member");
    }
    fs.fsyncSync(log); fs.closeSync(log);
    if (process.env.YENHUBS_RECOVERY_TEST_KEEP_TMP === "1") {
      process.stderr.write("Retained runner completion fixture: " + directory + "\n");
    } else fs.rmSync(directory, { recursive: true });
  });
  return { directory, owner, write, read, present, pinGroup, closed: () => closed, result: () => result };
}

for (const [mode, failure] of [
  ["ordered-eof", ""],
  ["exit-after-select", ""],
  ["retained-eof", "runner_watch_failed\n"],
  ["without-complete", "runner_watch_failed\n"]
]) {
  test("native completion " + mode + " requires mutual ACK, exact EOF and real exit", {
    concurrency: false, timeout: 25_000
  }, async t => {
    const f = fixture(t, mode);
    await until(() => f.present("metadata") &&
      f.present(mode === "without-complete" ? "started-only" : "complete-acked"), 5000, "native handshake was not reached");
    const metadata = JSON.parse(f.read("metadata"));
    assert.equal(metadata.owner, f.owner.pid);
    assert.equal(f.result(), undefined, "original owner must remain live");
    if (mode === "exit-after-select" || mode === "retained-eof") {
      await until(() => f.present("after-select") &&
        (mode !== "retained-eof" || f.present("holder-ready")), 3000, "controlled post-select boundary was not reached");
      assert.equal(f.read("after-select"), "after_select:ack=1:eof=0\n");
      assert.equal(identity(metadata.watcher), metadata.identity, "original Node must be live before the forced exit");
      f.pinGroup(metadata.watcher);
      f.write("exit-release", "release\n");
    }
    await until(remaining => f.present("wait-exit") && members(metadata.watcher, remaining).length === 0,
      3000, "native completion did not retire/revoke the exact group");
    const participantExit = Number(f.read("wait-exit").trim());
    if (mode === "without-complete") {
      assert.ok([0, 137, 143].includes(participantExit), "only a real exit or native guard revocation is valid without completion ACK");
    } else assert.equal(participantExit, 0, "authorized Node participant must have a normal native exit");
    assert.equal(f.result(), undefined, "original owner must survive native completion");
    assert.equal(identity(metadata.owner), metadata.ownerIdentity);
    assert.equal(f.read("failure"), failure, "never confuse an unread EOF with absent authorization");
    f.write("owner-release", "release\n");
    assert.deepEqual(await f.closed(), { code: 0, signal: null });
  });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nativeShellEnvironment } from "./native-bash.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const utility = path.join(root, "deployment/lib/darwin-process-group-inventory.py");
const library = path.join(root, "deployment/lib/recovery-safety.sh");

// These two native cases own a fresh session and all its participants. Pipe
// EOF is not a wait result: the inventory must capture each real zombie BEFORE
// the controller reaps it. No process of another UID and no admin API is used.
const nativeController = `
import json
import os
import signal
import subprocess
import sys

inventory_path, zombie_count = sys.argv[1], int(sys.argv[2])
assert sys.platform == "darwin" and zombie_count in (1, 2)
owned = set()
def deadline(signum, frame):
    raise TimeoutError("native inventory fixture deadline")
signal.signal(signal.SIGALRM, deadline)
signal.signal(signal.SIGTERM, deadline)
signal.alarm(6)
try:
    os.setsid()
    group, uid = os.getpgrp(), os.getuid()
    assert group == os.getpid() and uid == os.geteuid()
    children = []
    for index in range(zombie_count):
        read_fd, write_fd = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(read_fd)
            os._exit(7)
        owned.add(child)
        children.append(child)
        os.close(write_fd)
        assert os.read(read_fd, 1) == b""
        os.close(read_fd)
    observer = subprocess.Popen(
        [sys.executable, "-I", inventory_path, str(group)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, close_fds=True)
    owned.add(observer.pid)
    payload = observer.stdout.read(1048577)
    observer.stdout.close()
    assert observer.returncode is None
    assert len(payload) <= 1048576
    rows = {}
    if zombie_count == 1:
        assert payload.endswith(b"\\n")
        lines = payload.decode("ascii").splitlines()
        assert lines[0] == "yenhubs-process-group-v1 %d 3" % group
        assert lines[-1] == "complete %d 3" % group and len(lines) == 5
        for line in lines[1:-1]:
            fields = line.split(" ")
            assert len(fields) == 5 and all(field.isdigit() for field in fields[:4])
            pid, parent, pgid, row_uid = map(int, fields[:4])
            assert pid > 0 and pid not in rows and pgid == group and row_uid == uid
            rows[pid] = (parent, pgid, row_uid, fields[4])
        assert set(rows) == {group, children[0], observer.pid}
        assert rows[group][0] == os.getppid()
        assert rows[observer.pid][:3] == (group, group, uid)
        assert rows[children[0]] == (group, group, uid, "Z")
    else:
        # Four actual participants exhaust the exact four-pid_t buffer. A
        # partial three-member inventory must never publish a COMPLETE frame.
        assert not payload.startswith(b"yenhubs-process-group-v1 ")
        assert not any(line.startswith(b"complete ") for line in payload.splitlines())
    reaped, observer_status = os.waitpid(observer.pid, 0)
    assert reaped == observer.pid and os.WIFEXITED(observer_status)
    owned.remove(reaped)
    observer.returncode = os.WEXITSTATUS(observer_status)
    assert (observer_status == 0) if zombie_count == 1 else (observer_status != 0)
    child_statuses = []
    for child in children:
        reaped, status = os.waitpid(child, 0)
        assert reaped == child and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 7
        owned.remove(reaped)
        child_statuses.append({"pid": child, "status": status})
    proof = {"group": group, "uid": uid, "observer": observer.pid,
        "observer_status": observer_status, "children": child_statuses,
        "frame": payload.decode("ascii"), "frame_before_wait": True,
        "observer_unreaped_at_capture": True}
finally:
    signal.alarm(0)
    # Error-only cleanup uses actual unreaped child ownership; it cannot
    # publish a success proof or signal any other process/group.
    for child in owned:
        try:
            reaped, status = os.waitpid(child, os.WNOHANG)
            if reaped == 0:
                os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)
        except ChildProcessError:
            pass
print(json.dumps(proof, sort_keys=True))
`;

function nativeInventory(t, zombieCount) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-darwin-inventory-"));
  fs.chmodSync(directory, 0o700);
  const write = (name, value) => {
    const descriptor = fs.openSync(path.join(directory, name), "wx", 0o600);
    try { fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  };
  t.after(() => {
    if (process.env.YENHUBS_RECOVERY_TEST_KEEP_TMP === "1") {
      process.stderr.write("Retained Darwin inventory fixture: " + directory + "\n");
    } else fs.rmSync(directory, { recursive: true });
  });
  const result = spawnSync("python3", ["-I", "-c", nativeController, utility, String(zombieCount)], {
    cwd: root, env: nativeShellEnvironment(), encoding: "utf8", timeout: 12_000, maxBuffer: 1048576
  });
  write("controller-stdout", result.stdout || ""); write("controller-stderr", result.stderr || "");
  assert.equal(result.status, 0, "native controller must finish by its own real waits: " + result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /^\{[^\n]*\}\n$/, "native proof must be complete before acceptance");
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.group, result.pid); assert.equal(proof.uid, process.getuid());
  assert.equal(proof.frame_before_wait, true); assert.equal(proof.observer_unreaped_at_capture, true);
  assert.equal(proof.children.length, zombieCount);
  for (const child of proof.children) {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0); assert.equal(child.status, 7 * 256);
  }
  assert.throws(() => process.kill(-proof.group, 0), { code: "ESRCH" },
    "original native group must be absent BEFORE fixture cleanup");
  return proof;
}

test("Darwin native inventory captures SAME_UID owner, observer and unreaped zombie before real waits", {
  concurrency: false, skip: process.platform !== "darwin", timeout: 20_000
}, t => {
  const proof = nativeInventory(t, 1);
  assert.equal(proof.observer_status, 0);
  assert.ok(proof.frame.startsWith("yenhubs-process-group-v1 " + proof.group + " 3\n"));
  assert.ok(proof.frame.endsWith("complete " + proof.group + " 3\n"));
});

test("Darwin native inventory rejects a fourth member without publishing COMPLETE", {
  concurrency: false, skip: process.platform !== "darwin", timeout: 20_000
}, t => {
  const proof = nativeInventory(t, 2);
  assert.ok(Number.isSafeInteger(proof.observer_status) && proof.observer_status > 0);
  assert.ok(!proof.frame.startsWith("yenhubs-process-group-v1 "));
  assert.ok(!proof.frame.split("\n").some(line => line.startsWith("complete ")));
});

// Everything below is explicitly SIMULATED. CDLL is forbidden during import
// and replaced only inside this isolated Python fixture for ABI/error checks.
// These cases cannot establish the existence of a native foreign-UID process.
const simulatedPreamble = `
import ast
import ctypes
import errno
import importlib.util
import pathlib
import sys
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location("yenhubs_simulated_inventory", sys.argv[1])
M = importlib.util.module_from_spec(spec)
with mock.patch.object(ctypes, "CDLL", side_effect=AssertionError("native library access during import")):
    spec.loader.exec_module(M)

def rejected(action):
    try:
        action()
    except M.InventoryError:
        return
    raise AssertionError("incomplete or ambiguous inventory was accepted")

class SimulatedCall:
    def __init__(self, function):
        self.function = function
    def __call__(self, *arguments):
        return self.function(*arguments)

def api_fixture(pids=(), list_result=None, list_errno=0, short_result=64,
                short_errno=0, short_changes=None):
    calls = {"load": [], "list": [], "short": []}
    def list_call(kind, group, buffer, size):
        assert ctypes.get_errno() == 0, "list errno must be cleared immediately before the call"
        assert kind == 2 and group == 100 and buffer is not None and size == 16
        calls["list"].append((kind, group, size))
        target = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_int32))
        for index, pid in enumerate(pids[:4]):
            target[index] = pid
        ctypes.set_errno(list_errno)
        return 4 * len(pids) if list_result is None else list_result
    def short_call(pid, flavor, argument, buffer, size):
        assert ctypes.get_errno() == 0, "short-info errno must be cleared immediately before the call"
        assert flavor == 13 and argument == 1 and buffer is not None and size == 64
        calls["short"].append((pid, flavor, argument, size))
        record = M.ProcBsdShortInfo(pid=pid, ppid=100, pgid=100, uid=502, status=3)
        for key, value in (short_changes or {}).items():
            setattr(record, key, value)
        ctypes.memmove(buffer, ctypes.byref(record), 64)
        ctypes.set_errno(short_errno)
        return short_result
    lib = SimpleNamespace(proc_listpids=SimulatedCall(list_call), proc_pidinfo=SimulatedCall(short_call))
    def load(filename, **options):
        assert filename == "/usr/lib/libproc.dylib" and options == {"use_errno": True}
        calls["load"].append(filename)
        return lib
    with mock.patch.object(M.sys, "platform", "darwin"), mock.patch.object(ctypes, "CDLL", side_effect=load):
        api = M.DarwinProcessApi()
    assert len(calls["load"]) == 1
    assert lib.proc_listpids.argtypes == [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    assert lib.proc_listpids.restype is ctypes.c_int
    assert lib.proc_pidinfo.argtypes == [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    assert lib.proc_pidinfo.restype is ctypes.c_int
    return api, calls

def synthetic_api(pids=(100, 101, 102), changes=None, missing=None):
    class Api:
        def list_group_pids(self, group):
            assert group == 100
            return pids
        def short_bsd(self, pid):
            if pid == missing:
                raise M.InventoryError("simulated missing native detail")
            record = {"pid": pid, "ppid": 90 if pid == 100 else 100,
                      "pgid": 100, "uid": 502, "status": 3}
            record.update((changes or {}).get(pid, {}))
            return SimpleNamespace(**record)
    return Api()

def original_guard(payload):
    # Reuse only the unchanged original frame/role-validation AST. Its actual
    # process query/waits are not executed or represented by this pure test.
    source = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
    start_token = "    exec python3 -I -c " + chr(39) + "\\n"
    finish_token = "\\n" + chr(39) + ' "$owner_pid" "$owner_start_identity" "$failure_path" "$inventory_path" node '
    begin = source.index(start_token, source.index("recovery_start_no_managed_bot_runner_watch() {"))
    end = source.index(finish_token, begin)
    tree = ast.parse(source[begin + len(start_token):end])
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "require_no_residual_members"]
    assert len(functions) == 1
    statements = functions[0].body
    starts = [index for index, node in enumerate(statements) if isinstance(node, ast.Assign) and
              len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "members"]
    ends = [index for index, node in enumerate(statements) if isinstance(node, ast.Expr) and
            isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and
            ast.unparse(node.value.func) == "observer.stdout.close"]
    assert len(starts) == 1 and len(ends) == 1 and ends[0] - starts[0] == 5
    guard = ast.Module(body=statements[starts[0]:ends[0]], type_ignores=[])
    for node in ast.walk(guard):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "os":
            assert node.attr == "getuid", "pure guard extraction may not gain another native API"
    class GuardRejected(M.InventoryError):
        pass
    def revoke():
        raise GuardRejected("original simulated role guard rejected the frame")
    values = {"lines": M.parse_group_frame(payload, 100), "group": 100,
              "owner_pid": 90, "secondary_pid": 101, "observer_pid": 102,
              "os": SimpleNamespace(getuid=lambda: 502), "revoke": revoke}
    exec(compile(ast.fix_missing_locations(guard), "<original-simulated-role-guard>", "exec"), values)
    return values["members"]
`;

const simulatedCases = [
  ["Darwin simulated ABI uses fixed16byte PGRP and SHORT13 arg1", `
assert ctypes.sizeof(M.ProcBsdShortInfo) == 64
assert {key: getattr(M.ProcBsdShortInfo, key).offset for key in
        ("pid", "ppid", "pgid", "status", "comm", "flags", "uid", "rfu")} == {
        "pid": 0, "ppid": 4, "pgid": 8, "status": 12, "comm": 16,
        "flags": 32, "uid": 36, "rfu": 60}
for count in range(4):
    pids = tuple(range(100, 100 + count))
    api, calls = api_fixture(pids=pids)
    ctypes.set_errno(errno.EACCES)
    assert api.list_group_pids(100) == pids
    assert calls["list"] == [(2, 100, 16)]
    for pid in pids:
        ctypes.set_errno(errno.ESRCH)
        info = api.short_bsd(pid)
        assert (info.pid, info.ppid, info.pgid, info.uid, info.status) == (pid, 100, 100, 502, 3)
    assert calls["short"] == [(pid, 13, 1, 64) for pid in pids]
`],
  ["Darwin simulated native list rejects errors, invalid counts, PIDs, duplicates and saturated4", `
for result, error in [(0, errno.EACCES), (0, errno.ESRCH), (-1, 0), (1, 0), (3, 0), (5, 0), (13, 0), (16, 0), (20, 0)]:
    api, calls = api_fixture(pids=(100, 101, 102, 103), list_result=result, list_errno=error)
    rejected(lambda: M.collect_group_inventory(100, api))
    assert calls["list"] == [(2, 100, 16)] and calls["short"] == []
for pids in [(0,), (-1,), (100, 100)]:
    api, calls = api_fixture(pids=pids)
    rejected(lambda: M.collect_group_inventory(100, api))
    assert len(calls["list"]) == 1
`],
  ["Darwin simulated short BSD rejects errno and incomplete ABI records", `
for result, error in [(-1, 0), (0, errno.ESRCH), (0, 0), (1, 0), (63, 0), (65, 0), (64, errno.EPERM)]:
    api, calls = api_fixture(pids=(100,), short_result=result, short_errno=error)
    rejected(lambda: M.collect_group_inventory(100, api))
    assert calls["list"] == [(2, 100, 16)] and calls["short"] == [(100, 13, 1, 64)]
`],
  ["Darwin simulated collector preserves foreign UID, zombie and stopped rows without filtering", `
api = synthetic_api(changes={101: {"uid": 0, "status": 5}, 102: {"uid": 600, "status": 4}})
rows = M.collect_group_inventory(100, api)
assert rows == ((100, 90, 100, 502, "S"), (101, 100, 100, 0, "Z"), (102, 100, 100, 600, "T"))
frame = M.render_group_frame(100, rows)
assert M.parse_group_frame(frame, 100) == tuple(" ".join(map(str, row)) for row in rows)
`],
  ["Darwin simulated collector rejects missing, changed and ambiguous membership", `
for api in [synthetic_api(missing=101), synthetic_api(pids=(100, 101, 102, 103)),
            synthetic_api(pids=(100, 100)), synthetic_api(pids=(0,)), synthetic_api(pids=(-1,)),
            synthetic_api(changes={101: {"pid": 103}}), synthetic_api(changes={101: {"pgid": 200}}),
            synthetic_api(changes={101: {"ppid": -1}}), synthetic_api(changes={101: {"uid": -1}}),
            synthetic_api(changes={101: {"status": 0}}), synthetic_api(changes={101: {"status": 6}})]:
    rejected(lambda: M.render_group_frame(100, M.collect_group_inventory(100, api)))
`],
  ["Darwin simulated frame requires canonical header, count, rows and complete trailer", `
rows = ((100, 90, 100, 502, "S"), (101, 100, 100, 502, "R"), (102, 100, 100, 502, "Z"))
for count in range(4):
    frame = M.render_group_frame(100, rows[:count])
    assert M.parse_group_frame(frame, 100) == tuple(" ".join(map(str, row)) for row in rows[:count])
valid = M.render_group_frame(100, rows)
for frame in [b"", valid[:-1], valid[:20], valid.replace(b"complete 100 3\\n", b""),
              valid.replace(b"complete 100 3", b"complete 100 2"), valid + b"extra\\n",
              valid.replace(b"yenhubs-process-group-v1", b"yenhubs-process-group-v2"),
              valid.replace(b"v1 100 3", b"v1 200 3"), valid.replace(b"v1 100 3", b"v1 100 03"),
              valid.replace(b"v1 100 3", b"v1 100 4"), valid.replace(b"100 90", b"0100 90"),
              valid.replace(b"101 100", b"100 100"), valid.replace(b"102 100 100", b"102 100 200"),
              valid.replace(b"502 Z", b"502 X"), valid.replace(b"502 Z", b"502 unknown"),
              valid.replace(b"502 Z", b"502 \\xff"), valid.replace(b"101 100", b"101  100")]:
    rejected(lambda: M.parse_group_frame(frame, 100))
rejected(lambda: M.parse_group_frame(valid.decode("ascii"), 100))
rejected(lambda: M.parse_group_frame(b"x" * (M.MAX_FRAME_BYTES + 1) + b"\\n", 100))
`],
  ["Darwin simulated original supervisor guard rejects foreign UID, stopped state and residual zombies", `
valid = ((100, 90, 100, 502, "S"), (101, 100, 100, 502, "S"), (102, 100, 100, 502, "Z"))
assert original_guard(M.render_group_frame(100, valid)) == {100: (90, 502, "S"), 101: (100, 502, "S"), 102: (100, 502, "Z")}
for index, field, value in [(0, 3, 0), (1, 3, 600), (2, 3, 0), (0, 4, "T"), (1, 4, "T"), (2, 4, "T"), (0, 4, "Z"), (1, 4, "Z")]:
    rows = [list(row) for row in valid]
    rows[index][field] = value
    rejected(lambda: original_guard(M.render_group_frame(100, tuple(tuple(row) for row in rows))))
`],
  ["Darwin simulated original supervisor guard requires exact parent, PGID and complete unique roles", `
valid = ((100, 90, 100, 502, "S"), (101, 100, 100, 502, "S"), (102, 100, 100, 502, "Z"))
for index, field, value in [(0, 1, 91), (1, 1, 90), (2, 1, 90), (2, 0, 103), (1, 0, 100), (2, 2, 200)]:
    rows = [list(row) for row in valid]
    rows[index][field] = value
    rejected(lambda: original_guard(M.render_group_frame(100, tuple(tuple(row) for row in rows))))
rejected(lambda: original_guard(M.render_group_frame(100, valid[:2])))
rejected(lambda: original_guard(M.render_group_frame(100, ())))
`]
];

function simulatedProgram(index) {
  return simulatedPreamble + simulatedCases[index][1] + '\nprint("SIMULATED inventory contract ok")\n';
}
for (let index = 0; index < simulatedCases.length; index++) {
  test(simulatedCases[index][0], { concurrency: false, timeout: 10_000 }, () => {
    const result = spawnSync("python3", ["-I", "-c", simulatedProgram(index), utility, library], {
      cwd: root, env: nativeShellEnvironment(), encoding: "utf8", timeout: 5000, maxBuffer: 1048576
    });
    assert.equal(result.status, 0, "SIMULATED contract assertion failed: " + result.stderr);
    assert.equal(result.signal, null); assert.equal(result.stdout, "SIMULATED inventory contract ok\n");
  });
}

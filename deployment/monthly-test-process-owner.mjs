/** Local monthly-test cleanup only; never a production process supervisor. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const MAX_OWNED = 512;
const identity = row => `${row.uid}:${row.pid}:${row.birth}`;
const REASONS = new Set(["ownership_contract", "root_unbound", "identity_unavailable", "identity_invalid",
  "platform_unsupported", "inventory_overflow", "inventory_invalid", "inventory_duplicate", "inventory_timeout",
  "signal_target_invalid", "native_probe_timeout", "native_error"]);
const failure = (reason = "ownership_contract") => {
  const error = new Error("monthly_test_process_ownership_unproven");
  error.reason = REASONS.has(reason) ? reason : "ownership_contract";
  return error;
};

// Reuse recovery-safety.sh's native birth identity, not ps lstart or comm.
// The helper is short-lived and returns process metadata only. No environment,
// command line, credentials, negative PID or historical PGID is inspected/used.
const PYTHON = String.raw`
import ctypes, json, os, pathlib, signal, subprocess, sys

request = json.loads(sys.argv[1])
MAX_OWNED = 512

class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid",
        "rgid", "svuid", "svgid", "rfu"
    )] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid")
    ] + [("nice", ctypes.c_int32), ("seconds", ctypes.c_uint64), ("microseconds", ctypes.c_uint64)]

libproc = None
if sys.platform == "darwin":
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int

def absent_or_fail(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    raise RuntimeError("identity_unavailable")

def native(pid):
    try:
        if sys.platform.startswith("linux"):
            entry = pathlib.Path(f"/proc/{pid}")
            text = (entry / "stat").read_text(encoding="ascii")
            closing = text.rfind(")")
            fields = text[closing + 2:].split()
            if closing < 0 or len(fields) < 20 or not fields[19].isdigit():
                raise RuntimeError("identity_invalid")
            boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
            return dict(pid=pid, ppid=int(fields[1]), pgid=int(fields[2]), uid=entry.stat().st_uid,
                        birth=f"linux:{boot}:{fields[19]}", zombie=fields[0] in ("Z", "X"))
        if libproc is not None:
            info = BsdInfo()
            ctypes.set_errno(0)
            size = libproc.proc_pidinfo(pid, 3, 1, ctypes.byref(info), ctypes.sizeof(info))
            if size != ctypes.sizeof(info):
                return absent_or_fail(pid)
            if info.pid != pid or info.seconds <= 0 or info.microseconds >= 1000000:
                raise RuntimeError("identity_invalid")
            return dict(pid=pid, ppid=info.ppid, pgid=info.pgid, uid=info.uid,
                        birth=f"darwin:{info.seconds}:{info.microseconds}", zombie=info.status == 5)
        raise RuntimeError("platform_unsupported")
    except (FileNotFoundError, ProcessLookupError):
        return None

def same(left, right):
    return left is not None and all(left[key] == right[key] for key in ("pid", "uid", "birth"))

def observe():
    known = request["known"]
    active, unresolved, absent = {}, {}, []
    if not known and not request["initialized"]:
        root = native(request["rootPid"])
        if root is None or root["uid"] != request["uid"] or root["ppid"] != request["ownerPid"]:
            raise RuntimeError("root_unbound")
        known = [root]
    for original in request["unresolved"]:
        row = native(original["pid"])
        if row is not None and row["birth"] == original["birth"]:
            unresolved[row["pid"]] = row
    for original in known:
        row = native(original["pid"])
        if same(row, original):
            active[row["pid"]] = row
        elif row is not None and row["birth"] == original["birth"]:
            unresolved[row["pid"]] = row  # UID drift never authorizes a signal.
        else:
            absent.append(original)
    result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,pgid=,uid="],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1, check=True)
    if len(result.stdout) > 2097152:
        raise RuntimeError("inventory_overflow")
    table = {}
    for line in result.stdout.decode("ascii").splitlines():
        fields = line.split()
        if len(fields) != 4 or not all(value.isdigit() for value in fields):
            raise RuntimeError("inventory_invalid")
        pid, ppid, pgid, uid = map(int, fields)
        if pid in table:
            raise RuntimeError("inventory_duplicate")
        table[pid] = (ppid, pgid, uid)
    lineage = set(active)
    while True:
        added = {pid for pid, row in table.items() if row[0] in lineage} - lineage
        if not added:
            break
        lineage.update(added)
        if len(lineage) > MAX_OWNED:
            raise RuntimeError("inventory_overflow")
    pending = lineage - set(active)
    while pending:
        progressed = False
        for pid in list(pending):
            parent_pid, _, uid = table[pid]
            if parent_pid not in active:
                continue
            row = native(pid)
            pending.remove(pid)
            progressed = True
            if row is None:
                continue
            parent = native(parent_pid)
            if (uid != request["uid"] or row["uid"] != request["uid"] or
                    row["ppid"] != parent_pid or not same(parent, active[parent_pid])):
                unresolved[pid] = row
                continue
            active[pid] = row
        if not progressed:
            # A surviving child behind a vanished/unverifiable intermediate
            # cannot be adopted from an old PPID or a process name.
            for pid in pending:
                row = native(pid)
                if row is not None:
                    unresolved[pid] = row
            break
    for pid in active:
        unresolved.pop(pid, None)
    if len(active) + len(unresolved) > MAX_OWNED:
        raise RuntimeError("inventory_overflow")
    return dict(members=list(active.values()), unresolved=list(unresolved.values()), absent=absent)

def send():
    outcomes = []
    selected = {"SIGTERM": signal.SIGTERM, "SIGKILL": signal.SIGKILL}[request["signal"]]
    for original in request["members"]:
        pid, descriptor = original["pid"], None
        if pid <= 1 or pid in (os.getpid(), request["ownerPid"]) or original["uid"] != os.getuid():
            raise RuntimeError("signal_target_invalid")
        try:
            # Linux binds the exact process before the final identity check.
            if sys.platform.startswith("linux"):
                descriptor = os.pidfd_open(pid, 0)
            row = native(pid)
            if not same(row, original) or row["pgid"] != original["pgid"]:
                outcomes.append("changed_or_absent")
                continue
            if row["zombie"]:
                outcomes.append("zombie")
                continue
            if descriptor is not None:
                signal.pidfd_send_signal(descriptor, selected, None, 0)
            else:
                # Darwin has no pidfd: recheck native birth and PGID directly
                # before a positive-PID signal; never signal a group by number.
                os.kill(pid, selected)
            outcomes.append("sent")
        except ProcessLookupError:
            outcomes.append("changed_or_absent")
        finally:
            if descriptor is not None:
                os.close(descriptor)
    return dict(outcomes=outcomes)

try:
    if len(request.get("known", request.get("members", []))) > MAX_OWNED:
        raise RuntimeError("inventory_overflow")
    value = observe() if request["action"] == "observe" else send()
    print(json.dumps(value, separators=(",", ":")))
except Exception as error:
    allowed = {"root_unbound", "identity_unavailable", "identity_invalid", "platform_unsupported",
               "inventory_overflow", "inventory_invalid", "inventory_duplicate", "signal_target_invalid"}
    reason = str(error) if str(error) in allowed else "inventory_timeout" if isinstance(error, subprocess.TimeoutExpired) else "native_error"
    print(json.dumps({"failureReason": reason}, separators=(",", ":")))
    raise SystemExit(1)
`;

async function invokeNative(request, timeoutMilliseconds) {
  try {
    const { stdout } = await execute("python3", ["-I", "-c", PYTHON, JSON.stringify(request)], {
      encoding: "utf8", timeout: timeoutMilliseconds, maxBuffer: 256 * 1024,
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", LANG: "C" }
    });
    return JSON.parse(stdout);
  } catch (error) {
    let reason = error?.killed ? "native_probe_timeout" : "native_error";
    // Only a bounded enum may escape. Never copy error text, command/argv,
    // stderr, request metadata or a private value into a receipt.
    if (typeof error?.stdout === "string" && error.stdout.length <= 256) {
      try {
        const value = JSON.parse(error.stdout);
        if (REASONS.has(value?.failureReason)) reason = value.failureReason;
      } catch { /* Keep the closed native_error category. */ }
    }
    throw failure(reason);
  }
}

function validRow(row, uid = null) {
  return row && [row.pid, row.pgid].every(value => Number.isSafeInteger(value) && value > 1) &&
    Number.isSafeInteger(row.ppid) && row.ppid >= 0 && Number.isSafeInteger(row.uid) && row.uid >= 0 &&
    (uid === null || row.uid === uid) &&
    typeof row.zombie === "boolean" &&
    /^(?:darwin:[0-9]{1,12}:[0-9]{1,6}|linux:[a-f0-9-]{36}:[0-9]{1,20})$/.test(row.birth ?? "");
}

/** Call immediately after spawn, await ready, and ALWAYS await retire before
 * accepting close (including native exit 0). close never cancels retirement.
 * Coverage is observed lineage, not OS isolation: an entirely unobserved
 * double-fork between polls cannot safely be attributed. Observation errors,
 * missing initial identity and surviving originals fail closed.
 * `native` is a unit-test seam; production callers must use the default.
 */
export function createMonthlyTestProcessOwner(child, {
  pollMilliseconds = 100, probeTimeoutMilliseconds = 2000,
  parentGraceMilliseconds = 5000, descendantGraceMilliseconds = 1000,
  killGraceMilliseconds = 2000, native = invokeNative
} = {}) {
  const uid = process.getuid(), rootPid = child?.pid, ownerPid = process.pid;
  const durations = [pollMilliseconds, probeTimeoutMilliseconds, parentGraceMilliseconds,
    descendantGraceMilliseconds, killGraceMilliseconds];
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1 || rootPid === ownerPid ||
      durations.some(value => !Number.isSafeInteger(value) || value < 10 || value > 10000)) throw failure();
  const known = new Map();
  let active = [], unresolved = [], timer, pending, retiring, stopped = false, unproven = false, initialized = false;
  let registered = 0;
  let termSent = 0, killSent = 0;
  let firstFailure = null;
  const recordFailure = (error, phase) => {
    unproven = true;
    firstFailure ??= { phase, reason: REASONS.has(error?.reason) ? error.reason : "ownership_contract" };
  };
  const request = extra => ({ ownerPid, rootPid, uid, ...extra });
  const observe = () => {
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await native(request({ action: "observe", known: [...known.values()], unresolved, initialized }), probeTimeoutMilliseconds);
        if (![result?.members, result?.absent, result?.unresolved].every(Array.isArray) ||
            result.members.length + result.unresolved.length > MAX_OWNED || result.absent.length > MAX_OWNED) throw failure();
        const nextKnown = new Map(known);
        for (const row of result.absent) {
          const original = nextKnown.get(row?.pid);
          if (!original || identity(original) !== identity(row)) throw failure();
          nextKnown.delete(row.pid);
        }
        const next = [], seen = new Set();
        for (const row of result.members) {
          if (!validRow(row, uid) || row.pid === ownerPid || seen.has(row.pid)) throw failure();
          seen.add(row.pid);
          const original = nextKnown.get(row.pid);
          if (original && identity(original) !== identity(row)) throw failure();
          const bound = { pid: row.pid, ppid: row.ppid, pgid: row.pgid, uid: row.uid, birth: row.birth, zombie: row.zombie };
          next.push(bound);
        }
        if (!initialized && !next.some(row => row.pid === rootPid && row.ppid === ownerPid)) throw failure();
        const nextUnresolved = result.unresolved.map(row => {
          if (!validRow(row) || row.pid === ownerPid || seen.has(row.pid)) throw failure();
          seen.add(row.pid);
          return { pid: row.pid, ppid: row.ppid, pgid: row.pgid, uid: row.uid, birth: row.birth, zombie: row.zombie };
        });
        let newlyRegistered = 0;
        for (const row of next) { if (!nextKnown.has(row.pid)) newlyRegistered++; nextKnown.set(row.pid, row); }
        if (nextKnown.size + nextUnresolved.length > MAX_OWNED) throw failure();
        known.clear(); for (const [pid, row] of nextKnown) known.set(pid, row);
        registered += newlyRegistered;
        initialized = true; active = next; unresolved = nextUnresolved;
        return { members: active.map(row => ({ ...row })), registered, tracking: known.size,
          unattributed: unresolved.map(row => ({ ...row })), unproven: unproven || unresolved.length > 0 };
      } catch (error) { recordFailure(error, "observe"); throw failure(firstFailure.reason); }
      finally { pending = undefined; }
    })();
    return pending;
  };
  const poll = () => {
    if (stopped) return;
    timer = setTimeout(async () => { try { await observe(); } catch {} poll(); }, pollMilliseconds);
    timer.unref();
  };
  // A proof requested after native close must not reuse a poll whose kernel
  // inventory started before that boundary. Join it, then start a new probe.
  // Any earlier observation error remains latched; freshness never forgives it.
  const observeFresh = async () => {
    if (pending) await pending;
    return observe();
  };
  const ready = observe();
  ready.then(poll, () => {});
  const send = async (members, signal) => {
    if (!members.length) return;
    try {
      const result = await native(request({ action: "signal", members, signal }), probeTimeoutMilliseconds);
      if (!Array.isArray(result?.outcomes) || result.outcomes.length !== members.length ||
          result.outcomes.some(value => !["sent", "changed_or_absent", "zombie"].includes(value))) throw failure();
      const count = result.outcomes.filter(value => value === "sent").length;
      if (signal === "SIGTERM") termSent += count; else killSent += count;
    } catch (error) { recordFailure(error, "signal"); }
  };
  const sweep = async () => { try { await observe(); } catch {} };
  const settle = async milliseconds => {
    const deadline = performance.now() + milliseconds;
    do {
      await sweep();
      if (!known.size && !active.length && !unresolved.length) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await delay(Math.min(pollMilliseconds, remaining));
    } while (performance.now() < deadline);
  };
  const close = () => { stopped = true; clearTimeout(timer); };
  const retire = () => {
    if (retiring) return retiring;
    close();
    retiring = (async () => {
      try { await ready; } catch {}
      if (!initialized) return { schema: "yenhubs-monthly-test-process-retirement-v1", coverage: "observed-lineage",
        absenceVerified: false, observationUnproven: true, registered, firstFailure,
        termSent, killSent, remaining: active.map(row => ({ ...row })), unattributed: unresolved.map(row => ({ ...row })) };
      await sweep();
      const parent = active.filter(row => row.pid === rootPid);
      if (parent.length) { await send(parent, "SIGTERM"); await settle(parentGraceMilliseconds); }
      if (active.length || unresolved.length) { await send(active, "SIGTERM"); await settle(descendantGraceMilliseconds); }
      if (active.length || unresolved.length) { await send(active, "SIGKILL"); await settle(killGraceMilliseconds); }
      // A second complete empty inventory is required even after parent close.
      await delay(pollMilliseconds); await sweep();
      const firstEmpty = known.size === 0 && active.length === 0 && unresolved.length === 0;
      if (firstEmpty) { await delay(pollMilliseconds); await sweep(); }
      return { schema: "yenhubs-monthly-test-process-retirement-v1", coverage: "observed-lineage",
        absenceVerified: initialized && !unproven && firstEmpty && known.size === 0 && active.length === 0 && unresolved.length === 0,
        observationUnproven: unproven || unresolved.length > 0, registered, termSent, killSent, firstFailure,
        remaining: active.map(row => ({ ...row })), unattributed: unresolved.map(row => ({ ...row })) };
    })();
    return retiring;
  };
  return { ready, observe, observeFresh, retire, close };
}

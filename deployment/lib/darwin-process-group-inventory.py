#!/usr/bin/env python3
"""Complete, purpose-specific Darwin inventory for aggregate watch closure.

The two callers accept only three members before retirement and none after
join. A fixed buffer of four pid_t values is therefore intentional: saturation
is an indeterminate failure, not a generic process inventory or a truncation
that may be accepted. There is no sizing query, retry, UID filter or grace.
Importing this module loads no native library and performs no process query.
"""

import ctypes
import sys


PROC_PGRP_ONLY = 2
PROC_PIDT_SHORTBSDINFO = 13
PID_CAPACITY = 4
MAX_FRAME_BYTES = 1048576
MAX_PID = 2147483647
MAX_UID = 4294967295
FRAME_VERSION = "yenhubs-process-group-v1"
NATIVE_STATES = {1: "I", 2: "R", 3: "S", 4: "T", 5: "Z"}


class InventoryError(RuntimeError):
    """The original group could not be observed completely and unambiguously."""


class ProcBsdShortInfo(ctypes.Structure):
    # Apple's proc_bsdshortinfo: exactly 64 bytes in the supported SDK ABI.
    _fields_ = [
        ("pid", ctypes.c_uint32),
        ("ppid", ctypes.c_uint32),
        ("pgid", ctypes.c_uint32),
        ("status", ctypes.c_uint32),
        ("comm", ctypes.c_char * 16),
        ("flags", ctypes.c_uint32),
        ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32),
        ("ruid", ctypes.c_uint32),
        ("rgid", ctypes.c_uint32),
        ("svuid", ctypes.c_uint32),
        ("svgid", ctypes.c_uint32),
        ("rfu", ctypes.c_uint32),
    ]


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise InventoryError("process_inventory_integer")
    return value


def _group(group):
    return _integer(group, 1, MAX_PID)


def _decimal(value, minimum, maximum):
    if (not isinstance(value, str) or not 1 <= len(value) <= 10 or
            not value.isascii() or not value.isdigit()):
        raise InventoryError("process_inventory_integer")
    number = _integer(int(value), minimum, maximum)
    if str(number) != value:
        raise InventoryError("process_inventory_integer")
    return number


class DarwinProcessApi:
    """Only the two native calls needed by the closure-specific collector."""

    def __init__(self):
        if (sys.platform != "darwin" or ctypes.sizeof(ctypes.c_int32) != 4 or
                ctypes.sizeof(ProcBsdShortInfo) != 64):
            raise InventoryError("process_inventory_abi")
        self.libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.libproc.proc_listpids.argtypes = [
            ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int
        ]
        self.libproc.proc_listpids.restype = ctypes.c_int
        self.libproc.proc_pidinfo.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p,
            ctypes.c_int
        ]
        self.libproc.proc_pidinfo.restype = ctypes.c_int

    def list_group_pids(self, group):
        _group(group)
        pids = (ctypes.c_int32 * PID_CAPACITY)()
        capacity = ctypes.sizeof(pids)
        # Kernel sizing is min(nprocs + 20, wantpids); wantpids=4 always
        # gives this buffer its exact capacity. allproc AND zombproc are
        # enumerated without a UID filter. Full capacity is not completeness.
        ctypes.set_errno(0)
        result = self.libproc.proc_listpids(
            PROC_PGRP_ONLY, group, ctypes.byref(pids), capacity
        )
        error = ctypes.get_errno()
        # libproc hides syscall -1 behind return 0. errno must distinguish
        # an actual empty group from a failed query, including EPERM/ESRCH.
        if (error != 0 or result < 0 or result >= capacity or
                result % ctypes.sizeof(ctypes.c_int32) != 0):
            raise InventoryError("process_inventory_list")
        return tuple(pids[index] for index in range(result // 4))

    def short_bsd(self, pid):
        _integer(pid, 1, MAX_PID)
        info = ProcBsdShortInfo()
        ctypes.set_errno(0)
        # arg=1 permits a zombie snapshot. The short form does not require
        # same UID, so foreign members remain visible rather than omitted.
        result = self.libproc.proc_pidinfo(
            pid, PROC_PIDT_SHORTBSDINFO, 1, ctypes.byref(info), ctypes.sizeof(info)
        )
        error = ctypes.get_errno()
        if error != 0 or result != ctypes.sizeof(info):
            raise InventoryError("process_inventory_shortinfo")
        return info


def _validated_rows(group, rows):
    _group(group)
    rows = tuple(rows)
    if len(rows) >= PID_CAPACITY:
        raise InventoryError("process_inventory_capacity")
    seen = set()
    for row in rows:
        if not isinstance(row, tuple) or len(row) != 5:
            raise InventoryError("process_inventory_row")
        pid, parent, pgid, uid, state = row
        _integer(pid, 1, MAX_PID)
        _integer(parent, 0, MAX_PID)
        _integer(pgid, 1, MAX_PID)
        _integer(uid, 0, MAX_UID)
        if pgid != group or pid in seen or state not in NATIVE_STATES.values():
            raise InventoryError("process_inventory_row")
        seen.add(pid)
    return rows


def collect_group_inventory(group, api):
    """Return every listed PID, including foreign UID and zombie members."""
    _group(group)
    pids = tuple(api.list_group_pids(group))
    if len(pids) >= PID_CAPACITY:
        raise InventoryError("process_inventory_capacity")
    rows = []
    seen = set()
    for pid in pids:
        _integer(pid, 1, MAX_PID)
        if pid in seen:
            raise InventoryError("process_inventory_duplicate")
        seen.add(pid)
        info = api.short_bsd(pid)
        _integer(info.status, 1, 5)
        if info.pid != pid or info.pgid != group:
            raise InventoryError("process_inventory_changed")
        rows.append((info.pid, info.ppid, info.pgid, info.uid, NATIVE_STATES[info.status]))
    return _validated_rows(group, rows)


def render_group_frame(group, rows):
    rows = _validated_rows(group, rows)
    count = len(rows)
    lines = [f"{FRAME_VERSION} {group} {count}"]
    lines.extend(" ".join(str(value) for value in row) for row in rows)
    lines.append(f"complete {group} {count}")
    frame = ("\n".join(lines) + "\n").encode("ascii")
    if len(frame) > MAX_FRAME_BYTES:
        raise InventoryError("process_inventory_size")
    return frame


def parse_group_frame(payload, group):
    """Validate the entire Darwin frame before returning existing row lines."""
    _group(group)
    if (not isinstance(payload, bytes) or len(payload) > MAX_FRAME_BYTES or
            not payload.endswith(b"\n")):
        raise InventoryError("process_inventory_frame")
    try:
        lines = payload.decode("ascii").split("\n")
    except UnicodeDecodeError as error:
        raise InventoryError("process_inventory_ascii") from error
    lines.pop()  # The required final newline is not a blank inventory row.
    if len(lines) < 2:
        raise InventoryError("process_inventory_frame")
    header = lines[0].split(" ")
    if len(header) != 3 or header[0] != FRAME_VERSION:
        raise InventoryError("process_inventory_header")
    count = _decimal(header[2], 0, PID_CAPACITY - 1)
    if (lines[0] != f"{FRAME_VERSION} {group} {count}" or
            lines[-1] != f"complete {group} {count}" or len(lines) != count + 2):
        raise InventoryError("process_inventory_count")
    rows = []
    for line in lines[1:-1]:
        fields = line.split(" ")
        if len(fields) != 5:
            raise InventoryError("process_inventory_row")
        values = (_decimal(fields[0], 1, MAX_PID), _decimal(fields[1], 0, MAX_PID),
                  _decimal(fields[2], 1, MAX_PID), _decimal(fields[3], 0, MAX_UID))
        rows.append(values + (fields[4],))
    _validated_rows(group, rows)
    return tuple(lines[1:-1])


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    try:
        if len(arguments) != 1:
            raise InventoryError("process_inventory_arguments")
        group = _decimal(arguments[0], 1, MAX_PID)
        rows = collect_group_inventory(group, DarwinProcessApi())
        frame = render_group_frame(group, rows)
        # Nothing is published until every listed PID has a complete native
        # detail. A partial/failed write cannot pass framing plus real wait0.
        if sys.stdout.buffer.write(frame) != len(frame):
            raise InventoryError("process_inventory_write")
        sys.stdout.buffer.flush()
        return 0
    except (OSError, ValueError, RuntimeError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

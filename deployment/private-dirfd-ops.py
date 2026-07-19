#!/usr/bin/env python3
"""Small value-silent dirfd helper for owner-private deployment artifacts."""

import ctypes
import errno
import hashlib
import hmac
import json
import os
import stat
import sys


MISSING = 44
MAX_REQUEST_BYTES = 1024 * 1024
RENAME_NOREPLACE = 1
RENAME_EXCL = 0x00000004
QUARANTINE_PREFIX = ".yenhubs-unlink-quarantine-v2-"
QUARANTINE_DOMAIN = b"yenhubs-unlink-owned-quarantine-v2\0"


def die(code=1):
    raise SystemExit(code)


def directory_ok(fd, expected):
    value = os.fstat(fd)
    expected_mode = int(expected.get("mode", str(0o700)))
    return (
        stat.S_ISDIR(value.st_mode)
        and not stat.S_ISLNK(value.st_mode)
        and value.st_dev == int(expected["dev"])
        and value.st_ino == int(expected["ino"])
        and value.st_uid == int(expected["uid"])
        and expected_mode & 0o022 == 0
        and stat.S_IMODE(value.st_mode) == expected_mode
    )


def stat_value(value):
    if stat.S_ISREG(value.st_mode):
        kind = "file"
    elif stat.S_ISDIR(value.st_mode):
        kind = "directory"
    elif stat.S_ISLNK(value.st_mode):
        kind = "symlink"
    else:
        kind = "other"
    return {
        "dev": str(value.st_dev),
        "ino": str(value.st_ino),
        "uid": str(value.st_uid),
        "mode": str(value.st_mode),
        "nlink": str(value.st_nlink),
        "size": str(value.st_size),
        "mtimeNs": str(value.st_mtime_ns),
        "ctimeNs": str(value.st_ctime_ns),
        "kind": kind,
    }


def same(left, right):
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_uid == right.st_uid
        and left.st_mode == right.st_mode
        and left.st_nlink == right.st_nlink
        and left.st_size == right.st_size
        and left.st_mtime_ns == right.st_mtime_ns
        and left.st_ctime_ns == right.st_ctime_ns
    )


def matches_expected(value, expected):
    return (
        value.st_dev == int(expected["dev"])
        and value.st_ino == int(expected["ino"])
        and value.st_uid == int(expected["uid"])
        and value.st_mode == int(expected["mode"])
        and value.st_nlink == int(expected["nlink"])
        and value.st_size == int(expected["size"])
        and value.st_mtime_ns == int(expected["mtimeNs"])
        and value.st_ctime_ns == int(expected["ctimeNs"])
    )


def private_file(value, maximum, links, allow_empty=False):
    return (
        stat.S_ISREG(value.st_mode)
        and value.st_uid == os.getuid()
        and stat.S_IMODE(value.st_mode) == 0o600
        and value.st_nlink in links
        and (allow_empty or value.st_size >= 1)
        and value.st_size >= 0
        and value.st_size <= maximum
    )


def leaf(value):
    return (
        isinstance(value, str)
        and value not in ("", ".", "..")
        and "/" not in value
        and "\x00" not in value
    )


def rename_noreplace(directory_fd, source, destination):
    """Atomically rename one leaf without ever replacing the destination."""
    library = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)
    if sys.platform == "darwin" and hasattr(library, "renameatx_np"):
        function = library.renameatx_np
        function.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        function.restype = ctypes.c_int
        result = function(
            directory_fd,
            source_bytes,
            directory_fd,
            destination_bytes,
            RENAME_EXCL,
        )
    elif hasattr(library, "renameat2"):
        function = library.renameat2
        function.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        function.restype = ctypes.c_int
        result = function(
            directory_fd,
            source_bytes,
            directory_fd,
            destination_bytes,
            RENAME_NOREPLACE,
        )
    else:
        die()
    if result == 0:
        return True
    error = ctypes.get_errno()
    if error in (errno.EEXIST, errno.ENOTEMPTY):
        return False
    if error == errno.ENOENT:
        raise FileNotFoundError(error, os.strerror(error), source)
    raise OSError(error, os.strerror(error), source)


def deterministic_quarantine_name(action, name, expected, exact_contract):
    fields = [
        action,
        name,
        expected["dev"],
        expected["ino"],
        str(exact_contract[0]) if exact_contract is not None else expected["size"],
        exact_contract[1] if exact_contract is not None else "",
    ]
    encoded = "\0".join(fields).encode("utf-8")
    attribution = hashlib.sha256(QUARANTINE_DOMAIN + encoded).hexdigest()
    return f"{QUARANTINE_PREFIX}{attribution}"


def matches_expected_after_rename(value, expected):
    return (
        value.st_dev == int(expected["dev"])
        and value.st_ino == int(expected["ino"])
        and value.st_uid == int(expected["uid"])
        and value.st_mode == int(expected["mode"])
        and value.st_nlink == int(expected["nlink"])
        and value.st_size == int(expected["size"])
        and value.st_mtime_ns == int(expected["mtimeNs"])
        and value.st_ctime_ns >= int(expected["ctimeNs"])
    )


def matches_unlink_identity(value, expected, exact_contract):
    if exact_contract is None:
        return matches_expected(value, expected)
    return (
        value.st_dev == int(expected["dev"])
        and value.st_ino == int(expected["ino"])
        and value.st_size == exact_contract[0]
    )


def stat_optional(directory_fd, name):
    try:
        return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def restore_quarantine_if_absent(directory_fd, quarantine, name):
    try:
        restored = rename_noreplace(directory_fd, quarantine, name)
    except FileNotFoundError:
        restored = False
    os.fsync(directory_fd)
    return restored


def exact_unlink_contract(args, expected, maximum):
    expected_length = args.get("expectedLength")
    expected_sha256 = args.get("expectedSha256")
    if expected_length is None and expected_sha256 is None:
        return None
    if (
        expected is None
        or isinstance(expected_length, bool)
        or not isinstance(expected_length, int)
        or expected_length < 0
        or expected_length > maximum
        or expected_length != int(expected["size"])
        or not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
        or any(character not in "0123456789abcdef" for character in expected_sha256)
    ):
        die()
    return expected_length, expected_sha256


def exact_quarantine_stat(directory_fd, quarantine, expected, exact_contract, maximum):
    value = stat_optional(directory_fd, quarantine)
    if (
        value is None
        or not private_file(value, maximum, (1,), True)
        or not (
            matches_unlink_identity(value, expected, exact_contract)
            if exact_contract is not None
            else matches_expected_after_rename(value, expected)
        )
    ):
        return None
    if exact_contract is None:
        return value
    expected_length, expected_sha256 = exact_contract
    try:
        content, content_stat = read_leaf_with_stat(
            directory_fd, quarantine, maximum, (1,), True
        )
    except (OSError, SystemExit):
        return None
    if (
        not same(value, content_stat)
        or len(content) != expected_length
        or not hmac.compare_digest(
            hashlib.sha256(content).hexdigest(), expected_sha256
        )
    ):
        return None
    return content_stat


def test_swap_before_quarantine(directory_fd, name, args, maximum):
    swap = args.get("testSwapBeforeQuarantine")
    if swap is None:
        return
    if not isinstance(swap, dict) or set(swap) != {"foreign", "displaced"}:
        die()
    foreign = swap["foreign"]
    displaced = swap["displaced"]
    if (
        not leaf(foreign)
        or not leaf(displaced)
        or len({name, foreign, displaced}) != 3
    ):
        die()
    foreign_value = os.stat(foreign, dir_fd=directory_fd, follow_symlinks=False)
    if not private_file(foreign_value, maximum, (1,), True):
        die()
    moved_original = False
    try:
        if not rename_noreplace(directory_fd, name, displaced):
            die()
        moved_original = True
        if not rename_noreplace(directory_fd, foreign, name):
            die()
        os.fsync(directory_fd)
    except BaseException:
        if moved_original:
            try:
                restore_quarantine_if_absent(directory_fd, displaced, name)
            except OSError:
                pass
        raise


def test_swap_quarantine_before_unlink(
    directory_fd, quarantine, args, maximum
):
    swap = args.get("testSwapQuarantineBeforeUnlink")
    if swap is None:
        return
    if not isinstance(swap, dict) or set(swap) != {"foreign", "displaced"}:
        die()
    foreign = swap["foreign"]
    displaced = swap["displaced"]
    if (
        not leaf(foreign)
        or not leaf(displaced)
        or len({quarantine, foreign, displaced}) != 3
    ):
        die()
    foreign_value = os.stat(foreign, dir_fd=directory_fd, follow_symlinks=False)
    if not private_file(foreign_value, maximum, (1,), True):
        die()
    moved_quarantine = False
    try:
        if not rename_noreplace(directory_fd, quarantine, displaced):
            die()
        moved_quarantine = True
        if not rename_noreplace(directory_fd, foreign, quarantine):
            die()
        os.fsync(directory_fd)
    except BaseException:
        if moved_quarantine:
            try:
                restore_quarantine_if_absent(
                    directory_fd, displaced, quarantine
                )
            except OSError:
                pass
        raise


def test_occupy_name_before_restore(directory_fd, name, args, maximum):
    occupant = args.get("testOccupyNameBeforeRestore")
    if occupant is None:
        return
    if not leaf(occupant) or occupant == name:
        die()
    value = os.stat(occupant, dir_fd=directory_fd, follow_symlinks=False)
    if not private_file(value, maximum, (1,), True):
        die()
    rename_noreplace(directory_fd, occupant, name)
    os.fsync(directory_fd)


def attributed_pending(name, attribution):
    marker = ".aud065-new-"
    prefix, separator, suffix = name.rpartition(marker)
    return (
        leaf(name)
        and isinstance(attribution, str)
        and separator == marker
        and prefix.startswith(".")
        and len(attribution) == 64
        and all(character in "0123456789abcdef" for character in attribution)
        and hmac.compare_digest(suffix, attribution)
    )


def exact_read(fd, size):
    chunks = []
    offset = 0
    while offset < size:
        chunk = os.pread(fd, min(1024 * 1024, size - offset), offset)
        if not chunk:
            die()
        chunks.append(chunk)
        offset += len(chunk)
    if os.pread(fd, 1, size):
        die()
    return b"".join(chunks)


def read_leaf_with_stat(fd, name, maximum, links, allow_empty=False):
    before = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not private_file(before, maximum, links, allow_empty):
        die()
    opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        first_stat = os.fstat(opened)
        if not same(before, first_stat):
            die()
        first = exact_read(opened, first_stat.st_size)
        middle = os.fstat(opened)
        second = exact_read(opened, first_stat.st_size)
        after = os.fstat(opened)
        leaf_stat = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if (
            not same(first_stat, middle)
            or not same(first_stat, after)
            or not same(first_stat, leaf_stat)
            or hashlib.sha256(first).digest() != hashlib.sha256(second).digest()
        ):
            die()
        return first, leaf_stat
    finally:
        os.close(opened)


def read_leaf(fd, name, maximum, links, allow_empty=False):
    content, _ = read_leaf_with_stat(fd, name, maximum, links, allow_empty)
    return content


def inspected_leaf(fd, name, maximum, links=(1,)):
    content, value = read_leaf_with_stat(fd, name, maximum, links)
    if value.st_size != len(content):
        die()
    result = stat_value(value)
    result["sha256"] = hashlib.sha256(content).hexdigest()
    return result


def path_still_names_directory(directory_path, expected):
    if (
        not isinstance(directory_path, str)
        or not os.path.isabs(directory_path)
        or "\x00" in directory_path
    ):
        return False
    try:
        value = os.stat(directory_path, follow_symlinks=False)
    except OSError:
        return False
    expected_mode = int(expected.get("mode", str(0o700)))
    return (
        stat.S_ISDIR(value.st_mode)
        and not stat.S_ISLNK(value.st_mode)
        and value.st_dev == int(expected["dev"])
        and value.st_ino == int(expected["ino"])
        and value.st_uid == int(expected["uid"])
        and expected_mode & 0o022 == 0
        and stat.S_IMODE(value.st_mode) == expected_mode
    )


def main():
    request_line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
    if (
        not request_line.endswith(b"\n")
        or len(request_line) > MAX_REQUEST_BYTES
        or len(request_line) <= 1
    ):
        die()
    request = json.loads(request_line[:-1].decode("utf-8"))
    if not directory_ok(3, request["target"]) or not directory_ok(
        4, request["staging"]
    ):
        die()
    action = request["action"]
    args = request.get("args", {})
    target_fd = 3
    staging_fd = 4
    selected = target_fd if args.get("directory", "target") == "target" else staging_fd
    name = args.get("name")
    if name is not None and not leaf(name):
        die()

    if action == "stat":
        try:
            value = os.stat(name, dir_fd=selected, follow_symlinks=False)
        except FileNotFoundError:
            die(MISSING)
        sys.stdout.write(json.dumps(stat_value(value), separators=(",", ":")))
    elif action == "list":
        sys.stdout.write(json.dumps(sorted(os.listdir(selected)), separators=(",", ":")))
    elif action == "create":
        descriptor = os.open(
            name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=selected,
        )
        try:
            os.fchmod(descriptor, 0o600)
            value = os.fstat(descriptor)
            if (
                not private_file(value, int(args["maximum"]), (1,), True)
                or value.st_size != 0
            ):
                die()
            os.fsync(selected)
            sys.stdout.write(json.dumps(stat_value(value), separators=(",", ":")))
        finally:
            os.close(descriptor)
    elif action == "write":
        content = sys.stdin.buffer.read(int(args["maximum"]) + 1)
        if len(content) != int(args["length"]) or len(content) > int(args["maximum"]):
            die()
        descriptor = os.open(name, os.O_RDWR | os.O_NOFOLLOW, dir_fd=selected)
        try:
            before = os.fstat(descriptor)
            expected = args["expected"]
            if (
                before.st_dev != int(expected["dev"])
                or before.st_ino != int(expected["ino"])
                or not private_file(before, int(args["maximum"]), (1,), True)
            ):
                die()
            os.ftruncate(descriptor, 0)
            offset = 0
            while offset < len(content):
                count = os.pwrite(
                    descriptor, content[offset : offset + 1024 * 1024], offset
                )
                if count <= 0:
                    die()
                offset += count
            os.fsync(descriptor)
            written = os.fstat(descriptor)
            current = os.stat(name, dir_fd=selected, follow_symlinks=False)
            if (
                written.st_dev != before.st_dev
                or written.st_ino != before.st_ino
                or not private_file(written, int(args["maximum"]), (1,))
                or written.st_size != len(content)
                or not same(written, current)
                or exact_read(descriptor, len(content)) != content
            ):
                die()
            sys.stdout.write(json.dumps(stat_value(written), separators=(",", ":")))
        finally:
            os.close(descriptor)
    elif action == "read":
        links = tuple(int(value) for value in args["links"])
        content = read_leaf(
            selected,
            name,
            int(args["maximum"]),
            links,
            bool(args.get("allowEmpty", False)),
        )
        sys.stdout.buffer.write(content)
    elif action == "link":
        source = args["source"]
        destination = args["destination"]
        if not leaf(source) or not leaf(destination):
            die()
        maximum = int(args["maximum"])
        before = os.stat(source, dir_fd=staging_fd, follow_symlinks=False)
        if not matches_expected(before, args["expected"]) or not private_file(
            before, maximum, (1,)
        ):
            die()
        linked = False
        linked_destination = None
        try:
            os.link(
                source,
                destination,
                src_dir_fd=staging_fd,
                dst_dir_fd=target_fd,
                follow_symlinks=False,
            )
            linked = True
            linked_destination = os.stat(
                destination, dir_fd=target_fd, follow_symlinks=False
            )
            linked_source = os.stat(
                source, dir_fd=staging_fd, follow_symlinks=False
            )
            if (
                not private_file(linked_source, maximum, (2,))
                or not same(linked_source, linked_destination)
                or linked_source.st_dev != before.st_dev
                or linked_source.st_ino != before.st_ino
                or linked_source.st_uid != before.st_uid
                or linked_source.st_mode != before.st_mode
                or linked_source.st_size != before.st_size
                or linked_source.st_mtime_ns != before.st_mtime_ns
            ):
                die()
            os.fsync(target_fd)
        except BaseException:
            if linked and linked_destination is not None:
                try:
                    current = os.stat(
                        destination, dir_fd=target_fd, follow_symlinks=False
                    )
                    if (
                        current.st_dev == linked_destination.st_dev
                        and current.st_ino == linked_destination.st_ino
                    ):
                        os.unlink(destination, dir_fd=target_fd)
                        os.fsync(target_fd)
                except OSError:
                    pass
            raise
    elif action == "unlink":
        expected = args["expected"]
        value = os.stat(name, dir_fd=selected, follow_symlinks=False)
        if (
            value.st_dev != int(expected["dev"])
            or value.st_ino != int(expected["ino"])
            or value.st_nlink != int(args["links"])
            or not private_file(
                value,
                int(args["maximum"]),
                (int(args["links"]),),
                bool(args.get("allowEmpty", False)),
            )
        ):
            die()
        os.unlink(name, dir_fd=selected)
        os.fsync(selected)
    elif action == "inspect":
        try:
            result = inspected_leaf(selected, name, int(args["maximum"]))
        except FileNotFoundError:
            die(MISSING)
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
    elif action == "write-reconcile":
        if not attributed_pending(name, args.get("attribution")):
            die()
        maximum = int(args["maximum"])
        content = sys.stdin.buffer.read(maximum + 1)
        if len(content) != int(args["length"]) or len(content) > maximum:
            die()
        try:
            before = os.stat(name, dir_fd=selected, follow_symlinks=False)
            if not private_file(before, maximum, (1,), True):
                die()
            existing = read_leaf(selected, name, maximum, (1,), True)
            current = os.stat(name, dir_fd=selected, follow_symlinks=False)
            if not same(before, current) or content[: len(existing)] != existing:
                die()
            descriptor = os.open(name, os.O_RDWR | os.O_NOFOLLOW, dir_fd=selected)
            if not same(current, os.fstat(descriptor)):
                os.close(descriptor)
                die()
        except FileNotFoundError:
            descriptor = os.open(
                name,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=selected,
            )
            os.fchmod(descriptor, 0o600)
            before = os.fstat(descriptor)
            if (
                not private_file(before, maximum, (1,), True)
                or before.st_size != 0
            ):
                os.close(descriptor)
                die()
            os.fsync(selected)
        try:
            os.ftruncate(descriptor, 0)
            offset = 0
            while offset < len(content):
                count = os.pwrite(
                    descriptor, content[offset : offset + 1024 * 1024], offset
                )
                if count <= 0:
                    die()
                offset += count
            os.fsync(descriptor)
            written = os.fstat(descriptor)
            current = os.stat(name, dir_fd=selected, follow_symlinks=False)
            if (
                not private_file(written, maximum, (1,))
                or written.st_size != len(content)
                or not same(written, current)
                or exact_read(descriptor, len(content)) != content
            ):
                die()
            os.fsync(selected)
            result = stat_value(written)
            result["sha256"] = hashlib.sha256(content).hexdigest()
            sys.stdout.write(json.dumps(result, separators=(",", ":")))
        finally:
            os.close(descriptor)
    elif action == "cas-replace":
        destination = args["destination"]
        pending = args["pending"]
        if (
            not leaf(destination)
            or not attributed_pending(pending, args.get("attribution"))
        ):
            die()
        maximum = int(args["maximum"])
        directory_expected = request[
            "target" if args.get("directory", "target") == "target" else "staging"
        ]
        if not path_still_names_directory(args["parentPath"], directory_expected):
            die()
        destination_value = os.stat(
            destination, dir_fd=selected, follow_symlinks=False
        )
        pending_value = os.stat(pending, dir_fd=selected, follow_symlinks=False)
        if (
            not matches_expected(destination_value, args["destinationExpected"])
            or not matches_expected(pending_value, args["pendingExpected"])
            or not private_file(destination_value, maximum, (1,))
            or not private_file(pending_value, maximum, (1,))
        ):
            die()
        destination_content = read_leaf(selected, destination, maximum, (1,))
        pending_content = read_leaf(selected, pending, maximum, (1,))
        if (
            len(destination_content) != int(args["destinationLength"])
            or hashlib.sha256(destination_content).hexdigest()
            != args["destinationSha256"]
            or len(pending_content) != int(args["pendingLength"])
            or hashlib.sha256(pending_content).hexdigest() != args["pendingSha256"]
            or not matches_expected(
                os.stat(destination, dir_fd=selected, follow_symlinks=False),
                args["destinationExpected"],
            )
            or not matches_expected(
                os.stat(pending, dir_fd=selected, follow_symlinks=False),
                args["pendingExpected"],
            )
            or not path_still_names_directory(args["parentPath"], directory_expected)
        ):
            die()
        os.rename(
            pending,
            destination,
            src_dir_fd=selected,
            dst_dir_fd=selected,
        )
        os.fsync(selected)
        result = inspected_leaf(selected, destination, maximum)
        if (
            int(result["size"]) != int(args["pendingLength"])
            or result["sha256"] != args["pendingSha256"]
        ):
            die()
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
    elif action == "unlink-owned":
        maximum = int(args["maximum"])
        expected = args.get("expected")
        if expected is None:
            die()
        exact_contract = exact_unlink_contract(args, expected, maximum)
        if args.get("testSwapBeforeQuarantine") is not None and exact_contract is None:
            die()
        if args.get("testCutAfterQuarantine") not in (None, True):
            die()
        if exact_contract is None:
            # Legacy cleanup callers already bind the full pending-file stat but
            # cannot rediscover a quarantine inode after a cut. Keep their
            # historical cooperative stat/unlink behavior instead of stranding
            # secret pending bytes under an unreconciled pathname.
            source = stat_optional(selected, name)
            if source is None:
                die(MISSING)
            if (
                not private_file(source, maximum, (1,), True)
                or not matches_expected(source, expected)
            ):
                die()
            os.unlink(name, dir_fd=selected)
            os.fsync(selected)
            return
        quarantine = deterministic_quarantine_name(
            action, name, expected, exact_contract
        )
        source = stat_optional(selected, name)
        quarantined = stat_optional(selected, quarantine)

        # A missing source and quarantine is the idempotent state after an ACK
        # was lost following the durable unlink.
        if source is None and quarantined is None:
            return

        if quarantined is not None:
            exact_quarantine = exact_quarantine_stat(
                selected, quarantine, expected, exact_contract, maximum
            )
            if exact_quarantine is None:
                test_occupy_name_before_restore(selected, name, args, maximum)
                restore_quarantine_if_absent(selected, quarantine, name)
                die()
        else:
            if (
                source is None
                or not private_file(source, maximum, (1,), True)
                or not matches_unlink_identity(source, expected, exact_contract)
            ):
                die()
            test_swap_before_quarantine(selected, name, args, maximum)
            if not rename_noreplace(selected, name, quarantine):
                die()
            os.fsync(selected)
            if args.get("testCutAfterQuarantine") is True:
                os.kill(os.getpid(), 9)
            exact_quarantine = exact_quarantine_stat(
                selected, quarantine, expected, exact_contract, maximum
            )
            if exact_quarantine is None:
                test_occupy_name_before_restore(selected, name, args, maximum)
                restore_quarantine_if_absent(selected, quarantine, name)
                die()

        test_swap_quarantine_before_unlink(
            selected, quarantine, args, maximum
        )
        final_quarantine = exact_quarantine_stat(
            selected, quarantine, expected, exact_contract, maximum
        )
        if final_quarantine is None:
            test_occupy_name_before_restore(selected, name, args, maximum)
            restore_quarantine_if_absent(selected, quarantine, name)
            die()
        # POSIX has no portable unlink-by-inode. The attributed name is private,
        # deterministic and revalidated immediately before unlink; a hostile
        # same-UID process racing after this final check is outside this helper's
        # cooperative-concurrency boundary.
        os.unlink(quarantine, dir_fd=selected)
        os.fsync(selected)
        if stat_optional(selected, name) is not None:
            # The exact owned inode is gone, but a concurrent canonical leaf is
            # intentionally preserved and reported as a conflict.
            die()
    else:
        die()


try:
    main()
except SystemExit:
    raise
except Exception:
    die()

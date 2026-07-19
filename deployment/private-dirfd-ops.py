#!/usr/bin/env python3
"""Small value-silent dirfd helper for owner-private deployment artifacts."""

import hashlib
import hmac
import json
import os
import stat
import sys


MISSING = 44
MAX_REQUEST_BYTES = 1024 * 1024


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
        try:
            value = os.stat(name, dir_fd=selected, follow_symlinks=False)
        except FileNotFoundError:
            die(MISSING)
        expected = args.get("expected")
        if (
            not private_file(value, maximum, (1,), True)
            or (expected is not None and not matches_expected(value, expected))
        ):
            die()
        os.unlink(name, dir_fd=selected)
        os.fsync(selected)
    else:
        die()


try:
    main()
except SystemExit:
    raise
except Exception:
    die()

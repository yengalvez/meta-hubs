"""Local-only causal capability publisher for sustained supervisor tests."""
import os
from pathlib import Path
import sys
import time

directory, stop, started, freeze, interval = sys.argv[1:]
directory = Path(directory)
stop, started = Path(stop), Path(started)
deadline = time.monotonic() + 90
while not (directory / "ready").exists():
    if stop.exists() or time.monotonic() >= deadline:
        sys.exit(1)
    time.sleep(0.01)
digest = (directory / "ready").read_text().strip().split(":")[-1]
counter = 0
started_at = None
while not stop.exists() and time.monotonic() < deadline:
    now = time.monotonic()
    if started.exists() and started_at is None:
        started_at = now
    if freeze == "yes" and started_at is not None and now - started_at > 2:
        if not (directory / "frozen").exists():
            (directory / "frozen").write_text(
                str(time.clock_gettime_ns(time.CLOCK_MONOTONIC) // 1000000)
            )
        time.sleep(0.01)
        continue
    counter += 1
    temporary = directory / "progress.next"
    temporary.write_text(f"{digest}:{counter}\n")
    temporary.chmod(0o600)
    os.replace(temporary, directory / "progress")
    until = now + float(interval)
    while not stop.exists() and time.monotonic() < until:
        time.sleep(0.01)

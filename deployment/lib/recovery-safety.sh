#!/usr/bin/env bash

# Shared fail-closed guards for backup and restore commands. Callers must set
# NAMESPACE before invoking recovery_require_cluster_identity.

RECOVERY_SAFETY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# These paths are process-local capabilities. Never honor inherited values:
# cleanup may remove only a directory created and marked by this shell.
RECOVERY_MATERIALIZED_DIR=""
RECOVERY_MATERIALIZED_PARENT=""
RECOVERY_MATERIALIZED_MARKER=""
RECOVERY_MATERIALIZED_PRIVATE_TOKEN=""
RECOVERY_MATERIALIZED_OWNED=0
RECOVERY_MATERIALIZED_CLEANUP_ATTEMPTED=0
RECOVERY_MATERIALIZED_RETIRED=0
RECOVERY_MATERIALIZED_ALLOWED_PATHS=()
RECOVERY_DUMP_COPY=""
RECOVERY_STORAGE_COPY=""
RECOVERY_DATABASE_CONTRACT_COPY=""
RECOVERY_DEPLOYMENT_INVENTORY_COPY=""
RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY=""
RECOVERY_CHECKPOINT_METADATA_COPY=""
RECOVERY_CHECKPOINT_STAMP=""
RECOVERY_DUMP_SHA256=""
RECOVERY_STORAGE_SHA256=""
RECOVERY_DEPLOYMENT_INVENTORY_SHA256=""
RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256=""
RECOVERY_CHECKPOINT_NAMESPACE_UID=""
RECOVERY_CHECKPOINT_PVC_UID=""
RECOVERY_CHECKPOINT_METADATA_SCHEMA=""
RECOVERY_CHECKPOINT_RUNNER_GENERATION=""
RECOVERY_RUNNER_RUNTIME_GENERATION=""
RECOVERY_CHECKPOINT_OPERATION_ID=""
RECOVERY_FREEZE_ID=""
RECOVERY_FREEZE_CLIENT_INSTANCE_ID=""
RECOVERY_FREEZE_SOURCE_CLUSTER_UID=""
RECOVERY_FREEZE_MANIFEST_SHA256=""
RECOVERY_TARGET_CLUSTER_UID=""
RECOVERY_FENCE_PRE_EPOCH="${RECOVERY_FENCE_PRE_EPOCH:-}"
RECOVERY_FENCE_TARGET_EPOCH="${RECOVERY_FENCE_TARGET_EPOCH:-}"
RECOVERY_OPERATION_STATE="${RECOVERY_OPERATION_STATE:-}"
RECOVERY_OPERATION_BINDING_SHA256="${RECOVERY_OPERATION_BINDING_SHA256:-}"
# A caller may enable this process-local capability only after sourcing the
# library and after durably persisting the AUD-065 token/operation ID. Never
# honor an inherited environment marker.
RECOVERY_OPERATION_IDENTITY_PREBOUND=0
RECOVERY_OPERATION_LOCK_GLOBAL_NAME="yenhubs-recovery-operation-lock"
RECOVERY_SERIALIZATION_LEASE_NAME="yenhubs-operation-serialization"
RECOVERY_OPERATION_FENCE_POLICY_NAME="recovery-operation-pod-fence.yenhubs.org"
RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME="freeze-checkpoint-pod-create-fence.yenhubs.org"
RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY=""
RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE=""
RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE=""
RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID=""
RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV=""
RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID=""
RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV=""
RECOVERY_FREEZE_CHECKPOINT_FENCE_INPUT_JSON=""
RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED=0
RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED=0
# Lease ownership and heartbeat paths/PIDs are process-local capabilities.
# Never honor inherited values: an environment value must not let cleanup
# signal a foreign PID or overwrite/remove an arbitrary path.
RECOVERY_SERIALIZATION_LEASE_HOLDER=""
RECOVERY_SERIALIZATION_LEASE_UID=""
RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
RECOVERY_SERIALIZATION_HEARTBEAT_PID=""
RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY=""
RECOVERY_SERIALIZATION_HEARTBEAT_STOP=""
RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE=""
RECOVERY_SERIALIZATION_PARENT_PID=""
RECOVERY_SERIALIZATION_PARENT_START_IDENTITY=""
RECOVERY_SERIALIZATION_ADOPTED=0
RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID=""
RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY=""
RECOVERY_NAMESPACE_UID=""
RECOVERY_PVC_UID=""
# Coordinated child processes receive the exact lock resourceVersion from the
# parent. Unlike materialized-file capabilities above, this value is not used
# for local cleanup and must survive sourcing in the child so the full lock
# identity can be revalidated against the API object.
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}"

recovery_kubectl() {
  command kubectl --context "$EXPECTED_KUBE_CONTEXT" --request-timeout=45s "$@"
}

# `kubectl get <resource> -o json` normalizes collection responses into a
# generic v1/List and can discard the collection resourceVersion. Recovery
# watches need the API server's typed List and its exact RV, so all guarded
# namespaced collection reads go through the raw, resource-specific endpoint.
recovery_namespaced_list_raw_path() {
  local resource="$1" namespace="$2" prefix=""
  [[ ${#namespace} -le 63 &&
     "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || return 2
  case "$resource" in
    pods | persistentvolumeclaims)
      prefix="/api/v1"
      ;;
    deployments | daemonsets | replicasets | statefulsets)
      prefix="/apis/apps/v1"
      ;;
    cronjobs | jobs)
      prefix="/apis/batch/v1"
      ;;
    horizontalpodautoscalers)
      prefix="/apis/autoscaling/v2"
      ;;
    *)
      return 2
      ;;
  esac
  printf '%s/namespaces/%s/%s\n' "$prefix" "$namespace" "$resource"
}

recovery_kubectl_get_namespaced_list() {
  local resource="$1" namespace="$2" raw_path
  raw_path="$(recovery_namespaced_list_raw_path "$resource" "$namespace")" || return
  recovery_kubectl get --raw "$raw_path"
}

recovery_process_start_identity() {
  local pid="$1" identity
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2
  command -v python3 >/dev/null 2>&1 || return 127
  identity="$(command python3 -I - "$pid" <<'PY'
import ctypes
import os
import pathlib
import sys


def linux_identity(pid):
    stat = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    closing = stat.rfind(")")
    if closing < 0:
        raise RuntimeError("invalid_proc_stat")
    # The suffix begins at field 3 (state); starttime is field 22.
    fields = stat[closing + 2 :].split()
    if len(fields) < 20 or not fields[19].isdigit():
        raise RuntimeError("invalid_proc_start")
    boot_id = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text(
        encoding="ascii"
    ).strip()
    if not boot_id:
        raise RuntimeError("missing_boot_id")
    return f"linux:{boot_id}:{fields[19]}"


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


def darwin_identity(pid):
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    libproc.proc_pidinfo.restype = ctypes.c_int
    info = ProcBsdInfo()
    result = libproc.proc_pidinfo(
        pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)
    )
    if result != ctypes.sizeof(info) or info.pbi_pid != pid:
        raise RuntimeError("proc_pidinfo_failed")
    if info.pbi_start_tvsec <= 0 or info.pbi_start_tvusec >= 1_000_000:
        raise RuntimeError("invalid_proc_start")
    return f"darwin:{info.pbi_start_tvsec}:{info.pbi_start_tvusec}"


try:
    requested_pid = int(sys.argv[1])
    if requested_pid <= 0:
        raise ValueError("pid")
    if sys.platform.startswith("linux"):
        identity = linux_identity(requested_pid)
    elif sys.platform == "darwin":
        identity = darwin_identity(requested_pid)
    else:
        raise RuntimeError("unsupported_platform")
    print(identity)
except (OSError, RuntimeError, ValueError):
    raise SystemExit(1)
PY
  )" || return 1
  [[ -n "$identity" ]] || return 1
  printf '%s\n' "$identity"
}

recovery_monotonic_milliseconds() {
  command -v python3 >/dev/null 2>&1 || return 127
  command python3 -I - <<'PY'
import ctypes
import sys


class Timespec(ctypes.Structure):
    _fields_ = [("seconds", ctypes.c_long), ("nanoseconds", ctypes.c_long)]


clock_id = 1 if sys.platform.startswith("linux") else 6 if sys.platform == "darwin" else -1
if clock_id < 0:
    raise SystemExit(1)
libc = ctypes.CDLL(None, use_errno=True)
libc.clock_gettime.argtypes = [ctypes.c_int, ctypes.POINTER(Timespec)]
libc.clock_gettime.restype = ctypes.c_int
value = Timespec()
if libc.clock_gettime(clock_id, ctypes.byref(value)) != 0:
    raise SystemExit(1)
print(value.seconds * 1000 + value.nanoseconds // 1_000_000)
PY
}

recovery_process_identity_is_live() {
  local pid="$1" expected_start="$2" current_start
  [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$expected_start" ]] || return 2
  kill -0 "$pid" 2>/dev/null || return 1
  current_start="$(recovery_process_start_identity "$pid")" || return 1
  [[ "$current_start" == "$expected_start" ]]
}

recovery_stop_process_group() {
  local leader_pid="$1" expected_start="${2:-}" group_created=0
  [[ "$leader_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  if [[ -n "$expected_start" ]]; then
    recovery_process_identity_is_live "$leader_pid" "$expected_start" || return 1
  fi
  if kill -TERM -- "-$leader_pid" 2>/dev/null; then
    group_created=1
  else
    # Cover the very small fork-to-setsid race: if the Python launcher has not
    # established its session yet, killing the leader prevents kubectl exec.
    kill -TERM "$leader_pid" 2>/dev/null || :
  fi
  for _ in {1..20}; do
    if [[ "$group_created" == 1 ]]; then
      kill -0 -- "-$leader_pid" 2>/dev/null || break
    else
      kill -0 "$leader_pid" 2>/dev/null || break
    fi
    sleep 0.1
  done
  if [[ "$group_created" == 1 ]]; then
    # Always issue the group KILL after the grace period. On macOS the shell's
    # kill -0 check can stop observing the PGID once its leader exits even
    # while an orphaned descendant that ignored TERM is still in that group.
    kill -KILL -- "-$leader_pid" 2>/dev/null || :
  elif [[ "$group_created" == 0 && -n "$expected_start" ]]; then
    if recovery_process_identity_is_live "$leader_pid" "$expected_start"; then
      kill -KILL "$leader_pid" 2>/dev/null || :
    fi
  elif [[ "$group_created" == 0 ]] && kill -0 "$leader_pid" 2>/dev/null; then
    kill -KILL "$leader_pid" 2>/dev/null || :
  fi
  wait "$leader_pid" 2>/dev/null || :
}

recovery_revoke_process_group_immediate() {
  local leader_pid="$1" expected_start="$2" group_created=0
  [[ "$leader_pid" =~ ^[1-9][0-9]*$ && -n "$expected_start" ]] || return 2
  recovery_process_identity_is_live "$leader_pid" "$expected_start" || return 1
  if kill -TERM -- "-$leader_pid" 2>/dev/null; then
    group_created=1
  else
    # Cover the launcher-to-setsid race without ever signalling a PID whose
    # high-resolution start identity no longer matches.
    kill -TERM "$leader_pid" 2>/dev/null || :
  fi
  # Guard loss revokes a destructive stream, so this path gets only a very
  # small cooperative grace period.  The ordinary watcher shutdown path above
  # retains its longer two-second grace period.
  for _ in {1..5}; do
    if [[ "$group_created" == 1 ]]; then
      kill -0 -- "-$leader_pid" 2>/dev/null || break
    else
      recovery_process_identity_is_live "$leader_pid" "$expected_start" || break
    fi
    sleep 0.05
  done
  if [[ "$group_created" == 1 ]]; then
    kill -KILL -- "-$leader_pid" 2>/dev/null || :
  elif recovery_process_identity_is_live "$leader_pid" "$expected_start"; then
    kill -KILL "$leader_pid" 2>/dev/null || :
  fi
  wait "$leader_pid" 2>/dev/null || :
}

recovery_revoke_owned_child_process_group_immediate() {
  local leader_pid="$1" group_created=0
  [[ "$leader_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  # This variant is intentionally valid only after the current Bash shell has
  # proved the PID is still one of its running jobs. That parent/child fact is
  # stronger than a transiently unavailable start-time probe and prevents PID
  # reuse while allowing fail-closed revocation of the isolated stream group.
  if kill -TERM -- "-$leader_pid" 2>/dev/null; then
    group_created=1
  else
    kill -TERM "$leader_pid" 2>/dev/null || :
  fi
  for _ in {1..5}; do
    if [[ "$group_created" == 1 ]]; then
      kill -0 -- "-$leader_pid" 2>/dev/null || break
    else
      kill -0 "$leader_pid" 2>/dev/null || break
    fi
    sleep 0.05
  done
  if [[ "$group_created" == 1 ]]; then
    kill -KILL -- "-$leader_pid" 2>/dev/null || :
  else
    kill -KILL "$leader_pid" 2>/dev/null || :
  fi
  wait "$leader_pid" 2>/dev/null || :
  recovery_stop_reaped_isolated_process_group "$leader_pid"
}

recovery_stop_reaped_isolated_process_group() {
  local group_id="$1"
  [[ "$group_id" =~ ^[1-9][0-9]*$ ]] || return 2
  # The isolated leader has already been waited/reaped. Never fall back to its
  # positive PID here because that PID could now belong to a different process;
  # only revoke descendants that still retain the watcher's original PGID.
  kill -TERM -- "-$group_id" 2>/dev/null || :
  for _ in {1..20}; do
    kill -0 -- "-$group_id" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- "-$group_id" 2>/dev/null || :
}

recovery_watcher_join_timeout_seconds() {
  local requested="${RECOVERY_TEST_WATCHER_JOIN_TIMEOUT_SECONDS:-}"
  if [[ -z "$requested" ]]; then
    printf '300\n'
    return 0
  fi
  recovery_require_local_fixture_attestation || return 1
  [[ "$requested" =~ ^([1-9]|[12][0-9]|30)$ ]] || return 2
  printf '%s\n' "$requested"
}

recovery_wait_isolated_process_bounded() {
  local target_pid="$1" target_identity="$2" stop_path="$3"
  local timeout_seconds watchdog_pid="" watchdog_start_identity=""
  local watchdog_marker=""
  local wait_status=0 wait_retry=0 attempt=0 expired=0
  [[ "$target_pid" =~ ^[1-9][0-9]*$ && -n "$target_identity" ]] || return 2
  recovery_runner_watch_marker_is_exact "$stop_path" || return 1
  [[ -s "$stop_path" ]] || return 1
  timeout_seconds="$(recovery_watcher_join_timeout_seconds)" || return 1
  # The identity is captured immediately after spawn and threaded through the
  # whole watcher capability. Never adopt a process that merely reused the
  # stored PID before this late join/cleanup boundary.
  if ! recovery_process_identity_is_live "$target_pid" "$target_identity"; then
    # The exact 0600 non-empty stop marker proves that the caller prevalidated
    # this identity and linearized the stop before entering. A fast child may
    # already have exited and been reaped by Bash; recover its cached status
    # once, but never wait or signal if the numeric PID is currently occupied.
    kill -0 "$target_pid" 2>/dev/null && return 1
    if wait "$target_pid" 2>/dev/null; then wait_status=0; else wait_status=$?; fi
    [[ "$wait_status" != 127 ]] || return 1
    kill -0 "$target_pid" 2>/dev/null && return 1
    if [[ "$wait_status" != 0 ]]; then
      recovery_stop_reaped_isolated_process_group "$target_pid"
      return 1
    fi
    return 0
  fi
  command -v python3 >/dev/null 2>&1 || {
    recovery_stop_process_group "$target_pid" "$target_identity"
    return 127
  }
  watchdog_marker="$(mktemp \
    "${TMPDIR:-/tmp}/yenhubs-watcher-deadline.XXXXXX")" || {
    recovery_stop_process_group "$target_pid" "$target_identity"
    return 1
  }
  chmod 600 "$watchdog_marker" || {
    rm -f -- "$watchdog_marker"
    recovery_stop_process_group "$target_pid" "$target_identity"
    return 1
  }
  command python3 -I -c '
import ctypes
import os
import pathlib
import signal
import sys
import time

target = int(sys.argv[1])
identity = sys.argv[2]
timeout = int(sys.argv[3])
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
os.write(9, b"ready\n")
os.fsync(9)
time.sleep(timeout)
os.write(9, b"expired\n")
os.fsync(9)

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32), ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32), ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32), ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


def current_identity():
    try:
        if sys.platform.startswith("linux"):
            stat = pathlib.Path(f"/proc/{target}/stat").read_text(encoding="ascii")
            closing = stat.rfind(")")
            fields = stat[closing + 2 :].split()
            boot_id = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text(
                encoding="ascii"
            ).strip()
            if closing < 0 or len(fields) < 20 or not fields[19].isdigit() or not boot_id:
                return ""
            return f"linux:{boot_id}:{fields[19]}"
        if sys.platform == "darwin":
            libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            libproc.proc_pidinfo.argtypes = [
                ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                ctypes.c_void_p, ctypes.c_int,
            ]
            libproc.proc_pidinfo.restype = ctypes.c_int
            info = ProcBsdInfo()
            result = libproc.proc_pidinfo(
                target, 3, 0, ctypes.byref(info), ctypes.sizeof(info)
            )
            if result != ctypes.sizeof(info) or info.pbi_pid != target:
                return ""
            if info.pbi_start_tvsec <= 0 or info.pbi_start_tvusec >= 1_000_000:
                return ""
            return f"darwin:{info.pbi_start_tvsec}:{info.pbi_start_tvusec}"
    except (OSError, ValueError):
        return ""
    return ""

if current_identity() == identity:
    try:
        os.killpg(target, signal.SIGTERM)
    except ProcessLookupError:
        pass
    time.sleep(2)
    if current_identity() == identity:
        try:
            os.killpg(target, signal.SIGKILL)
        except ProcessLookupError:
            pass
' "$target_pid" "$target_identity" "$timeout_seconds" 9>"$watchdog_marker" &
  watchdog_pid=$!
  if ! watchdog_start_identity="$(
    recovery_process_start_identity "$watchdog_pid"
  )"; then
    # Without the start identity the numeric PID is not a signal/wait
    # capability. Reap only an already-dead child whose number is absent; a
    # live watchdog is bounded and will find the target identity revoked below.
    if ! kill -0 "$watchdog_pid" 2>/dev/null; then
      wait "$watchdog_pid" 2>/dev/null || :
    fi
    rm -f -- "$watchdog_marker"
    recovery_stop_process_group "$target_pid" "$target_identity"
    return 1
  fi
  while [[ "$attempt" -lt 40 ]]; do
    if grep -qx ready "$watchdog_marker" 2>/dev/null; then break; fi
    if ! recovery_process_identity_is_live \
        "$watchdog_pid" "$watchdog_start_identity"; then
      # If the exact child exited, its cached status is safe to reap only while
      # no process currently owns that numeric PID.
      if ! kill -0 "$watchdog_pid" 2>/dev/null; then
        wait "$watchdog_pid" 2>/dev/null || :
      fi
      rm -f -- "$watchdog_marker"
      recovery_stop_process_group "$target_pid" "$target_identity"
      return 1
    fi
    sleep 0.05
    attempt=$((attempt + 1))
  done
  if ! grep -qx ready "$watchdog_marker" 2>/dev/null; then
    if recovery_process_identity_is_live \
        "$watchdog_pid" "$watchdog_start_identity"; then
      kill -KILL "$watchdog_pid" 2>/dev/null || :
    fi
    if recovery_process_identity_is_live \
        "$watchdog_pid" "$watchdog_start_identity"; then
      wait "$watchdog_pid" 2>/dev/null || :
    elif ! kill -0 "$watchdog_pid" 2>/dev/null; then
      wait "$watchdog_pid" 2>/dev/null || :
    fi
    rm -f -- "$watchdog_marker"
    recovery_stop_process_group "$target_pid" "$target_identity"
    return 1
  fi
  while :; do
    if wait "$target_pid"; then wait_status=0; else wait_status=$?; fi
    # Bash reports both an interrupted wait and a child exit status such as
    # 143 as values greater than 128. Retry only while the exact child is still
    # live; a second wait after that child was already reaped can block forever.
    if [[ "$wait_status" -gt 128 && "$wait_retry" == 0 ]] &&
       recovery_process_identity_is_live "$target_pid" "$target_identity"; then
      wait_retry=1
      continue
    fi
    break
  done
  grep -q '^expired$' "$watchdog_marker" 2>/dev/null && expired=1
  if recovery_process_identity_is_live \
      "$watchdog_pid" "$watchdog_start_identity"; then
    kill -KILL "$watchdog_pid" 2>/dev/null || :
  fi
  if recovery_process_identity_is_live \
      "$watchdog_pid" "$watchdog_start_identity"; then
    wait "$watchdog_pid" 2>/dev/null || :
  elif ! kill -0 "$watchdog_pid" 2>/dev/null; then
    wait "$watchdog_pid" 2>/dev/null || :
  fi
  rm -f -- "$watchdog_marker"
  if [[ "$expired" != 0 || "$wait_status" != 0 ]]; then
    # The leader may have exited non-zero while a kubectl descendant remains in
    # its isolated process group. Treat the whole session as the capability and
    # revoke it before reporting a failed join.
    recovery_stop_reaped_isolated_process_group "$target_pid"
    return 1
  fi
  return 0
}

recovery_kubectl_mutate() {
  local mutation_status=0
  recovery_require_operation_serialization || return 1
  if recovery_kubectl_stream_supervised 1 30 "$@"; then
    mutation_status=0
  else
    mutation_status=$?
  fi
  recovery_require_operation_serialization || return 1
  [[ "$mutation_status" == 0 ]] || return "$mutation_status"
}

recovery_freeze_checkpoint_fence_helper() {
  local deployment_dir
  deployment_dir="$(cd "$RECOVERY_SAFETY_DIR/.." && pwd -P)" || return 1
  printf '%s/freeze-checkpoint-admission-fence.mjs\n' "$deployment_dir"
}

recovery_freeze_checkpoint_fence_input_json() {
  local helper_image="$1"
  [[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ &&
     -n "${RECOVERY_NAMESPACE_UID:-}" &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     -n "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_UID:-}" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_HOLDER:-}" &&
     "$helper_image" =~ @sha256:[a-f0-9]{64}$ ]] || return 2
  jq -cnS --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_resource_version "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg helper_image "$helper_image" '{namespace:$namespace,
      namespace_uid:$namespace_uid,operation_id:$operation_id,lock_uid:$lock_uid,
      lock_resource_version:$lock_resource_version,lease_uid:$lease_uid,
      lease_holder:$lease_holder,helper_image:$helper_image}'
}

recovery_freeze_checkpoint_fence_build_pair() {
  local input_json="$1" helper
  helper="$(recovery_freeze_checkpoint_fence_helper)" || return 1
  recovery_require_regular_direct_file "$helper" || return 1
  printf '%s' "$input_json" | command node "$helper" build
}

recovery_freeze_checkpoint_fence_object_is_exact() {
  local kind="$1" object_json="$2" input_json="$3"
  local require_observed="${4:-false}" require_identity="${5:-true}" helper
  [[ "$kind" == policy || "$kind" == binding ]] || return 2
  [[ "$require_observed" == true || "$require_observed" == false ]] || return 2
  [[ "$require_identity" == true || "$require_identity" == false ]] || return 2
  helper="$(recovery_freeze_checkpoint_fence_helper)" || return 1
  jq -cn --argjson object "$object_json" --argjson input "$input_json" \
    --argjson identity "$require_identity" \
    --argjson observed "$require_observed" \
    '{object:$object,input:$input,require_identity:$identity,require_observed:$observed}' |
    command node "$helper" "validate-$kind" >/dev/null
}

recovery_freeze_checkpoint_fence_pair_absent() {
  local policy binding
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  policy="$(recovery_kubectl get validatingadmissionpolicy \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" --ignore-not-found -o json)" || return 1
  binding="$(recovery_kubectl get validatingadmissionpolicybinding \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" --ignore-not-found -o json)" || return 1
  [[ -z "$policy" && -z "$binding" ]]
}

recovery_freeze_checkpoint_fence_capability_json() {
  local input_json="$1" policy_json="$2" binding_json="$3"
  recovery_freeze_checkpoint_fence_object_is_exact \
    policy "$policy_json" "$input_json" true || return 1
  recovery_freeze_checkpoint_fence_object_is_exact \
    binding "$binding_json" "$input_json" false || return 1
  jq -cnS --argjson input "$input_json" \
    --arg policy_uid "$(jq -er '.metadata.uid' <<<"$policy_json")" \
    --arg policy_rv "$(jq -er '.metadata.resourceVersion' <<<"$policy_json")" \
    --arg binding_uid "$(jq -er '.metadata.uid' <<<"$binding_json")" \
    --arg binding_rv "$(jq -er '.metadata.resourceVersion' <<<"$binding_json")" \
    '{schema_version:1,input:$input,policy:{uid:$policy_uid,resource_version:$policy_rv},
      binding:{uid:$binding_uid,resource_version:$binding_rv}}'
}

recovery_require_freeze_checkpoint_fence() {
  local capability_json="$1" policy_json binding_json input_json current
  jq -e '(keys|sort)==["binding","input","policy","schema_version"] and
    .schema_version==1 and (.policy|keys|sort)==["resource_version","uid"] and
    (.binding|keys|sort)==["resource_version","uid"]' >/dev/null \
    <<<"$capability_json" || return 1
  input_json="$(jq -cS '.input' <<<"$capability_json")" || return 1
  [[ "$input_json" == "$(recovery_freeze_checkpoint_fence_input_json \
    "$(jq -er '.helper_image' <<<"$input_json")")" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  policy_json="$(recovery_kubectl get validatingadmissionpolicy \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" -o json)" || return 1
  binding_json="$(recovery_kubectl get validatingadmissionpolicybinding \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" -o json)" || return 1
  current="$(recovery_freeze_checkpoint_fence_capability_json \
    "$input_json" "$policy_json" "$binding_json")" || return 1
  [[ "$current" == "$capability_json" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock
}

recovery_freeze_checkpoint_fence_probe_document() {
  local input_json="$1" probe="$2"
  case "$probe" in
    generic)
      jq -cn --arg namespace "$NAMESPACE" '{apiVersion:"v1",kind:"Pod",metadata:{
        generateName:"freeze-fence-generic-probe-",namespace:$namespace},spec:{
        automountServiceAccountToken:false,restartPolicy:"Never",containers:[{
          name:"probe",image:"registry.k8s.io/pause:3.10"}]}}'
      ;;
    helper)
      jq -cn --arg namespace "$NAMESPACE" \
        --arg operation_id "$(jq -er '.operation_id' <<<"$input_json")" \
        --arg lock_uid "$(jq -er '.lock_uid' <<<"$input_json")" \
        --arg image "$(jq -er '.helper_image' <<<"$input_json")" '{
        apiVersion:"v1",kind:"Pod",metadata:{name:("ret-storage-backup-" +
          ($operation_id[0:12])),
          namespace:$namespace,labels:{"yenhubs.org/recovery-owner":"ret-storage-backup",
            "yenhubs.org/operation-id":$operation_id},annotations:{
            "yenhubs.org/operation-lock-uid":$lock_uid,
            "yenhubs.org/operation-id":$operation_id}},spec:{
          automountServiceAccountToken:false,enableServiceLinks:false,restartPolicy:"Never",
          terminationGracePeriodSeconds:1,
          activeDeadlineSeconds:3600,securityContext:{runAsNonRoot:true,runAsUser:1000,
            runAsGroup:1000,fsGroup:1000,fsGroupChangePolicy:"OnRootMismatch",
            seccompProfile:{type:"RuntimeDefault"}},containers:[{name:"helper",image:$image,
            command:["sh","-c","sleep 3600"],securityContext:{allowPrivilegeEscalation:false,
              readOnlyRootFilesystem:true,capabilities:{drop:["ALL"]}},volumeMounts:[{
              name:"storage",mountPath:"/storage",readOnly:true}]}],volumes:[{name:"storage",
            persistentVolumeClaim:{claimName:"ret-pvc",readOnly:true}}]}}'
      ;;
    *) return 2 ;;
  esac
}

recovery_probe_freeze_checkpoint_fence() {
  local capability_json="$1" input_json document diagnostic status=0
  RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE=preconditions
  input_json="$(jq -cS '.input' <<<"$capability_json")" || return 1
  recovery_require_freeze_checkpoint_fence "$capability_json" || return 1
  document="$(recovery_freeze_checkpoint_fence_probe_document \
    "$input_json" generic)" || return 1
  if diagnostic="$(printf '%s' "$document" | \
      recovery_kubectl create --dry-run=server -f - 2>&1)"; then status=0; else status=$?; fi
  if [[ "$status" == 0 ]]; then
    RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE=generic-allowed
    return 1
  fi
  if [[ "$diagnostic" != *"$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME"* ]]; then
    RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE=generic-unattributed
    return 1
  fi
  if [[ "$diagnostic" != *'freeze checkpoint Pod fence denies'* ]]; then
    RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE=generic-message-mismatch
    return 1
  fi
  document="$(recovery_freeze_checkpoint_fence_probe_document \
    "$input_json" helper)" || return 1
  if ! diagnostic="$(printf '%s' "$document" | \
      recovery_kubectl create --dry-run=server -f - 2>&1)"; then
    RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE="helper-denied"
    return 1
  fi
  if [[ "$diagnostic" == *"$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME"* ]]; then
    RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE="helper-attributed"
    return 1
  fi
  RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE=""
}

recovery_create_freeze_checkpoint_fence() {
  local helper_image="$1" input_json pair policy_doc binding_doc
  local policy_json="" binding_json="" dry_policy_json="" dry_binding_json=""
  local status=0 attempt=0
  RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE=preconditions
  [[ -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" ]] || return 2
  input_json="$(recovery_freeze_checkpoint_fence_input_json "$helper_image")" || return 1
  pair="$(recovery_freeze_checkpoint_fence_build_pair "$input_json")" || return 1
  policy_doc="$(jq -c '.policy' <<<"$pair")" || return 1
  binding_doc="$(jq -c '.binding' <<<"$pair")" || return 1
  recovery_freeze_checkpoint_fence_pair_absent || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE=dry-run-policy
  dry_policy_json="$(recovery_kubectl create --dry-run=server -f - -o json \
    <<<"$policy_doc")" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_freeze_checkpoint_fence_object_is_exact \
    policy "$dry_policy_json" "$input_json" false false || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE=dry-run-binding
  dry_binding_json="$(recovery_kubectl create --dry-run=server -f - -o json \
    <<<"$binding_doc")" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_freeze_checkpoint_fence_object_is_exact \
    binding "$dry_binding_json" "$input_json" false false || return 1
  recovery_freeze_checkpoint_fence_pair_absent || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_INPUT_JSON="$input_json"
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED=1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE="policy-create-readback"
  if recovery_kubectl create -f - -o json \
      <<<"$policy_doc" >/dev/null; then :; else :; fi
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  policy_json="$(recovery_kubectl get validatingadmissionpolicy \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" -o json)" || return 1
  recovery_freeze_checkpoint_fence_object_is_exact \
    policy "$policy_json" "$input_json" false || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID="$(jq -er '.metadata.uid' \
    <<<"$policy_json")" || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV="$(jq -er '.metadata.resourceVersion' \
    <<<"$policy_json")" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED=1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE="binding-create-readback"
  if recovery_kubectl create -f - -o json \
      <<<"$binding_doc" >/dev/null; then :; else :; fi
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  binding_json="$(recovery_kubectl get validatingadmissionpolicybinding \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" -o json)" || return 1
  recovery_freeze_checkpoint_fence_object_is_exact \
    binding "$binding_json" "$input_json" false || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID="$(jq -er '.metadata.uid' \
    <<<"$binding_json")" || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV="$(jq -er '.metadata.resourceVersion' \
    <<<"$binding_json")" || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE="policy-observation"
  while ((attempt < 60)); do
    policy_json="$(recovery_kubectl get validatingadmissionpolicy \
      "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" -o json)" || return 1
    if recovery_freeze_checkpoint_fence_object_is_exact \
        policy "$policy_json" "$input_json" true &&
       [[ "$(jq -er '.metadata.uid' <<<"$policy_json")" == \
            "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" && \
          "$(jq -er '.metadata.resourceVersion' <<<"$policy_json")" == \
            "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV" ]]; then break; fi
    attempt=$((attempt + 1))
    sleep "${RECOVERY_WAIT_RETRY_DELAY_SECONDS:-1}"
  done
  ((attempt < 60)) || return 1
  binding_json="$(recovery_kubectl get validatingadmissionpolicybinding \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" -o json)" || return 1
  [[ "$(jq -er '.metadata.uid' <<<"$binding_json")" == \
       "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" && \
     "$(jq -er '.metadata.resourceVersion' <<<"$binding_json")" == \
       "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV" ]] || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY="$(
    recovery_freeze_checkpoint_fence_capability_json \
      "$input_json" "$policy_json" "$binding_json"
  )" || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE=probe
  if ! recovery_probe_freeze_checkpoint_fence \
      "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY"; then
    # shellcheck disable=SC2034 # Read by create-checkpoint.sh after sourcing.
    RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE="probe-${RECOVERY_FREEZE_CHECKPOINT_FENCE_PROBE_FAILURE:-unknown}"
    status=1
  fi
  [[ "$status" == 0 ]] || return 1
}

recovery_delete_cluster_fence_object_once() {
  local kind="$1" uid="$2" resource_version="$3" api_path current delete_options
  case "$kind" in
    policy) api_path="/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" ;;
    binding) api_path="/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" ;;
    *) return 2 ;;
  esac
  delete_options="$(jq -cn --arg uid "$uid" --arg rv "$resource_version" '{apiVersion:"v1",
    kind:"DeleteOptions",propagationPolicy:"Foreground",
    preconditions:{uid:$uid,resourceVersion:$rv}}')" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  if recovery_kubectl delete --raw="$api_path" -f - \
      <<<"$delete_options" >/dev/null 2>&1; then :; else :; fi
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  current="$(recovery_kubectl get "validatingadmissionpolicy$([[ "$kind" == binding ]] && printf binding)" \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" --ignore-not-found -o json)" || return 1
  [[ -z "$current" ]]
}

recovery_delete_freeze_checkpoint_fence() {
  local capability_json="$1" binding_uid binding_rv policy_uid policy_rv
  recovery_require_freeze_checkpoint_fence "$capability_json" || return 1
  binding_uid="$(jq -er '.binding.uid' <<<"$capability_json")" || return 1
  binding_rv="$(jq -er '.binding.resource_version' <<<"$capability_json")" || return 1
  policy_uid="$(jq -er '.policy.uid' <<<"$capability_json")" || return 1
  policy_rv="$(jq -er '.policy.resource_version' <<<"$capability_json")" || return 1
  recovery_delete_cluster_fence_object_once binding "$binding_uid" "$binding_rv" || return 1
  recovery_delete_cluster_fence_object_once policy "$policy_uid" "$policy_rv" || return 1
  RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY=""
  RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID=""
  RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV=""
  RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID=""
  RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV=""
  RECOVERY_FREEZE_CHECKPOINT_FENCE_INPUT_JSON=""
  RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED=0
  RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED=0
}

recovery_reconcile_freeze_checkpoint_fence_create_attempt() {
  local kind="$1" current resource
  [[ -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_INPUT_JSON" ]] || return 1
  case "$kind" in
    policy) resource=validatingadmissionpolicy ;;
    binding) resource=validatingadmissionpolicybinding ;;
    *) return 2 ;;
  esac
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  current="$(recovery_kubectl get "$resource" \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_NAME" \
    --ignore-not-found -o json)" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  if [[ -z "$current" ]]; then
    if [[ "$kind" == policy ]]; then
      RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED=0
      RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID=""
      RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV=""
    else
      RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED=0
      RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID=""
      RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV=""
    fi
    return 0
  fi
  recovery_freeze_checkpoint_fence_object_is_exact \
    "$kind" "$current" "$RECOVERY_FREEZE_CHECKPOINT_FENCE_INPUT_JSON" false || return 1
  if [[ "$kind" == policy ]]; then
    RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID="$(jq -er '.metadata.uid' \
      <<<"$current")" || return 1
    RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV="$(jq -er '.metadata.resourceVersion' \
      <<<"$current")" || return 1
  else
    RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID="$(jq -er '.metadata.uid' \
      <<<"$current")" || return 1
    RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV="$(jq -er '.metadata.resourceVersion' \
      <<<"$current")" || return 1
  fi
}

recovery_cleanup_partial_freeze_checkpoint_fence() {
  local status=0
  if [[ "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED" == 1 ||
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" ||
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV" ]]; then
    if [[ -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" ||
          -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV" ]]; then
      if [[ -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" ||
            -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV" ]] ||
         ! recovery_reconcile_freeze_checkpoint_fence_create_attempt binding; then
        status=1
      fi
    fi
  fi
  if [[ "$status" == 0 &&
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" &&
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV" ]]; then
    recovery_delete_cluster_fence_object_once binding \
      "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" \
      "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV" || status=1
    if [[ "$status" == 0 ]]; then
      RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID=""
      RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_RV=""
      RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED=0
    fi
  fi
  if [[ "$status" == 0 &&
        ( "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED" == 1 ||
          -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" ||
          -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV" ) ]]; then
    if [[ -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" ||
          -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV" ]]; then
      if [[ -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" ||
            -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV" ]] ||
         ! recovery_reconcile_freeze_checkpoint_fence_create_attempt policy; then
        status=1
      fi
    fi
  fi
  if [[ "$status" == 0 && -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" &&
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV" ]]; then
    recovery_delete_cluster_fence_object_once policy \
      "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" \
      "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV" || status=1
    if [[ "$status" == 0 ]]; then
      RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID=""
      RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_RV=""
      RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED=0
    fi
  fi
  if [[ "$status" == 0 &&
        "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED" == 0 &&
        "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED" == 0 &&
        -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" &&
        -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" ]]; then
    RECOVERY_FREEZE_CHECKPOINT_FENCE_INPUT_JSON=""
  fi
  [[ "$status" == 0 ]]
}

recovery_monitor_authority_path() {
  local ready_path="$1"
  [[ "$ready_path" == /* ]] || return 2
  printf '%s.authority.json\n' "$ready_path"
}

recovery_read_private_file_once() {
  local file_path="$1" maximum_bytes="$2" expected_sha256="${3:-}"
  [[ "$file_path" == /* && "$maximum_bytes" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ -z "$expected_sha256" || "$expected_sha256" =~ ^[a-f0-9]{64}$ ]] || return 2
  ! recovery_path_has_symlink_component "$file_path" || return 1
  command -v node >/dev/null 2>&1 || return 127
  # Hash and return the bytes read from one O_NOFOLLOW descriptor. Keeping the
  # descriptor open through both reads prevents a pathname replacement from
  # turning the hash check and the caller's JSON/marker parse into two
  # different capabilities.
  # shellcheck disable=SC2016 # Positional arguments are consumed by Node.
  command node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const [filePath, maximumText, expectedSha256] = process.argv.slice(1);
const maximum = Number(maximumText);
let descriptor;
try {
  if (!Number.isSafeInteger(maximum) || maximum < 1 ||
      (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256))) {
    process.exit(2);
  }
  descriptor = fs.openSync(
    filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  const before = fs.fstatSync(descriptor);
  if (!before.isFile() || (before.mode & 0o777) !== 0o600 ||
      before.size < 1 || before.size > maximum ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())) {
    process.exit(1);
  }
  const first = Buffer.alloc(before.size);
  const second = Buffer.alloc(before.size);
  if (fs.readSync(descriptor, first, 0, first.length, 0) !== first.length ||
      fs.readSync(descriptor, second, 0, second.length, 0) !== second.length ||
      !first.equals(second)) {
    process.exit(1);
  }
  const after = fs.fstatSync(descriptor);
  if (after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs || (after.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && after.uid !== process.getuid())) {
    process.exit(1);
  }
  if (expectedSha256 &&
      crypto.createHash("sha256").update(first).digest("hex") !== expectedSha256) {
    process.exit(1);
  }
  process.stdout.write(first);
} catch {
  process.exit(1);
} finally {
  if (descriptor !== undefined) {
    try { fs.closeSync(descriptor); } catch {}
  }
}
' "$file_path" "$maximum_bytes" "$expected_sha256"
}

recovery_publish_monitor_authority() {
  local authority_path="$1" authority_json="$2" digest_variable="$3"
  # Do not reuse a likely caller variable name here: Bash uses dynamic scope,
  # so `printf -v authority_sha256` would otherwise update this local instead
  # of the output variable owned by recovery_start_*.
  local published_sha256=""
  [[ "$authority_path" == /* &&
     "$digest_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     ! -e "$authority_path" && ! -L "$authority_path" ]] || return 2
  # noclobber is the portable Bash 3.2 primitive which makes an attacker-owned
  # leaf fail closed instead of following or truncating it between checks.
  if ! (set -C; umask 077; printf '%s\n' "$authority_json" >"$authority_path") \
      2>/dev/null; then
    return 1
  fi
  chmod 600 "$authority_path" || {
    rm -f -- "$authority_path"
    return 1
  }
  published_sha256="$(recovery_sha256_digest "$authority_path")" || {
    rm -f -- "$authority_path"
    return 1
  }
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$authority_path" "$published_sha256" 65536 || {
    rm -f -- "$authority_path"
    return 1
  }
  printf -v "$digest_variable" '%s' "$published_sha256"
}

recovery_monitor_authority_common_is_exact() {
  local authority_path="$1" authority_sha256="$2" expected_kind="$3"
  local guard_pid="$4" guard_start_identity="$5" failure_marker="$6"
  local ready_marker="$7" progress_marker="$8"
  local authority_json ready_value expected_ready baseline_path baseline_sha256
  [[ "$expected_kind" == checkpoint-writer-monitor ||
     "$expected_kind" == durable-runner-quiescence-monitor ]] || return 2
  [[ "$guard_pid" =~ ^[1-9][0-9]*$ && -n "$guard_start_identity" &&
     "$authority_sha256" =~ ^[a-f0-9]{64}$ ]] || return 2
  authority_json="$(recovery_read_private_file_once \
    "$authority_path" 65536 "$authority_sha256")" || return 1
  jq -e \
    --arg kind "$expected_kind" --argjson pid "$guard_pid" \
    --arg start_identity "$guard_start_identity" \
    --arg context "$EXPECTED_KUBE_CONTEXT" --arg namespace "$NAMESPACE" \
    --arg namespace_uid "${RECOVERY_NAMESPACE_UID:-}" \
    --arg operation_id "${RECOVERY_OPERATION_ID:-}" \
    --arg operation_owner "${RECOVERY_OPERATION_OWNER:-}" \
    --arg lock_name "${RECOVERY_OPERATION_LOCK_NAME:-}" \
    --arg lock_uid "${RECOVERY_OPERATION_LOCK_UID:-}" \
    --arg lock_rv "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" \
    --arg lease_name "${RECOVERY_SERIALIZATION_LEASE_NAME:-}" \
    --arg lease_uid "${RECOVERY_SERIALIZATION_LEASE_UID:-}" \
    --arg lease_holder "${RECOVERY_SERIALIZATION_LEASE_HOLDER:-}" \
    --arg authority "$authority_path" \
    --arg failure "$failure_marker" --arg ready "$ready_marker" \
    --arg progress "$progress_marker" '
    (keys | sort) == ["context","hashes","kind","lease","namespace",
      "namespace_uid","operation_id","operation_lock","operation_owner",
      "paths","pid","runtime_generation","schema_version",
      "start_identity"] and
    .schema_version == 1 and .kind == $kind and .pid == $pid and
    .start_identity == $start_identity and .context == $context and
    .namespace == $namespace and .namespace_uid == $namespace_uid and
    .operation_id == $operation_id and .operation_owner == $operation_owner and
    .operation_lock == {name:$lock_name,uid:$lock_uid,resource_version:$lock_rv} and
    .lease == {name:$lease_name,uid:$lease_uid,holder:$lease_holder} and
    .paths.authority == $authority and
    .paths.failure == $failure and .paths.ready == $ready and
    .paths.progress == $progress and
    (if $kind == "checkpoint-writer-monitor" then
      .runtime_generation == "durable-v2" or
        .runtime_generation == "legacy-absent"
    else
      .runtime_generation == "durable-v2"
    end) and
    (if $kind == "checkpoint-writer-monitor" then
      (.paths | keys | sort) == ["authority","baseline","contract","failure",
        "final","progress","ready","stop"] and
      (.hashes | keys) == ["contract_sha256"]
    else
      (.paths | keys | sort) == ["authority","control_baseline",
        "durable_baseline","failure","final","progress","ready","stop"] and
      (.hashes | keys | sort) == ["control_baseline_sha256",
        "control_capability_sha256","durable_baseline_sha256"]
    end) and
    all(.paths[]; type == "string" and startswith("/")) and
    ([.paths[]] | unique | length) == ([.paths[]] | length) and
    all(.hashes[]; type == "string" and test("^[a-f0-9]{64}$"))
  ' >/dev/null <<<"$authority_json" || return 1
  ready_value="$(recovery_read_private_file_once "$ready_marker" 2048)" || return 1
  if [[ "$expected_kind" == checkpoint-writer-monitor ]]; then
    baseline_path="$(jq -er '.paths.baseline' <<<"$authority_json")" || return 1
    [[ "$ready_value" =~ ^ready:([a-f0-9]{64}):([a-f0-9]{64})$ ]] || return 1
    baseline_sha256="${BASH_REMATCH[1]}"
    [[ "${BASH_REMATCH[2]}" == "$authority_sha256" ]] || return 1
    recovery_read_private_file_once \
      "$baseline_path" 2097152 "$baseline_sha256" >/dev/null || return 1
    expected_ready="ready:$baseline_sha256:$authority_sha256"
  else
    expected_ready="$(jq -er --arg authority_sha256 "$authority_sha256" '
      "ready:" + .hashes.durable_baseline_sha256 + ":" +
        .hashes.control_baseline_sha256 + ":" +
        .hashes.control_capability_sha256 + ":" + $authority_sha256
    ' <<<"$authority_json")" || return 1
  fi
  [[ "$ready_value" == "$expected_ready" ]] || return 1
  recovery_process_identity_is_live "$guard_pid" "$guard_start_identity"
}

recovery_stream_guard_process_is_healthy() {
  local guard_pid="$1" guard_start_identity="$2" failure_marker="$3"
  local ready_marker="${4:-}" progress_marker="${5:-}"
  local authority_path="${6:-}" authority_sha256="${7:-}"
  local authority_kind="${8:-}"
  [[ "$guard_pid" =~ ^[1-9][0-9]*$ && -n "$guard_start_identity" ]] || return 2
  recovery_runner_watch_marker_is_exact "$failure_marker" || return 1
  [[ ! -s "$failure_marker" ]] || return 1
  # A numeric legacy guard legitimately supplies only FAILURE + PROGRESS.
  # READY and the authority tuple distinguish the causal capability form;
  # PROGRESS alone must not accidentally opt the legacy form into it.
  if [[ -n "$authority_path" || -n "$authority_sha256" ||
        -n "$authority_kind" || -n "$ready_marker" ]]; then
    [[ -n "$authority_path" && -n "$authority_sha256" &&
       -n "$authority_kind" && -n "$ready_marker" &&
       -n "$progress_marker" ]] || return 2
    recovery_monitor_authority_common_is_exact \
      "$authority_path" "$authority_sha256" "$authority_kind" \
      "$guard_pid" "$guard_start_identity" "$failure_marker" \
      "$ready_marker" "$progress_marker" || return 1
  fi
  recovery_process_identity_is_live "$guard_pid" "$guard_start_identity"
}

recovery_stream_guard_progress_value() {
  local progress_marker="$1" expected_authority_sha256="${2:-}"
  local progress_value parsed_authority_sha256 parsed_counter
  recovery_runner_watch_marker_is_exact "$progress_marker" || return 1
  [[ -s "$progress_marker" ]] || return 1
  progress_value="$(<"$progress_marker")"
  if [[ -n "$expected_authority_sha256" ]]; then
    [[ "$expected_authority_sha256" =~ ^[a-f0-9]{64}$ &&
       "$progress_value" =~ ^([a-f0-9]{64}):([1-9][0-9]{0,17})$ ]] || return 1
    parsed_authority_sha256="${BASH_REMATCH[1]}"
    parsed_counter="${BASH_REMATCH[2]}"
    [[ "$parsed_authority_sha256" == "$expected_authority_sha256" ]] || return 1
    printf '%s\n' "$parsed_counter"
    return 0
  fi
  [[ "$progress_value" =~ ^[1-9][0-9]{0,17}$ ]] || return 1
  printf '%s\n' "$progress_value"
}

recovery_write_stream_guard_progress() {
  local progress_marker="$1" progress_value="$2"
  local authority_sha256="${3:-}" published_value
  local next_marker="${progress_marker}.next"
  recovery_runner_watch_marker_is_exact "$progress_marker" || return 1
  [[ "$progress_value" =~ ^[1-9][0-9]{0,17}$ ]] || return 2
  if [[ -n "$authority_sha256" ]]; then
    [[ "$authority_sha256" =~ ^[a-f0-9]{64}$ ]] || return 2
    published_value="$authority_sha256:$progress_value"
  else
    published_value="$progress_value"
  fi
  [[ ! -e "$next_marker" && ! -L "$next_marker" ]] || return 1
  (umask 077; printf '%s\n' "$published_value" >"$next_marker") || {
    rm -f -- "$next_marker"
    return 1
  }
  chmod 600 "$next_marker" || {
    rm -f -- "$next_marker"
    return 1
  }
  mv -f -- "$next_marker" "$progress_marker" || {
    rm -f -- "$next_marker"
    return 1
  }
}

recovery_stream_poll_seconds() {
  local requested="${RECOVERY_STREAM_POLL_SECONDS:-}"
  if [[ -z "$requested" ]]; then
    printf '1\n'
    return 0
  fi
  recovery_require_local_fixture_attestation || return 1
  [[ "$requested" == 1 || "$requested" =~ ^0\.[0-9]*[1-9][0-9]*$ ]] || return 2
  printf '%s\n' "$requested"
}

recovery_stream_guard_max_stale_seconds() {
  local requested="${RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS:-}"
  if [[ -z "$requested" ]]; then
    # A healthy sweep normally completes in a few seconds. Ten seconds is
    # deliberately below kubectl's 45-second request timeout, so a live but
    # wedged monitor cannot authorize a destructive stream until that timeout.
    printf '10\n'
    return 0
  fi
  recovery_require_local_fixture_attestation || return 1
  [[ "$requested" =~ ^([1-9]|10)$ ]] || return 2
  printf '%s\n' "$requested"
}

recovery_stream_guard_initial_deadline_seconds() {
  local requested="${RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS:-}"
  if [[ -z "$requested" ]]; then
    # This is only the startup allowance before any destructive stream can
    # begin. Once a complete sweep exists, the independent production
    # staleness budget remains capped at ten seconds.
    printf '10\n'
    return 0
  fi
  recovery_require_local_fixture_attestation || return 1
  [[ "$requested" =~ ^([1-9]|[1-9][0-9]|1[01][0-9]|120)$ ]] || return 2
  printf '%s\n' "$requested"
}

recovery_wait_for_stream_guard_initial_progress() {
  local guard_pid="$1" guard_start_identity="$2" failure_marker="$3"
  local progress_marker="$4" maximum_seconds="$5"
  local poll_seconds started_milliseconds current_milliseconds
  [[ "$maximum_seconds" =~ ^([1-9]|[1-9][0-9]|1[01][0-9]|120)$ ]] || return 2
  poll_seconds="$(recovery_stream_poll_seconds)" || return 1
  started_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
  recovery_runner_watch_marker_is_exact "$progress_marker" || return 1
  while :; do
    recovery_stream_guard_process_is_healthy \
      "$guard_pid" "$guard_start_identity" "$failure_marker" || return 1
    if [[ -s "$progress_marker" ]]; then
      recovery_stream_guard_progress_value "$progress_marker" >/dev/null || return 1
      return 0
    fi
    current_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
    ((current_milliseconds - started_milliseconds < maximum_seconds * 1000)) || return 1
    sleep "$poll_seconds"
  done
}

recovery_wait_for_stream_guard_progress_after() {
  local guard_pid="$1" guard_start_identity="$2" failure_marker="$3"
  local progress_marker="$4" baseline_progress="$5" maximum_seconds="$6"
  local authority_sha256="${7:-}" authority_path="${8:-}"
  local authority_kind="${9:-}" ready_marker="${10:-}"
  local poll_seconds current_progress started_milliseconds current_milliseconds
  [[ "$baseline_progress" =~ ^[1-9][0-9]{0,17}$ &&
     "$maximum_seconds" =~ ^([1-9]|[1-9][0-9])$ ]] || return 2
  poll_seconds="$(recovery_stream_poll_seconds)" || return 1
  started_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
  while :; do
    recovery_stream_guard_process_is_healthy \
      "$guard_pid" "$guard_start_identity" "$failure_marker" \
      "$ready_marker" "$progress_marker" "$authority_path" \
      "$authority_sha256" "$authority_kind" || return 1
    current_progress="$(recovery_stream_guard_progress_value \
      "$progress_marker" "$authority_sha256")" || return 1
    ((current_progress >= baseline_progress)) || return 1
    if ((current_progress > baseline_progress)); then
      printf '%s\n' "$current_progress"
      return 0
    fi
    current_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
    ((current_milliseconds - started_milliseconds < maximum_seconds * 1000)) || return 1
    sleep "$poll_seconds"
  done
}

recovery_kubectl_stream_supervised() {
  local require_lease="$1" maximum_seconds="$2"
  shift 2
  local poll_seconds caller_pid="$$"
  local caller_start_identity guard_pid guard_start_identity failure_marker
  local ready_marker progress_marker maximum_stale_seconds index authority_kind
  local authority_path authority_sha256 existing_index
  local current_progress previous_progress observation_milliseconds
  local previous_observation_milliseconds current_milliseconds
  local all_guards_fresh
  local -a guard_pids=() guard_start_identities=() guard_failure_markers=()
  local -a guard_ready_markers=() guard_authority_paths=()
  local -a guard_authority_sha256s=() guard_authority_kinds=()
  local -a guard_progress_markers=() guard_maximum_stale_seconds=()
  local -a guard_baseline_progress=() guard_fresh_progress=()
  local -a guard_baseline_observation_milliseconds=()
  local -a guard_fresh_progress_milliseconds=()
  local -a guard_fresh_observation_milliseconds=()
  local -a guard_fresh_advanced=()
  [[ "$require_lease" == 0 || "$require_lease" == 1 ]] || return 2
  # Optional guards precede `--` and are repeatable:
  # --guard-process PID START_IDENTITY FAILURE_MARKER PROGRESS_MARKER MAX_STALE_SECONDS
  # --guard-process-capability KIND PID START_IDENTITY FAILURE_MARKER
  #   READY_MARKER PROGRESS_MARKER AUTHORITY_PATH AUTHORITY_SHA256 MAX_STALE_SECONDS
  while [[ "${1:-}" == --guard-process ||
           "${1:-}" == --guard-process-capability ]]; do
    authority_kind=""
    ready_marker=""
    authority_path=""
    authority_sha256=""
    if [[ "$1" == --guard-process ]]; then
      [[ "$#" -ge 6 ]] || return 2
      guard_pid="$2"
      guard_start_identity="$3"
      failure_marker="$4"
      progress_marker="$5"
      maximum_stale_seconds="$6"
      shift 6
    else
      [[ "$#" -ge 10 ]] || return 2
      authority_kind="$2"
      guard_pid="$3"
      guard_start_identity="$4"
      failure_marker="$5"
      ready_marker="$6"
      progress_marker="$7"
      authority_path="$8"
      authority_sha256="$9"
      maximum_stale_seconds="${10}"
      [[ "$authority_kind" == checkpoint-writer-monitor ||
         "$authority_kind" == durable-runner-quiescence-monitor ]] || return 2
      [[ "$ready_marker" == /* && "$authority_path" == /* &&
         "$authority_sha256" =~ ^[a-f0-9]{64}$ ]] || return 2
      shift 10
    fi
    [[ "$guard_pid" =~ ^[1-9][0-9]*$ && -n "$guard_start_identity" &&
       "$failure_marker" == /* && "$progress_marker" == /* &&
       "$maximum_stale_seconds" =~ ^([1-9]|[1-9][0-9])$ ]] || return 2
    for existing_index in "${!guard_pids[@]}"; do
      [[ "${guard_pids[$existing_index]}" != "$guard_pid" ]] || return 2
    done
    guard_pids+=("$guard_pid")
    guard_start_identities+=("$guard_start_identity")
    guard_failure_markers+=("$failure_marker")
    guard_ready_markers+=("$ready_marker")
    guard_progress_markers+=("$progress_marker")
    guard_authority_paths+=("$authority_path")
    guard_authority_sha256s+=("$authority_sha256")
    guard_authority_kinds+=("$authority_kind")
    guard_maximum_stale_seconds+=("$maximum_stale_seconds")
  done
  if [[ "${1:-}" == -- ]]; then
    shift
  fi
  [[ "$maximum_seconds" =~ ^[1-9][0-9]*$ && "$#" -gt 0 ]] || return 2
  poll_seconds="$(recovery_stream_poll_seconds)" || return 1
  for index in "${!guard_pids[@]}"; do
    recovery_stream_guard_process_is_healthy \
      "${guard_pids[$index]}" "${guard_start_identities[$index]}" \
      "${guard_failure_markers[$index]}" "${guard_ready_markers[$index]}" \
      "${guard_progress_markers[$index]}" \
      "${guard_authority_paths[$index]}" \
      "${guard_authority_sha256s[$index]}" \
      "${guard_authority_kinds[$index]}" || return 1
    guard_baseline_observation_milliseconds[index]="$(
      recovery_monotonic_milliseconds
    )" || return 1
    guard_baseline_progress[index]="$(recovery_stream_guard_progress_value \
      "${guard_progress_markers[$index]}" \
      "${guard_authority_sha256s[$index]}")" || return 1
    guard_fresh_progress[index]="${guard_baseline_progress[$index]}"
    guard_fresh_observation_milliseconds[index]="${guard_baseline_observation_milliseconds[$index]}"
    guard_fresh_progress_milliseconds[index]=""
    guard_fresh_advanced[index]=0
  done
  # Never reset freshness on a counter that may have been stale while the
  # caller performed earlier gates. Every guarded process must publish one new
  # complete successful sweep immediately before this particular stream.
  # Observe every unfinished capability in one foreground round-robin. Waiting
  # for each guard serially can consume the sum of otherwise healthy periods;
  # it can also misdate an increment that occurred while another guard was
  # blocking. A progress increase is credited only to the previous observation
  # that still saw the older counter, never to the later poll that discovers it.
  while [[ "${#guard_pids[@]}" -gt 0 ]]; do
    for index in "${!guard_pids[@]}"; do
      recovery_stream_guard_process_is_healthy \
        "${guard_pids[$index]}" "${guard_start_identities[$index]}" \
        "${guard_failure_markers[$index]}" "${guard_ready_markers[$index]}" \
        "${guard_progress_markers[$index]}" \
        "${guard_authority_paths[$index]}" \
        "${guard_authority_sha256s[$index]}" \
        "${guard_authority_kinds[$index]}" || return 1
      previous_observation_milliseconds="${guard_fresh_observation_milliseconds[$index]}"
      observation_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
      current_progress="$(recovery_stream_guard_progress_value \
        "${guard_progress_markers[$index]}" \
        "${guard_authority_sha256s[$index]}")" || return 1
      previous_progress="${guard_fresh_progress[$index]}"
      ((current_progress >= previous_progress)) || return 1
      if ((current_progress > previous_progress)); then
        guard_fresh_progress[index]="$current_progress"
        guard_fresh_progress_milliseconds[index]="$previous_observation_milliseconds"
        guard_fresh_advanced[index]=1
      fi
      guard_fresh_observation_milliseconds[index]="$observation_milliseconds"
    done
    current_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
    all_guards_fresh=true
    for index in "${!guard_pids[@]}"; do
      if [[ "${guard_fresh_advanced[$index]}" != 1 ]]; then
        all_guards_fresh=false
        ((current_milliseconds - guard_baseline_observation_milliseconds[index] <
          guard_maximum_stale_seconds[index] * 1000)) || return 1
      elif ((current_milliseconds - guard_fresh_progress_milliseconds[index] >=
        guard_maximum_stale_seconds[index] * 1000)); then
        return 1
      fi
    done
    [[ "$all_guards_fresh" != true ]] || break
    sleep "$poll_seconds"
  done
  caller_start_identity="$(recovery_process_start_identity "$caller_pid")" || return 1
  command -v python3 >/dev/null 2>&1 || return 127
  (
    local stream_pid="" stream_start_identity="" stream_gate=""
    local stream_status=0 stream_started_milliseconds index
    local stream_diagnostic_stage=initialize stream_diagnostic_status=0
    local current_progress previous_progress observation_milliseconds
    local previous_observation_milliseconds current_milliseconds
    local remaining_milliseconds lease_budget_milliseconds lease_timeout_seconds
    local guard_cancel_reserve_milliseconds=2000
    local -a guard_last_progress=() guard_last_progress_milliseconds=()
    local -a guard_last_observation_milliseconds=()
    # shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap below.
    report_stream_diagnostic() {
      stream_diagnostic_status=$?
      trap - EXIT
      if [[ "$stream_diagnostic_status" != 0 &&
            "${RECOVERY_STREAM_DIAGNOSTIC_CONTEXT:-}" == database-restore ]]; then
        printf 'database_restore_stream_stage:%s\n' \
          "$stream_diagnostic_stage" >&2
      fi
      exit "$stream_diagnostic_status"
    }
    trap report_stream_diagnostic EXIT
    initialize_supervised_stream_guards() {
      for index in "${!guard_pids[@]}"; do
        recovery_stream_guard_process_is_healthy \
          "${guard_pids[$index]}" "${guard_start_identities[$index]}" \
          "${guard_failure_markers[$index]}" "${guard_ready_markers[$index]}" \
          "${guard_progress_markers[$index]}" \
          "${guard_authority_paths[$index]}" \
          "${guard_authority_sha256s[$index]}" \
          "${guard_authority_kinds[$index]}" || return 1
        previous_observation_milliseconds="${guard_fresh_observation_milliseconds[$index]}"
        observation_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
        current_progress="$(recovery_stream_guard_progress_value \
          "${guard_progress_markers[$index]}" \
          "${guard_authority_sha256s[$index]}")" || return 1
        ((current_progress >= guard_fresh_progress[index])) || return 1
        guard_last_progress[index]="$current_progress"
        if ((current_progress > guard_fresh_progress[index])); then
          # This increase happened after the outer round's last observation,
          # but may have happened immediately after it. Preserve that causal
          # lower bound instead of dating it at this later observation.
          guard_last_progress_milliseconds[index]="$previous_observation_milliseconds"
        else
          guard_last_progress_milliseconds[index]="${guard_fresh_progress_milliseconds[index]}"
        fi
        guard_last_observation_milliseconds[index]="$observation_milliseconds"
        current_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
        ((current_milliseconds - guard_last_progress_milliseconds[index] <
          guard_maximum_stale_seconds[index] * 1000)) || return 1
      done
    }
    refresh_supervised_stream_guards_for_launch() {
      local all_refresh_guards_fresh
      local -a refresh_baseline_progress=()
      local -a refresh_baseline_observation_milliseconds=()
      local -a refresh_advanced=()
      # Capture one current baseline for every guard before waiting for any of
      # them. An increment observed here may have happened after the prior
      # observation, so update its lower bound causally, but it does not satisfy
      # this second pre-launch sweep.
      for index in "${!guard_pids[@]}"; do
        recovery_stream_guard_process_is_healthy \
          "${guard_pids[$index]}" "${guard_start_identities[$index]}" \
          "${guard_failure_markers[$index]}" "${guard_ready_markers[$index]}" \
          "${guard_progress_markers[$index]}" \
          "${guard_authority_paths[$index]}" \
          "${guard_authority_sha256s[$index]}" \
          "${guard_authority_kinds[$index]}" || return 1
        previous_observation_milliseconds="${guard_last_observation_milliseconds[$index]}"
        observation_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
        current_progress="$(recovery_stream_guard_progress_value \
          "${guard_progress_markers[$index]}" \
          "${guard_authority_sha256s[$index]}")" || return 1
        previous_progress="${guard_last_progress[$index]}"
        ((current_progress >= previous_progress)) || return 1
        if ((current_progress > previous_progress)); then
          guard_last_progress_milliseconds[index]="$previous_observation_milliseconds"
        fi
        guard_last_progress[index]="$current_progress"
        guard_last_observation_milliseconds[index]="$observation_milliseconds"
        refresh_baseline_progress[index]="$current_progress"
        refresh_baseline_observation_milliseconds[index]="$observation_milliseconds"
        refresh_advanced[index]=0
      done
      # Require another causally observed increment from every guard, while
      # continuing to observe fast guards so their lower bounds can remain
      # simultaneously fresh as the slowest healthy guard completes a sweep.
      while [[ "${#guard_pids[@]}" -gt 0 ]]; do
        for index in "${!guard_pids[@]}"; do
          recovery_stream_guard_process_is_healthy \
            "${guard_pids[$index]}" "${guard_start_identities[$index]}" \
            "${guard_failure_markers[$index]}" "${guard_ready_markers[$index]}" \
            "${guard_progress_markers[$index]}" \
            "${guard_authority_paths[$index]}" \
            "${guard_authority_sha256s[$index]}" \
            "${guard_authority_kinds[$index]}" || return 1
          previous_observation_milliseconds="${guard_last_observation_milliseconds[$index]}"
          observation_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
          current_progress="$(recovery_stream_guard_progress_value \
            "${guard_progress_markers[$index]}" \
            "${guard_authority_sha256s[$index]}")" || return 1
          previous_progress="${guard_last_progress[$index]}"
          ((current_progress >= previous_progress)) || return 1
          if ((current_progress > previous_progress)); then
            guard_last_progress[index]="$current_progress"
            guard_last_progress_milliseconds[index]="$previous_observation_milliseconds"
            if ((current_progress > refresh_baseline_progress[index])); then
              refresh_advanced[index]=1
            fi
          fi
          guard_last_observation_milliseconds[index]="$observation_milliseconds"
        done
        current_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
        all_refresh_guards_fresh=true
        for index in "${!guard_pids[@]}"; do
          if [[ "${refresh_advanced[$index]}" != 1 ]]; then
            all_refresh_guards_fresh=false
            ((current_milliseconds - refresh_baseline_observation_milliseconds[index] <
              guard_maximum_stale_seconds[index] * 1000)) || return 1
          elif ((current_milliseconds - guard_last_progress_milliseconds[index] >=
            guard_maximum_stale_seconds[index] * 1000)); then
            return 1
          fi
        done
        [[ "$all_refresh_guards_fresh" != true ]] || break
        sleep "$poll_seconds"
      done
      supervised_stream_guards_are_healthy
    }
    supervised_stream_guards_are_healthy() {
      for index in "${!guard_pids[@]}"; do
        recovery_stream_guard_process_is_healthy \
          "${guard_pids[$index]}" "${guard_start_identities[$index]}" \
          "${guard_failure_markers[$index]}" "${guard_ready_markers[$index]}" \
          "${guard_progress_markers[$index]}" \
          "${guard_authority_paths[$index]}" \
          "${guard_authority_sha256s[$index]}" \
          "${guard_authority_kinds[$index]}" || return 1
        previous_observation_milliseconds="${guard_last_observation_milliseconds[$index]}"
        observation_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
        current_progress="$(recovery_stream_guard_progress_value \
          "${guard_progress_markers[$index]}" \
          "${guard_authority_sha256s[$index]}")" || return 1
        previous_progress="${guard_last_progress[$index]}"
        if ((current_progress < previous_progress)); then
          return 1
        elif ((current_progress > previous_progress)); then
          guard_last_progress[index]="$current_progress"
          # The publication happened after the previous observation, but may
          # have happened immediately after it. Use that lower bound, not the
          # time of this observation after a possibly five-second Lease GET.
          guard_last_progress_milliseconds[index]="$previous_observation_milliseconds"
        fi
        guard_last_observation_milliseconds[index]="$observation_milliseconds"
        current_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
        if ((current_milliseconds - guard_last_progress_milliseconds[index] >=
          guard_maximum_stale_seconds[index] * 1000)); then
          return 1
        fi
      done
    }
    supervised_stream_guard_remaining_milliseconds() {
      local minimum_remaining="" guard_deadline
      if [[ "${#guard_pids[@]}" == 0 ]]; then
        printf '2147483647\n'
        return 0
      fi
      current_milliseconds="$(recovery_monotonic_milliseconds)" || return 1
      for index in "${!guard_pids[@]}"; do
        guard_deadline=$((
          guard_last_progress_milliseconds[index] +
          guard_maximum_stale_seconds[index] * 1000
        ))
        remaining_milliseconds=$((guard_deadline - current_milliseconds))
        if [[ -z "$minimum_remaining" ]] ||
           ((remaining_milliseconds < minimum_remaining)); then
          minimum_remaining="$remaining_milliseconds"
        fi
      done
      printf '%s\n' "$minimum_remaining"
    }
    supervised_stream_require_lease_within_guard_budget() {
      local cancellation_reserve_milliseconds="${1:-$guard_cancel_reserve_milliseconds}"
      [[ "$cancellation_reserve_milliseconds" =~ ^[0-9]+$ ]] || return 2
      [[ "$require_lease" == 1 ]] || return 0
      remaining_milliseconds="$(
        supervised_stream_guard_remaining_milliseconds
      )" || return 1
      if [[ "${#guard_pids[@]}" == 0 ]]; then
        lease_timeout_seconds=5
      else
        lease_budget_milliseconds=$((
          remaining_milliseconds - cancellation_reserve_milliseconds
        ))
        # kubectl accepts a whole-second request timeout. Refuse to start a
        # Lease GET unless at least one complete second remains after reserving
        # enough time to detect the outcome, revoke the stream and reap it.
        ((lease_budget_milliseconds >= 1000)) || return 1
        lease_timeout_seconds=$((lease_budget_milliseconds / 1000))
        ((lease_timeout_seconds <= 5)) || lease_timeout_seconds=5
        # A deliberately short (five-second or smaller) guard needs room for
        # another observation and local process-group revocation. A two-second
        # GET can otherwise occur twice and consume the complete deadline once
        # scheduling overhead is included. Production ten-second guards retain
        # the normal bounded five-second API allowance.
        if ((remaining_milliseconds <= 5000 && lease_timeout_seconds > 1)); then
          lease_timeout_seconds=1
        fi
      fi
      recovery_require_operation_serialization_stream "$lease_timeout_seconds"
    }
    supervised_stream_guard_has_cancellation_reserve() {
      [[ "${#guard_pids[@]}" != 0 ]] || return 0
      remaining_milliseconds="$(
        supervised_stream_guard_remaining_milliseconds
      )" || return 1
      ((remaining_milliseconds > guard_cancel_reserve_milliseconds))
    }
    supervised_stream_child_is_running() {
      local running_pid
      while IFS= read -r running_pid; do
        [[ "$running_pid" == "$stream_pid" ]] && return 0
      done < <(jobs -r -p)
      return 1
    }
    supervised_stream_cleanup() {
      if [[ "$stream_pid" =~ ^[1-9][0-9]*$ ]]; then
        if [[ -n "$stream_start_identity" ]] &&
           recovery_process_identity_is_live \
             "$stream_pid" "$stream_start_identity"; then
          recovery_revoke_process_group_immediate \
            "$stream_pid" "$stream_start_identity" || :
        elif [[ -n "$stream_start_identity" ]] &&
             supervised_stream_child_is_running; then
          # The high-resolution identity reader can fail transiently. Bash's
          # own running-job table still proves this PID is our unreaped child,
          # so revoke and reap it instead of dropping the only local handle to
          # a destructive kubectl stream.
          recovery_revoke_owned_child_process_group_immediate \
            "$stream_pid" || :
        elif [[ -z "$stream_start_identity" && -n "$stream_gate" ]]; then
          # The launcher cannot exec kubectl until its exact start identity is
          # captured. Revoking the private gate is therefore sufficient here
          # and avoids signalling a numeric PID without an identity capability.
          printf 'abort\n' >"$stream_gate" 2>/dev/null || :
          wait "$stream_pid" 2>/dev/null || :
        elif ! kill -0 "$stream_pid" 2>/dev/null; then
          # The exact child has already exited. Reap its cached status before
          # revoking only descendants that retain its isolated process group.
          wait "$stream_pid" 2>/dev/null || :
          kill -0 "$stream_pid" 2>/dev/null ||
            recovery_stop_reaped_isolated_process_group "$stream_pid"
        fi
        stream_pid=""
        stream_start_identity=""
      fi
      [[ -z "$stream_gate" ]] || rm -f -- "$stream_gate"
      stream_gate=""
    }
    trap 'supervised_stream_cleanup; exit 130' INT TERM
    recovery_process_identity_is_live "$caller_pid" "$caller_start_identity" || return 1
    stream_diagnostic_stage=initialize
    initialize_supervised_stream_guards || return 1
    # A multi-guard stream must not inherit most of its ten-second budget from
    # sequential startup waits. Obtain another complete sweep from every guard
    # while no destructive child exists, then authorize the gated launch.
    stream_diagnostic_stage=refresh
    refresh_supervised_stream_guards_for_launch || return 1
    stream_diagnostic_stage=launch
    stream_gate="$(mktemp "${TMPDIR:-/tmp}/yenhubs-stream-gate.XXXXXX")" || return 1
    chmod 600 "$stream_gate" || {
      rm -f -- "$stream_gate"
      stream_gate=""
      return 1
    }
    # Python creates a new session and then execs kubectl. The resulting PID is
    # also the process-group leader, so a parent-death or Lease-loss watchdog
    # can terminate kubectl and every local descendant as one unit. The private
    # gate prevents kubectl from starting before the leader's exact PID/start
    # identity capability has been captured by this supervising shell.
    command python3 -I -c '
import os
import sys
import time
os.setsid()
gate_path = sys.argv[1]
deadline = time.monotonic() + 5
while True:
    try:
        with open(gate_path, "rb") as gate:
            decision = gate.read(16)
    except OSError:
        sys.exit(1)
    if decision == b"go\n":
        break
    if decision not in (b"",):
        sys.exit(1)
    if time.monotonic() >= deadline:
        sys.exit(1)
    time.sleep(0.01)
os.execvp(sys.argv[2], sys.argv[2:])
' "$stream_gate" kubectl --context "$EXPECTED_KUBE_CONTEXT" \
        --request-timeout="${maximum_seconds}s" "$@" <&0 &
    stream_pid=$!
    if ! stream_start_identity="$(recovery_process_start_identity "$stream_pid")"; then
      supervised_stream_cleanup
      return 1
    fi
    if ! recovery_process_identity_is_live "$caller_pid" "$caller_start_identity" ||
       ! supervised_stream_guards_are_healthy ||
       ! supervised_stream_require_lease_within_guard_budget ||
       ! supervised_stream_guards_are_healthy ||
       ! supervised_stream_guard_has_cancellation_reserve; then
      supervised_stream_cleanup
      return 1
    fi
    printf 'go\n' >"$stream_gate" || {
      supervised_stream_cleanup
      return 1
    }
    stream_started_milliseconds="$(recovery_monotonic_milliseconds)" || {
      supervised_stream_cleanup
      return 1
    }
    stream_diagnostic_stage=running
    while :; do
      if ! recovery_process_identity_is_live \
          "$stream_pid" "$stream_start_identity"; then
        # A short kubectl may exit naturally between the prior observation and
        # the high-resolution identity read. Bash's own job table distinguishes
        # that completed child from a still-running process whose numeric PID no
        # longer matches; only the latter is an identity failure.
        if supervised_stream_child_is_running; then
          supervised_stream_cleanup
          return 1
        fi
        break
      fi
      current_milliseconds="$(recovery_monotonic_milliseconds)" || {
        supervised_stream_cleanup
        return 1
      }
      if ((current_milliseconds - stream_started_milliseconds >=
        maximum_seconds * 1000)); then
        supervised_stream_cleanup
        return 1
      fi
      if ! recovery_process_identity_is_live "$caller_pid" "$caller_start_identity"; then
        supervised_stream_cleanup
        return 1
      fi
      if ! supervised_stream_guards_are_healthy; then
        supervised_stream_cleanup
        return 1
      fi
      if ! supervised_stream_require_lease_within_guard_budget ||
         ! supervised_stream_guards_are_healthy ||
         ! supervised_stream_guard_has_cancellation_reserve; then
        supervised_stream_cleanup
        return 1
      fi
      sleep "$poll_seconds"
    done
    stream_diagnostic_stage="command"
    if wait "$stream_pid"; then stream_status=0; else stream_status=$?; fi
    if [[ "$stream_status" != 0 ]]; then
      recovery_stop_reaped_isolated_process_group "$stream_pid"
    fi
    stream_pid=""
    stream_start_identity=""
    rm -f -- "$stream_gate"
    stream_gate=""
    stream_diagnostic_stage=post-audit
    recovery_process_identity_is_live "$caller_pid" "$caller_start_identity" || return 1
    supervised_stream_guards_are_healthy || return 1
    # The local stream group has already been waited and reaped. The final
    # Lease/guard audit still fails closed, but no cancellation reserve is
    # needed once there is no destructive capability left to revoke.
    supervised_stream_require_lease_within_guard_budget 0 || return 1
    supervised_stream_guards_are_healthy || return 1
    return "$stream_status"
  )
}

recovery_kubectl_stream() {
  recovery_kubectl_stream_supervised 0 "$@"
}

recovery_kubectl_stream_mutate() {
  recovery_kubectl_stream_supervised 1 "$@"
}

recovery_kubectl_stream_guarded() {
  recovery_kubectl_stream_supervised 1 "$@"
}

recovery_sha256_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path"
  else
    printf 'Neither shasum nor sha256sum is available.\n' >&2
    return 127
  fi
}

recovery_sha256_digest() {
  local output
  if ! output="$(recovery_sha256_file "$1")"; then
    return 1
  fi
  output="${output%%[[:space:]]*}"
  [[ "$output" =~ ^[a-fA-F0-9]{64}$ ]] || return 1
  printf '%s\n' "$output"
}

recovery_file_size_bytes() {
  local path="$1" size
  if size="$(stat -c '%s' -- "$path" 2>/dev/null)"; then
    :
  elif size="$(stat -f '%z' -- "$path" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$size"
}

recovery_checkpoint_snapshot_artifacts() {
  local metadata_schema="${1:-3}"
  [[ "$metadata_schema" == 2 || "$metadata_schema" == 3 ]] || return 2
  printf '%s\n' \
    checkpoint-metadata.json \
    configured-value-keys.txt \
    database-contract.json \
    deployment-images.json \
    digitalocean-cluster.json \
    digitalocean-load-balancers.json \
    digitalocean-volumes.json \
    git-state.txt \
    k8s-configmaps-redacted.json \
    k8s-hcce-structure.json
  if [[ "$metadata_schema" == 3 ]]; then
    printf '%s\n' runner-cutover-evidence.json
  fi
}

recovery_checkpoint_metadata_schema() {
  local directory="$1" metadata_path schema
  metadata_path="$directory/checkpoint-metadata.json"
  recovery_require_regular_direct_file "$metadata_path" || return 1
  schema="$(jq -er '.schema_version | select(. == 2 or . == 3)' \
    "$metadata_path")" || return 1
  printf '%s\n' "$schema"
}

recovery_path_has_symlink_component() {
  local input_path="$1"
  local absolute_path current component
  local -a components
  if [[ "$input_path" == /* ]]; then
    absolute_path="$input_path"
  else
    absolute_path="$PWD/$input_path"
  fi
  IFS='/' read -r -a components <<<"$absolute_path"
  current=""
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != "." ]] || continue
    [[ "$component" != ".." ]] || return 0
    current="$current/$component"
    [[ ! -L "$current" ]] || return 0
  done
  return 1
}

# Capture and later retire one process-local private directory without ever
# trusting its pathname as deletion authority. The opaque token binds the
# canonical parent plus the parent/root dev:ino identities. Cleanup accepts a
# closed allowlist of optional relative entries encoded as d:path or f:path;
# every entry that actually exists must be present in that allowlist and must
# satisfy the private 0700/0600 ownership contract before any byte is removed.
#
# POSIX exposes no unlink/rmdir-by-inode compare-and-swap. Holding dirfds,
# rejecting links, and rechecking lstat/fstat immediately before each unlink or
# rmdir closes cooperative replacement races. A hostile same-UID process can
# still win the nanorace after that final check; callers therefore must keep
# these roots 0700 and process-local. Any observed conflict preserves the
# replacement (or an exact empty orphan) and fails without pathname fallback.
recovery_private_directory_tool() {
  command -v python3 >/dev/null 2>&1 || return 127
  command python3 -I - "$@" <<'PY'
import base64
import json
import os
import posixpath
import stat
import sys


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


require(hasattr(os, "O_NOFOLLOW"), "no_o_nofollow")
require(hasattr(os, "O_DIRECTORY"), "no_o_directory")
for operation in (os.open, os.stat, os.unlink, os.rmdir):
    require(operation in os.supports_dir_fd, "no_dirfd_support")

DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW
CURRENT_UID = os.getuid()


def same_file(left, right):
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_uid == right.st_uid
        and left.st_gid == right.st_gid
        and left.st_mode == right.st_mode
        and left.st_nlink == right.st_nlink
        and left.st_size == right.st_size
        and left.st_mtime_ns == right.st_mtime_ns
        and left.st_ctime_ns == right.st_ctime_ns
    )


def same_directory(left, right):
    return (
        stat.S_ISDIR(left.st_mode)
        and stat.S_ISDIR(right.st_mode)
        and left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_uid == right.st_uid
        and left.st_gid == right.st_gid
        and stat.S_IMODE(left.st_mode) == stat.S_IMODE(right.st_mode)
    )


def exact_private_directory(value, device):
    return (
        stat.S_ISDIR(value.st_mode)
        and value.st_dev == device
        and value.st_uid == CURRENT_UID
        and stat.S_IMODE(value.st_mode) == 0o700
    )


def exact_private_file(value, device):
    return (
        stat.S_ISREG(value.st_mode)
        and value.st_dev == device
        and value.st_uid == CURRENT_UID
        and stat.S_IMODE(value.st_mode) == 0o600
        and value.st_nlink == 1
    )


def open_canonical_directory(path):
    require(path.startswith("/"), "parent_not_absolute")
    require(posixpath.normpath(path) == path, "parent_not_normalized")
    require(os.path.realpath(path) == path, "parent_not_canonical")
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for component in path.split("/"):
            if not component:
                continue
            before = os.stat(
                component, dir_fd=descriptor, follow_symlinks=False
            )
            require(stat.S_ISDIR(before.st_mode), "linked_parent_component")
            child = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            after = os.fstat(child)
            if not same_directory(before, after):
                os.close(child)
                raise RuntimeError("parent_component_changed")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def encode_token(parent, name, parent_value, directory_value):
    payload = {
        "directory_dev": directory_value.st_dev,
        "directory_ino": directory_value.st_ino,
        "name": name,
        "parent": parent,
        "path": parent.rstrip("/") + "/" + name,
        "parent_dev": parent_value.st_dev,
        "parent_ino": parent_value.st_ino,
        "uid": CURRENT_UID,
        "version": 1,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_token(encoded):
    require(encoded and all(value.isalnum() or value in "-_" for value in encoded),
            "invalid_token_encoding")
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    raw = base64.b64decode(
        encoded + padding, altchars=b"-_", validate=True
    )
    require(
        base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") == encoded,
        "noncanonical_token_encoding",
    )
    payload = json.loads(raw.decode("utf-8"))
    require(
        isinstance(payload, dict)
        and set(payload) == {
            "directory_dev",
            "directory_ino",
            "name",
            "parent",
            "path",
            "parent_dev",
            "parent_ino",
            "uid",
            "version",
        },
        "invalid_token_shape",
    )
    require(payload["version"] == 1, "invalid_token_version")
    require(payload["uid"] == CURRENT_UID, "token_owner_changed")
    for key in ("directory_dev", "directory_ino", "parent_dev", "parent_ino"):
        require(isinstance(payload[key], int) and payload[key] >= 0,
                "invalid_token_identity")
    require(
        isinstance(payload["parent"], str)
        and payload["parent"].startswith("/")
        and posixpath.normpath(payload["parent"]) == payload["parent"],
        "invalid_token_parent",
    )
    require(
        isinstance(payload["name"], str)
        and payload["name"] not in ("", ".", "..")
        and "/" not in payload["name"],
        "invalid_token_name",
    )
    require(
        isinstance(payload["path"], str)
        and payload["path"]
        == payload["parent"].rstrip("/") + "/" + payload["name"],
        "invalid_token_path",
    )
    return payload


def capture(parent, name):
    require(name not in ("", ".", "..") and "/" not in name,
            "invalid_directory_name")
    parent_fd = open_canonical_directory(parent)
    directory_fd = None
    try:
        parent_value = os.fstat(parent_fd)
        path_value = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        require(
            exact_private_directory(path_value, parent_value.st_dev),
            "directory_not_private",
        )
        directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        opened_value = os.fstat(directory_fd)
        require(same_directory(path_value, opened_value),
                "directory_changed_during_capture")
        print(encode_token(parent, name, parent_value, opened_value))
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        os.close(parent_fd)


def parse_allowlist(specifications):
    allowed = {}
    children = {"": {}}
    for specification in specifications:
        require(len(specification) >= 3 and specification[1] == ":",
                "invalid_allowlist_entry")
        expected_type = specification[0]
        relative = specification[2:]
        require(expected_type in ("d", "f"), "invalid_allowlist_type")
        require(
            relative
            and not relative.startswith("/")
            and posixpath.normpath(relative) == relative,
            "invalid_allowlist_path",
        )
        components = relative.split("/")
        require(
            all(
                component not in ("", ".", "..")
                and "\x00" not in component
                for component in components
            ),
            "invalid_allowlist_component",
        )
        require(relative not in allowed, "duplicate_allowlist_entry")
        allowed[relative] = expected_type
        parent = posixpath.dirname(relative)
        name = posixpath.basename(relative)
        children.setdefault(parent, {})[name] = expected_type
        if expected_type == "d":
            children.setdefault(relative, {})
    for relative in allowed:
        parent = posixpath.dirname(relative)
        if parent:
            require(allowed.get(parent) == "d", "missing_allowlisted_parent")
    return allowed, children


def cleanup(encoded, marker_relative, marker_value, specifications):
    token = decode_token(encoded)
    allowed, children = parse_allowlist(specifications)
    if marker_relative:
        require(allowed.get(marker_relative) == "f", "marker_not_allowlisted")
        require("\n" not in marker_value and "\x00" not in marker_value,
                "invalid_marker_value")
        expected_marker = (marker_value + "\n").encode("utf-8")
        require(len(expected_marker) <= 4096, "marker_too_large")
    else:
        require(marker_value == "", "marker_value_without_path")
        expected_marker = None

    parent_fd = open_canonical_directory(token["parent"])
    directory_fds = {}
    snapshots = {}
    try:
        parent_value = os.fstat(parent_fd)
        require(
            parent_value.st_dev == token["parent_dev"]
            and parent_value.st_ino == token["parent_ino"],
            "parent_identity_changed",
        )
        try:
            root_path_value = os.stat(
                token["name"], dir_fd=parent_fd, follow_symlinks=False
            )
        except FileNotFoundError:
            return
        require(
            exact_private_directory(root_path_value, token["directory_dev"])
            and root_path_value.st_ino == token["directory_ino"],
            "root_identity_changed",
        )
        root_fd = os.open(token["name"], DIRECTORY_FLAGS, dir_fd=parent_fd)
        directory_fds[""] = root_fd
        root_opened = os.fstat(root_fd)
        require(same_directory(root_path_value, root_opened),
                "opened_root_identity_changed")
        snapshots[""] = root_opened

        pending = [""]
        while pending:
            relative_directory = pending.pop()
            directory_fd = directory_fds[relative_directory]
            permitted_children = children.get(relative_directory, {})
            actual_names = sorted(os.listdir(directory_fd))
            require(
                all(name in permitted_children for name in actual_names),
                "unexpected_private_directory_entry",
            )
            for name in actual_names:
                relative = (
                    name
                    if not relative_directory
                    else relative_directory + "/" + name
                )
                expected_type = permitted_children[name]
                value = os.stat(name, dir_fd=directory_fd,
                                follow_symlinks=False)
                if expected_type == "f":
                    require(
                        exact_private_file(value, token["directory_dev"]),
                        "unsafe_private_file",
                    )
                    snapshots[relative] = value
                else:
                    require(
                        exact_private_directory(value, token["directory_dev"]),
                        "unsafe_private_subdirectory",
                    )
                    child_fd = os.open(name, DIRECTORY_FLAGS,
                                       dir_fd=directory_fd)
                    opened = os.fstat(child_fd)
                    if not same_directory(value, opened):
                        os.close(child_fd)
                        raise RuntimeError("private_subdirectory_changed")
                    directory_fds[relative] = child_fd
                    snapshots[relative] = opened
                    pending.append(relative)

        def verify_directory_binding(relative):
            if not relative:
                current = os.stat(token["name"], dir_fd=parent_fd,
                                  follow_symlinks=False)
                opened = os.fstat(directory_fds[""])
                require(same_directory(current, snapshots[""])
                        and same_directory(opened, snapshots[""]),
                        "root_binding_changed")
                return
            parent = posixpath.dirname(relative)
            name = posixpath.basename(relative)
            verify_directory_binding(parent)
            current = os.stat(name, dir_fd=directory_fds[parent],
                              follow_symlinks=False)
            opened = os.fstat(directory_fds[relative])
            require(same_directory(current, snapshots[relative])
                    and same_directory(opened, snapshots[relative]),
                    "subdirectory_binding_changed")

        if expected_marker is not None:
            marker_parent = posixpath.dirname(marker_relative)
            marker_name = posixpath.basename(marker_relative)
            require(marker_relative in snapshots, "required_marker_missing")
            verify_directory_binding(marker_parent)
            marker_fd = os.open(marker_name, FILE_FLAGS,
                                dir_fd=directory_fds[marker_parent])
            try:
                before = os.fstat(marker_fd)
                require(same_file(before, snapshots[marker_relative]),
                        "marker_changed_before_read")
                marker_bytes = os.read(marker_fd, len(expected_marker) + 1)
                after = os.fstat(marker_fd)
                require(same_file(before, after), "marker_changed_during_read")
                require(marker_bytes == expected_marker, "marker_value_changed")
                current = os.stat(marker_name,
                                  dir_fd=directory_fds[marker_parent],
                                  follow_symlinks=False)
                require(same_file(current, after), "marker_link_changed")
            finally:
                os.close(marker_fd)

        file_paths = sorted(
            (relative for relative, value in snapshots.items()
             if relative and stat.S_ISREG(value.st_mode)),
            key=lambda value: (value.count("/"), value),
            reverse=True,
        )
        for relative in file_paths:
            parent = posixpath.dirname(relative)
            name = posixpath.basename(relative)
            verify_directory_binding(parent)
            before = os.stat(name, dir_fd=directory_fds[parent],
                             follow_symlinks=False)
            require(same_file(before, snapshots[relative]),
                    "private_file_changed_before_unlink")
            descriptor = os.open(name, FILE_FLAGS, dir_fd=directory_fds[parent])
            try:
                opened = os.fstat(descriptor)
                require(same_file(before, opened),
                        "opened_private_file_changed")
                current = os.stat(name, dir_fd=directory_fds[parent],
                                  follow_symlinks=False)
                require(same_file(current, opened),
                        "private_file_link_changed")
                verify_directory_binding(parent)
                current = os.stat(name, dir_fd=directory_fds[parent],
                                  follow_symlinks=False)
                require(same_file(current, opened),
                        "private_file_changed_at_unlink")
                # Keep the exact O_NOFOLLOW descriptor live across unlink and
                # the parent fsync. POSIX still has no inode-CAS unlink, but no
                # additional pathname work widens the final checked boundary.
                os.unlink(name, dir_fd=directory_fds[parent])
                os.fsync(directory_fds[parent])
                try:
                    os.stat(name, dir_fd=directory_fds[parent],
                            follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise RuntimeError("private_file_name_reappeared")
            finally:
                os.close(descriptor)

        directory_paths = sorted(
            (relative for relative, value in snapshots.items() if relative
             and stat.S_ISDIR(value.st_mode)),
            key=lambda value: (value.count("/"), value),
            reverse=True,
        )
        for relative in directory_paths:
            parent = posixpath.dirname(relative)
            name = posixpath.basename(relative)
            require(not os.listdir(directory_fds[relative]),
                    "private_subdirectory_repopulated")
            verify_directory_binding(relative)
            os.rmdir(name, dir_fd=directory_fds[parent])
            os.fsync(directory_fds[parent])
            try:
                os.stat(name, dir_fd=directory_fds[parent],
                        follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise RuntimeError("private_subdirectory_name_reappeared")

        require(not os.listdir(directory_fds[""]),
                "private_root_repopulated")
        verify_directory_binding("")
        # There is no portable rmdir-by-inode. The still-open root fd plus the
        # immediately preceding parent lstat/fstat comparison are the strongest
        # portable cooperative proof. If rmdir fails, preserve the empty orphan.
        os.rmdir(token["name"], dir_fd=parent_fd)
        os.fsync(parent_fd)
        try:
            os.stat(token["name"], dir_fd=parent_fd,
                    follow_symlinks=False)
        except FileNotFoundError:
            return
        raise RuntimeError("private_root_name_reappeared")
    finally:
        for relative in sorted(directory_fds, key=lambda value: value.count("/"),
                               reverse=True):
            try:
                os.close(directory_fds[relative])
            except OSError:
                pass
        os.close(parent_fd)


def main():
    require(len(sys.argv) >= 2, "missing_mode")
    mode = sys.argv[1]
    if mode == "capture":
        require(len(sys.argv) == 4, "invalid_capture_arguments")
        capture(sys.argv[2], sys.argv[3])
    elif mode == "cleanup":
        require(len(sys.argv) >= 5, "invalid_cleanup_arguments")
        cleanup(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    else:
        raise RuntimeError("invalid_mode")


try:
    main()
except BaseException as error:
    print(f"private directory operation failed closed: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
}

recovery_capture_private_directory_token() {
  local directory="$1" parent base canonical_parent
  [[ "$directory" == /* ]] || return 2
  parent="$(dirname "$directory")"
  base="$(basename "$directory")"
  [[ "$base" != "." && "$base" != ".." && "$base" != */* ]] || return 2
  # Resolve macOS' stable /var -> /private/var alias before rejecting links.
  canonical_parent="$(cd "$parent" 2>/dev/null && pwd -P)" || return 1
  recovery_private_directory_tool capture "$canonical_parent" "$base"
}

recovery_cleanup_private_directory() {
  local token="$1"
  shift
  [[ -n "$token" ]] || return 2
  recovery_private_directory_tool cleanup "$token" "" "" "$@"
}

recovery_cleanup_marked_private_directory() {
  local token="$1" marker_relative="$2" marker_value="$3"
  shift 3
  [[ -n "$token" && -n "$marker_relative" ]] || return 2
  recovery_private_directory_tool cleanup \
    "$token" "$marker_relative" "$marker_value" "$@"
}

recovery_require_regular_direct_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || return 1
  ! recovery_path_has_symlink_component "$path"
}

recovery_checkpoint_artifacts() {
  local stamp="$1"
  local metadata_schema="${2:-3}"
  [[ "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ ]] || return 2
  recovery_checkpoint_snapshot_artifacts "$metadata_schema"
  printf 'retdb-%s.sql.gz\nret-storage-%s.tar.gz\n' "$stamp" "$stamp"
}

recovery_freeze_bundle_artifacts() {
  local stamp="$1"
  [[ "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ ]] || return 2
  printf '%s\n' \
    checkpoint-metadata.json \
    database-contract.json \
    deployment-images.json \
    external-config-redacted.json \
    git-state.json \
    infrastructure-recipe.json \
    "retdb-$stamp.sql.gz" \
    "ret-storage-$stamp.tar.gz"
}

recovery_freeze_bundle_metadata_is_acceptable() {
  local metadata_path="$1" expected_stamp="$2"
  recovery_require_regular_direct_file "$metadata_path" || return 1
  jq -e --arg stamp "$expected_stamp" '
    def utc: type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def identity($kind):
      type == "object" and
      (keys | sort) == (["name", "uid"] +
        (if $kind == "cluster" then [] else [] end)) and
      (.name | type == "string" and length > 0) and
      (.uid | type == "string" and length > 0);
    def payload($name):
      type == "object" and
      (keys | sort) == ["filename", "sha256", "size_bytes"] and
      .filename == $name and
      (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
      (.size_bytes | type == "number" and floor == . and . > 0);
    type == "object" and
    (keys | sort) == [
      "client_instance_id", "created_at_utc", "freeze_id",
      "minimum_restore_version", "operation", "payloads",
      "provenance", "publication_state", "runner_mode", "runtime_generation",
      "schema", "source", "stamp"
    ] and
    .schema == "freeze-bundle-v1" and .stamp == $stamp and
    (.client_instance_id | type == "string" and
      test("^[a-z0-9][a-z0-9-]{2,62}$")) and
    (.freeze_id | type == "string" and test("^[a-f0-9]{32}$")) and
    (.created_at_utc | utc) and
    .minimum_restore_version == 1 and
    .publication_state == "complete" and
    .runtime_generation == "legacy-absent" and .runner_mode == "process-local" and
    (.source | type == "object" and
      (keys | sort) == ["cluster", "kube_context", "namespace", "pvc"] and
      (.kube_context | type == "string" and length > 0) and
      (.cluster | identity("cluster")) and
      (.namespace | identity("namespace")) and
      (.pvc | identity("pvc"))) and
    (.operation | type == "object" and
      (keys | sort) == ["id", "quiescence"] and
      .id == .id and (.id | type == "string" and test("^[a-f0-9]{32}$")) and
      (.quiescence | type == "object" and
        (keys | sort) == ["completed_at_utc", "started_at_utc"] and
        (.started_at_utc | utc) and (.completed_at_utc | utc) and
        .completed_at_utc >= .started_at_utc)) and
    .operation.id == .freeze_id and
    (.payloads | type == "object" and (keys | sort) == ["database", "storage"] and
      (.database | payload("retdb-" + $stamp + ".sql.gz")) and
      (.storage | payload("ret-storage-" + $stamp + ".tar.gz"))) and
    .provenance == {
      generator:"yenhubs-freeze-bundle-v1",
      external_import:false
    }
  ' "$metadata_path" >/dev/null
}

recovery_freeze_bundle_git_state_is_acceptable() {
  local path="$1"
  recovery_require_regular_direct_file "$path" || return 1
  jq -e '
    def commit: type == "string" and test("^[a-f0-9]{40}$");
    type == "object" and
    (keys | sort) == ["accepted_releases", "captured_at_utc", "gitlinks",
      "repositories", "schema"] and
    .schema == "freeze-git-state-v1" and
    (.captured_at_utc | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.repositories | keys | sort) == ["hubs", "hubs_cloud", "root"] and
    all(.repositories[]; (keys | sort) == ["commit"] and (.commit | commit)) and
    (.gitlinks | keys | sort) == ["hubs", "hubs_cloud"] and
    (.gitlinks.hubs | commit) and (.gitlinks.hubs_cloud | commit) and
    .gitlinks.hubs == .repositories.hubs.commit and
    .gitlinks.hubs_cloud == .repositories.hubs_cloud.commit and
    .accepted_releases == {hubs:"prod-2026-03-11",hubs_ce:"2.1.0"}
  ' "$path" >/dev/null
}

recovery_freeze_bundle_external_config_is_acceptable() {
  local path="$1"
  recovery_require_regular_direct_file "$path" || return 1
  jq -e '
    def text: type == "string" and length > 0;
    def key_name: type == "string" and test("^[A-Z][A-Z0-9_]+$");
    type == "object" and
    (keys | sort) == ["configured_presence", "dns", "functional_ids", "images",
      "responsibility", "schema", "smtp"] and
    .schema == "freeze-external-config-v1" and
    (.dns | type == "object" and (keys | sort) == ["domain", "provider", "records"] and
      (.domain | text) and (.provider | text) and
      (.records | type == "array" and length == 4 and
       ([.[]] | unique | length) == 4 and all(.[]; text))) and
    (.smtp | type == "object" and
      (keys | sort) == ["host_configured", "password_configured", "port_configured",
        "provider", "user_configured"] and
      (.provider | text) and
      all(.host_configured, .password_configured, .port_configured,
        .user_configured; type == "boolean")) and
    (.functional_ids | type == "object" and
      (keys | sort) == ["room", "scene", "spoke_project"] and
      all(.[]; text)) and
    (.images | type == "object" and (keys | sort) == ["repositories"] and
      (.repositories | type == "array" and length == 12 and
       ([.[]] | unique | length) == 12 and all(.[]; text))) and
    (.configured_presence | type == "object" and length > 0 and
      all(keys[]; key_name) and all(.[]; type == "boolean")) and
    (.responsibility | type == "object" and
      (keys | sort) == ["dns", "operations", "registry", "smtp"] and
      all(.[]; text))
  ' "$path" >/dev/null
}

recovery_freeze_bundle_infrastructure_recipe_is_acceptable() {
  local path="$1"
  recovery_require_regular_direct_file "$path" || return 1
  jq -e '
    def text: type == "string" and length > 0;
    def utc: type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    type == "object" and
    (keys | sort) == ["apply_order", "cert_manager", "cluster", "cost_gate",
      "ingress", "load_balancer", "namespace", "provider", "region", "schema",
      "storage", "topology"] and
    .schema == "freeze-infrastructure-recipe-v1" and
    .provider == "digitalocean" and (.region | text) and (.namespace | text) and
    (.cluster | type == "object" and
      (keys | sort) == ["ha_control_plane", "name", "node_pools"] and
      .ha_control_plane == false and (.name | text) and
      (.node_pools | type == "array" and length > 0 and all(.[];
        (keys | sort) == ["count", "size"] and (.size | text) and
        (.count | type == "number" and floor == . and . > 0)))) and
    (.storage | type == "object" and
      (keys | sort) == ["class", "persistent_volume_claims"] and
      (.class | text) and
      (.persistent_volume_claims | type == "array" and length == 2 and
       ([.[].name] | sort) == ["pgsql-pvc", "ret-pvc"] and all(.[];
         (keys | sort) == ["name", "size"] and (.size | text)))) and
    .load_balancer == {count:1,type:"REGIONAL_NETWORK"} and
    (.ingress | text) and (.cert_manager | text) and
    .topology == "single-region-low-cost" and
    .apply_order == ["infrastructure", "cert-manager", "ingress",
      "generated-manifest", "restore", "live-verification"] and
    (.cost_gate | type == "object" and
      (keys | sort) == ["checked_at_utc", "estimated_monthly_usd",
        "result"] and (.checked_at_utc | utc) and
      (.estimated_monthly_usd | type == "number" and . >= 0) and
      .result == "approval-required-before-create")
  ' "$path" >/dev/null
}

recovery_validate_freeze_bundle_layout() {
  local directory="$1" stamp="$2" actual expected artifact
  if [[ ! -d "$directory" || -L "$directory" ]] ||
     recovery_path_has_symlink_component "$directory"; then
    printf 'Freeze bundle directory is missing, linked or not a directory.\n' >&2
    return 1
  fi
  expected="$({ recovery_freeze_bundle_artifacts "$stamp"; printf 'SHA256SUMS\n'; } |
    LC_ALL=C sort)" || return 1
  actual="$(find "$directory" -mindepth 1 -maxdepth 1 -print |
    while IFS= read -r artifact; do basename "$artifact"; done | LC_ALL=C sort)" || return 1
  [[ "$actual" == "$expected" ]] || {
    printf 'Freeze bundle does not contain the exact nine-file artifact set.\n' >&2
    return 1
  }
  while IFS= read -r artifact; do
    recovery_require_regular_direct_file "$directory/$artifact" || {
      printf 'Freeze bundle artifact is missing, empty, linked or non-regular: %s.\n' \
        "$artifact" >&2
      return 1
    }
  done <<<"$expected"
}

recovery_validate_freeze_bundle_manifest() {
  local directory="$1" stamp="$2" manifest
  local expected_names manifest_names line artifact expected_digest actual_digest
  manifest="$directory/SHA256SUMS"
  recovery_require_regular_direct_file "$manifest" || return 1
  expected_names="$(recovery_freeze_bundle_artifacts "$stamp" | LC_ALL=C sort)" || return 1
  manifest_names="$(awk '
    BEGIN { failed=0; count=0 }
    $0 !~ /^[a-f0-9]{64}  [A-Za-z0-9][A-Za-z0-9._-]*$/ { failed=1; next }
    { name=substr($0,67); if (seen[name]++) failed=1; names[++count]=name }
    END {
      if (failed || count != 8) exit 2
      for (item_index=1; item_index<=count; item_index++) print names[item_index]
    }
  ' "$manifest")" || {
    printf 'Freeze bundle SHA256SUMS is malformed or duplicated.\n' >&2
    return 1
  }
  [[ "$(printf '%s\n' "$manifest_names" | LC_ALL=C sort)" == "$expected_names" ]] || {
    printf 'Freeze bundle SHA256SUMS does not cover exactly the other eight files.\n' >&2
    return 1
  }
  while IFS= read -r line; do
    expected_digest="${line:0:64}"
    artifact="${line:66}"
    actual_digest="$(recovery_sha256_digest "$directory/$artifact")" || return 1
    [[ "$actual_digest" == "$expected_digest" ]] || {
      printf 'Freeze bundle SHA256 verification failed for %s.\n' "$artifact" >&2
      return 1
    }
  done <"$manifest"
}

recovery_verify_freeze_bundle_contents() {
  local directory="$1" stamp="$2" metadata
  local dump_digest storage_digest dump_size storage_size
  metadata="$directory/checkpoint-metadata.json"
  recovery_validate_freeze_bundle_manifest "$directory" "$stamp" &&
    recovery_freeze_bundle_metadata_is_acceptable "$metadata" "$stamp" &&
    recovery_checkpoint_deployment_inventory_is_acceptable \
      "$directory/deployment-images.json" "$(jq -er '.source.namespace.name' "$metadata")" &&
    jq -e --slurpfile metadata "$metadata" '
      ($metadata | length) == 1 and
      .namespace == $metadata[0].source.namespace.name and
      .namespace_uid == $metadata[0].source.namespace.uid
    ' "$directory/deployment-images.json" >/dev/null &&
    jq -e '.schema_version == 4 and
      .bot_runner_runtime == {generation:"legacy-absent",mode:"process-local",
        image:null,control_plane:{state:"legacy-absent"},
        recovery_epoch:{state:"legacy-absent"}}' \
      "$directory/deployment-images.json" >/dev/null &&
    recovery_freeze_bundle_git_state_is_acceptable "$directory/git-state.json" &&
    recovery_freeze_bundle_external_config_is_acceptable \
      "$directory/external-config-redacted.json" &&
    recovery_freeze_bundle_infrastructure_recipe_is_acceptable \
      "$directory/infrastructure-recipe.json" || return 1
  dump_digest="$(recovery_sha256_digest "$directory/retdb-$stamp.sql.gz")" || return 1
  storage_digest="$(recovery_sha256_digest "$directory/ret-storage-$stamp.tar.gz")" || return 1
  dump_size="$(recovery_file_size_bytes "$directory/retdb-$stamp.sql.gz")" || return 1
  storage_size="$(recovery_file_size_bytes "$directory/ret-storage-$stamp.tar.gz")" || return 1
  jq -e --arg dump_digest "$dump_digest" --arg storage_digest "$storage_digest" \
    --argjson dump_size "$dump_size" --argjson storage_size "$storage_size" '
      .payloads.database.sha256 == $dump_digest and
      .payloads.database.size_bytes == $dump_size and
      .payloads.storage.sha256 == $storage_digest and
      .payloads.storage.size_bytes == $storage_size
    ' "$metadata" >/dev/null
}

recovery_verify_freeze_bundle_directory() {
  local directory="$1" stamp="$2"
  recovery_validate_freeze_bundle_layout "$directory" "$stamp" &&
    recovery_verify_freeze_bundle_contents "$directory" "$stamp"
}

recovery_freeze_bundle_receipt_is_acceptable() {
  local receipt_path="$1" bundle_directory="$2" metadata inventory
  local manifest_digest
  recovery_require_regular_direct_file "$receipt_path" || return 1
  [[ -d "$bundle_directory" && ! -L "$bundle_directory" ]] || return 1
  metadata="$bundle_directory/checkpoint-metadata.json"
  inventory="$bundle_directory/deployment-images.json"
  recovery_require_regular_direct_file "$metadata" &&
    recovery_require_regular_direct_file "$inventory" || return 1
  manifest_digest="$(recovery_sha256_digest "$bundle_directory/SHA256SUMS")" || return 1
  jq -e --arg manifest_digest "$manifest_digest" \
    --slurpfile metadata "$metadata" --slurpfile inventory "$inventory" '
    def utc: type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def reference: type == "string" and
      test("^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$");
    ($metadata | length) == 1 and ($inventory | length) == 1 and
    ($metadata[0]) as $meta | ($inventory[0]) as $images |
    type == "object" and
    (keys | sort) == ["client_instance_id", "copies", "credential_set_reference",
      "freeze_id", "image_custody", "key_escrow_reference", "responsible",
      "schema", "sha256sums_sha256", "verified_at_utc"] and
    .schema == "freeze-bundle-receipt-v1" and
    .client_instance_id == $meta.client_instance_id and .freeze_id == $meta.freeze_id and
    .sha256sums_sha256 == $manifest_digest and (.verified_at_utc | utc) and
    (.key_escrow_reference | reference) and
    (.credential_set_reference | reference) and (.responsible | reference) and
    (.copies | type == "array" and length == 2 and
      ([.[].reference] | unique | length) == 2 and all(.[];
        (keys | sort) == ["decrypt_rehash", "reference", "verified_at_utc"] and
        (.reference | reference) and .decrypt_rehash == "passed" and
        (.verified_at_utc | utc))) and
    ([ $images.deployments[] as $deployment | $deployment.containers[] |
      {pair:($deployment.name + "/" + .name),image:.image}] | sort_by(.pair)) as $expected |
    (.image_custody | type == "array" and length == 13 and
      ([.[].pair] | unique | length) == 13 and
      ([.[] | {pair,image}] | sort_by(.pair)) == $expected and
      all(.[];
        (keys | sort) == ["image", "pair", "reference", "restore_probe",
          "verified_at_utc"] and
        (.pair | type == "string" and length > 0) and
        (.image | type == "string" and test("@sha256:[a-f0-9]{64}$")) and
        (.reference | reference) and .restore_probe == "passed" and
        (.verified_at_utc | utc)))
  ' "$receipt_path" >/dev/null
}

recovery_checkpoint_stamp_from_artifact() {
  local name
  name="$(basename "$1")"
  if [[ "$name" =~ ^retdb-([0-9]{8}-[0-9]{6})\.sql\.gz$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^ret-storage-([0-9]{8}-[0-9]{6})\.tar\.gz$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

recovery_validate_checkpoint_layout() {
  local directory="$1"
  local stamp="$2"
  local metadata_schema="${3:-}"
  local expected_names actual_names artifact
  if [[ ! -d "$directory" || -L "$directory" ]] ||
     recovery_path_has_symlink_component "$directory"; then
    printf 'Checkpoint directory is missing, linked or not a directory.\n' >&2
    return 1
  fi
  if [[ -z "$metadata_schema" ]]; then
    metadata_schema="$(recovery_checkpoint_metadata_schema "$directory")" || {
      printf 'Checkpoint metadata schema is missing or unsupported.\n' >&2
      return 1
    }
  elif [[ "$metadata_schema" != 2 && "$metadata_schema" != 3 ]]; then
    printf 'Checkpoint metadata schema is missing or unsupported.\n' >&2
    return 1
  fi
  if ! expected_names="$({ recovery_checkpoint_artifacts "$stamp" "$metadata_schema"; printf 'SHA256SUMS\n'; } | LC_ALL=C sort)"; then
    printf 'Checkpoint stamp is invalid.\n' >&2
    return 1
  fi
  if ! actual_names="$(
    find "$directory" -mindepth 1 -maxdepth 1 -print |
      while IFS= read -r artifact; do basename "$artifact"; done |
      LC_ALL=C sort
  )"; then
    printf 'Could not enumerate checkpoint artifacts.\n' >&2
    return 1
  fi
  if [[ "$actual_names" != "$expected_names" ]]; then
    printf 'Checkpoint directory does not contain the exact allowlisted artifact set.\n' >&2
    return 1
  fi
  while IFS= read -r artifact; do
    if ! recovery_require_regular_direct_file "$directory/$artifact"; then
      printf 'Checkpoint artifact is missing, empty, linked or non-regular: %s.\n' "$artifact" >&2
      return 1
    fi
  done <<<"$expected_names"
}

recovery_validate_sha256_manifest() {
  local directory="$1"
  local stamp="$2"
  local metadata_schema="${3:-}"
  local manifest="$directory/SHA256SUMS"
  local expected_names manifest_names line expected_digest artifact actual_digest
  recovery_require_regular_direct_file "$manifest" || {
    printf 'A regular non-empty SHA256SUMS manifest is required.\n' >&2
    return 1
  }
  if [[ -z "$metadata_schema" ]]; then
    metadata_schema="$(recovery_checkpoint_metadata_schema "$directory")" || {
      printf 'Checkpoint metadata schema is missing or unsupported.\n' >&2
      return 1
    }
  elif [[ "$metadata_schema" != 2 && "$metadata_schema" != 3 ]]; then
    printf 'Checkpoint metadata schema is missing or unsupported.\n' >&2
    return 1
  fi
  if ! expected_names="$(recovery_checkpoint_artifacts "$stamp" "$metadata_schema" | LC_ALL=C sort)"; then
    printf 'Checkpoint stamp is invalid.\n' >&2
    return 1
  fi
  if ! manifest_names="$(awk '
    BEGIN { failed=0; count=0 }
    {
      if ($0 !~ /^[a-fA-F0-9]{64}  [A-Za-z0-9][A-Za-z0-9._-]*$/) {
        failed=1
        next
      }
      name=substr($0, 67)
      if (seen[name]++) {
        failed=1
        next
      }
      names[++count]=name
    }
    END {
      if (failed || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print names[item_index]
    }
  ' "$manifest")"; then
    printf 'SHA256SUMS is malformed or contains duplicate/prefixed names.\n' >&2
    return 1
  fi
  manifest_names="$(printf '%s\n' "$manifest_names" | LC_ALL=C sort)"
  if [[ "$manifest_names" != "$expected_names" ]]; then
    printf 'SHA256SUMS does not contain the exact checkpoint artifact set.\n' >&2
    return 1
  fi
  while IFS= read -r line; do
    expected_digest="${line:0:64}"
    artifact="${line:66}"
    if ! recovery_require_regular_direct_file "$directory/$artifact"; then
      printf 'SHA256SUMS references a missing, non-regular or linked artifact.\n' >&2
      return 1
    fi
    if ! actual_digest="$(recovery_sha256_digest "$directory/$artifact")"; then
      printf 'Could not hash checkpoint artifact %s.\n' "$artifact" >&2
      return 1
    fi
    if [[ "$actual_digest" != "$expected_digest" ]]; then
      printf 'SHA256SUMS verification failed for %s.\n' "$artifact" >&2
      return 1
    fi
  done <"$manifest"
}

recovery_checkpoint_metadata_is_acceptable() {
  local metadata_path="$1"
  local expected_stamp="$2"
  recovery_require_regular_direct_file "$metadata_path" || return 1
  jq -e --arg stamp "$expected_stamp" '
    type == "object" and
    .schema_version as $schema |
    (($schema == 2 and
      (keys | sort) == [
        "created_at_epoch", "created_at_utc", "kube_context", "namespace",
        "namespace_uid", "operation_id", "provenance", "ret_pvc_uid",
        "schema_version", "stamp", "writer_quiescence"
      ] and
      .provenance == {
        generator:"yenhubs-local-coordinated-checkpoint-v2",
        external_import:false
      }) or
     ($schema == 3 and
      (keys | sort) == [
        "created_at_epoch", "created_at_utc", "kube_context", "namespace",
        "namespace_uid", "operation_id", "provenance", "ret_pvc_uid",
        "runner_cutover_evidence_sha256", "runtime_generation",
        "schema_version", "stamp", "writer_quiescence"
      ] and
      .provenance == {
        generator:"yenhubs-local-coordinated-checkpoint-v3",
        external_import:false
      } and
      (.runtime_generation == "legacy-absent" or
       .runtime_generation == "durable-v2") and
      (.runner_cutover_evidence_sha256 | type == "string" and
       test("^[a-fA-F0-9]{64}$")))) and
    .stamp == $stamp and
    (.created_at_utc | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.created_at_epoch | type == "number" and floor == . and . > 0) and
    (.kube_context | type == "string" and length > 0) and
    (.namespace | type == "string" and length > 0) and
    (.namespace_uid | type == "string" and length > 0) and
    (.ret_pvc_uid | type == "string" and length > 0) and
    (.operation_id | type == "string" and test("^[a-f0-9]{32}$")) and
    (.writer_quiescence | keys | sort) ==
      ["completed_at_utc", "required", "started_at_utc"] and
    .writer_quiescence.required == true and
    (.writer_quiescence.started_at_utc | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.writer_quiescence.completed_at_utc | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    .writer_quiescence.completed_at_utc >= .writer_quiescence.started_at_utc
  ' "$metadata_path" >/dev/null
}

recovery_runner_cutover_evidence_is_acceptable() {
  local evidence_path="$1" helper
  recovery_require_regular_direct_file "$evidence_path" || return 1
  jq -e '
    type == "object" and
    (keys | sort) == [
      "admission", "capture_window", "checkpoint_operation_id", "cluster",
      "control_plane", "journal", "namespaces", "parent_deployment", "quiescence",
      "recovery_operation_fence_state", "runner_role", "runner_role_binding",
      "runtime_generation", "schema_version"
    ] and
    .schema_version == 3 and
    (.checkpoint_operation_id | type == "string" and test("^[a-f0-9]{32}$")) and
    (.runtime_generation == "legacy-absent" or .runtime_generation == "durable-v2") and
    (.recovery_operation_fence_state == "dormant" or
      .recovery_operation_fence_state == "active") and
    (.capture_window | type == "object" and
      (keys | sort) == ["completed_at_utc", "started_at_utc"] and
      all(.started_at_utc, .completed_at_utc;
        type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$")) and
      .completed_at_utc >= .started_at_utc) and
    (.cluster | type == "object" and
      (keys | sort) == ["anchor", "kube_context"] and
      (.kube_context | type == "string" and length > 0) and
      (.anchor | type == "object" and
       (keys | sort) == ["api_version", "kind", "name", "uid"] and
       .api_version == "v1" and .kind == "Namespace" and
       .name == "kube-system" and (.uid | type == "string" and length > 0))) and
    (.namespaces | type == "object" and
      (keys | sort) == ["parent", "runner"] and
      (.parent | type == "object" and
       (keys | sort) == [
         "api_version", "kind", "name", "resource_version", "terminating", "uid"
       ] and
       .api_version == "v1" and .kind == "Namespace" and
       (.name | type == "string" and length > 0) and
       (.uid | type == "string" and length > 0) and
       (.resource_version | type == "string" and length > 0) and
       .terminating == false)) and
    (.parent_deployment | type == "object" and
      (.uid | type == "string" and length > 0) and
      (.resource_version | type == "string" and length > 0) and
      (.replicas | type == "number" and floor == . and . >= 0) and
      (.spec_sha256 | type == "string" and test("^[a-f0-9]{64}$"))) and
    (.quiescence | type == "object" and
      (keys | sort) == ["fences", "intents", "runners"] and
      .runners == 0 and .intents == 0 and (.fences | type == "array")) and
    if .runtime_generation == "legacy-absent" then
      .recovery_operation_fence_state == "dormant" and
      .namespaces.runner == null and
      .runner_role == null and .runner_role_binding == null and
      .control_plane == {state:"legacy-absent"} and
      .journal.state == "absent" and .journal.absence_verified == true and
      .admission.state == "absent" and .quiescence.fences == []
    else
      (.namespaces.runner as $runner |
       ($runner | type) == "object" and
       $runner.api_version == "v1" and
       $runner.kind == "Namespace" and
       $runner.name == "hcce-bot-runners" and
       ($runner.uid | type == "string" and length > 0) and
       ($runner.resource_version | type == "string" and length > 0) and
       $runner.terminating == false) and
      (.runner_role | type == "object" and
       (keys | sort) == [
         "api_version", "contract_sha256", "inert_contract_sha256", "kind",
         "name", "namespace", "resource_version", "terminating", "uid"
       ] and
       .api_version == "rbac.authorization.k8s.io/v1" and
       .kind == "Role" and .name == "bot-orchestrator-runner-pods" and
       .namespace == "hcce-bot-runners" and
       (.uid | type == "string" and length > 0) and
       (.resource_version | type == "string" and length > 0) and
       (.contract_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
       (.inert_contract_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
       .terminating == false) and
      (.runner_role_binding | type == "object" and
       (keys | sort) == [
         "api_version", "contract_sha256", "kind", "name", "namespace",
         "resource_version", "terminating", "uid"
       ] and
       .api_version == "rbac.authorization.k8s.io/v1" and
       .kind == "RoleBinding" and
       .name == "bot-orchestrator-runner-pods" and
       .namespace == "hcce-bot-runners" and
       (.uid | type == "string" and length > 0) and
       (.resource_version | type == "string" and length > 0) and
       (.contract_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
       .terminating == false) and
      (.control_plane | type == "object" and
       (keys | sort) == [
         "cluster_resources", "namespaced_resources", "namespaces", "state"
       ] and .state == "present" and
       (.namespaces | type == "array" and length == 2 and
        all(.[];
          (keys | sort) == [
            "api_version", "contract_sha256", "kind", "name",
            "resource_version", "terminating", "uid"
          ] and
          (.api_version | type == "string" and length > 0) and
          (.kind | type == "string" and length > 0) and
          (.name | type == "string" and length > 0) and
          (.uid | type == "string" and length > 0) and
          (.resource_version | type == "string" and length > 0) and
          (.contract_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
          .terminating == false)) and
       (.namespaced_resources | type == "array" and length == 13 and
        all(.[];
          if .api_version == "v1" and .kind == "Secret" and
             .namespace == "hcce-bot-runners" and .name == "bot-images-pull"
          then
            (keys | sort) == [
              "api_version", "contract_hmac_sha256", "kind", "name", "namespace",
              "resource_version", "terminating", "uid"
            ] and
            (.contract_hmac_sha256 | type == "string" and test("^[a-f0-9]{64}$"))
          else
            (keys | sort) == [
              "api_version", "contract_sha256", "kind", "name", "namespace",
              "resource_version", "terminating", "uid"
            ] and
            (.contract_sha256 | type == "string" and test("^[a-f0-9]{64}$"))
          end and
          (.api_version | type == "string" and length > 0) and
          (.kind | type == "string" and length > 0) and
          (.name | type == "string" and length > 0) and
          (.namespace | type == "string" and length > 0) and
          (.uid | type == "string" and length > 0) and
          (.resource_version | type == "string" and length > 0) and
          .terminating == false)) and
       (.cluster_resources | type == "array" and length == 10 and
        all(.[];
          (keys | sort) == [
            "api_version", "contract_sha256", "kind", "name",
            "resource_version", "terminating", "uid"
          ] and
          (.api_version | type == "string" and length > 0) and
          (.kind | type == "string" and length > 0) and
          (.name | type == "string" and length > 0) and
          (.uid | type == "string" and length > 0) and
          (.resource_version | type == "string" and length > 0) and
          (.contract_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
          .terminating == false))) and
      .journal.state == "present" and
      (.journal.canonical_json | type == "string" and length > 0) and
      (.journal.canonical_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
      .journal.hmac_verification == "verified-owner-key" and
      .admission.state == "present"
    end
  ' "$evidence_path" >/dev/null || return 1
  # The Node envelope validator is the canonical exact-contract authority. It
  # additionally enforces the unique, sorted 2/13/10 identity sets, the single
  # HMAC-protected pull Secret, all admission/journal links and the exact
  # legacy envelope. Keep this evidence-only entry point independent of the
  # deployment inventory so callers cannot accidentally rely on shape alone.
  helper="$(recovery_runner_checkpoint_helper_path)" || return 1
  command node "$helper" validate-evidence --evidence "$evidence_path"
}

recovery_checkpoint_generation_is_acceptable() {
  local directory="$1" metadata_schema metadata_path inventory_path evidence_path
  local evidence_digest
  metadata_path="$directory/checkpoint-metadata.json"
  inventory_path="$directory/deployment-images.json"
  evidence_path="$directory/runner-cutover-evidence.json"
  metadata_schema="$(recovery_checkpoint_metadata_schema "$directory")" || return 1
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$(jq -er '.namespace' "$metadata_path")" || return 1
  if [[ "$metadata_schema" == 2 ]]; then
    jq -e '
      .schema_version == 3 and
      .bot_runner_runtime.mode == "process-local" and
      .bot_runner_runtime.control_plane == {state:"legacy-absent"} and
      .bot_runner_runtime.recovery_epoch == {state:"legacy-absent"}
    ' "$inventory_path" >/dev/null || return 1
    [[ ! -e "$evidence_path" && ! -L "$evidence_path" ]]
    return
  fi
  recovery_runner_cutover_evidence_is_acceptable "$evidence_path" || return 1
  recovery_validate_runner_cutover_evidence_offline \
    "$evidence_path" "$inventory_path" || return 1
  evidence_digest="$(recovery_sha256_digest "$evidence_path")" || return 1
  jq -e --arg digest "$evidence_digest" \
    --slurpfile inventory "$inventory_path" --slurpfile evidence "$evidence_path" '
    .schema_version == 3 and
    .runner_cutover_evidence_sha256 == $digest and
    ($inventory | length) == 1 and ($evidence | length) == 1 and
    $inventory[0].schema_version == 4 and
    .runtime_generation == $inventory[0].bot_runner_runtime.generation and
    .runtime_generation == $evidence[0].runtime_generation and
    .operation_id == $evidence[0].checkpoint_operation_id and
    .kube_context == $evidence[0].cluster.kube_context and
    .namespace == $evidence[0].namespaces.parent.name and
    .namespace_uid == $evidence[0].namespaces.parent.uid and
    .namespace_uid == $inventory[0].namespace_uid and
    .namespace == $inventory[0].namespace and
    ([ $inventory[0].deployments[] |
       select(.name == "bot-orchestrator") | .uid ] ==
     [$evidence[0].parent_deployment.uid]) and
    ((.runtime_generation == "legacy-absent" and
      $inventory[0].bot_runner_runtime.mode == "process-local") or
     (.runtime_generation == "durable-v2" and
      $inventory[0].bot_runner_runtime.mode == "kubernetes-pod"))
  ' "$metadata_path" >/dev/null
}

recovery_verify_checkpoint_directory() {
  local directory="$1"
  local stamp="$2"
  recovery_validate_checkpoint_layout "$directory" "$stamp" &&
    recovery_validate_sha256_manifest "$directory" "$stamp" &&
    recovery_checkpoint_metadata_is_acceptable \
      "$directory/checkpoint-metadata.json" "$stamp" &&
    recovery_checkpoint_generation_is_acceptable "$directory"
}

recovery_checkpoint_digest_for() {
  local directory="$1"
  local artifact="$2"
  awk -v artifact="$artifact" '
    BEGIN { found=0; digest="" }
    $0 ~ /^[a-fA-F0-9]{64}  [A-Za-z0-9][A-Za-z0-9._-]*$/ && substr($0, 67) == artifact {
      found++
      digest=substr($0, 1, 64)
    }
    END {
      if (found != 1) exit 2
      print digest
    }
  ' "$directory/SHA256SUMS"
}

recovery_database_contract_sql() {
  cat <<'SQL'
select jsonb_build_object(
  'schema_version', 2,
  'sql_dump_sha256', null,
  'provenance', jsonb_build_object(
    'baseline', 'yenhubs-reticulum-pre-sitting-2026-07',
    'compatible_with', jsonb_build_array('pre-sitting-2026-07', 'sitting-candidate-2026-07'),
    'minimum_relation_count', 356,
    'minimum_migration_count', 94,
    'minimum_hubs_count', 17
  ),
  'schemas', (
    select coalesce(jsonb_agg(nspname order by nspname), '[]'::jsonb)
    from pg_namespace where nspname in ('coturn', 'ret0', 'ret0_admin')
  ),
  'relations', (
    select coalesce(jsonb_agg(
      jsonb_build_object('schema', table_schema, 'name', table_name, 'type', table_type)
      order by table_schema, table_name
    ), '[]'::jsonb)
    from information_schema.tables
    where table_schema in ('coturn', 'ret0', 'ret0_admin')
  ),
  'migration_versions', (
    select coalesce(jsonb_agg(version::text order by version), '[]'::jsonb)
    from ret0.schema_migrations
  ),
  'critical_inventory', jsonb_build_object(
    'hub_sids', (
      select coalesce(jsonb_agg(hub_sid::text order by hub_sid), '[]'::jsonb)
      from ret0.hubs
    ),
    'owned_files', (
      select coalesce(jsonb_agg(
        jsonb_build_object('uuid', owned_file_uuid::text, 'state', state::text)
        order by owned_file_uuid
      ), '[]'::jsonb)
      from ret0.owned_files
    ),
    'active_owned_file_uuids', (
      select coalesce(jsonb_agg(owned_file_uuid::text order by owned_file_uuid), '[]'::jsonb)
      from ret0.owned_files where state::text = 'active'
    )
  ),
  'critical_counts', jsonb_build_object(
    'relations', (select count(*) from information_schema.tables where table_schema in ('coturn', 'ret0', 'ret0_admin')),
    'migrations', (select count(*) from ret0.schema_migrations),
    'hubs', (select count(*) from ret0.hubs),
    'owned_files', (select count(*) from ret0.owned_files),
    'active_owned_files', (select count(*) from ret0.owned_files where state::text = 'active')
  )
)::text;
SQL
}

recovery_database_contract_is_acceptable() {
  local contract_path="$1"
  # External checkpoint artifacts are checked with
  # recovery_require_regular_direct_file before this parser is reached. Live
  # snapshots can reside below macOS' canonical /private/var path while
  # mktemp reports the /var alias, so require a direct regular file here but do
  # not reject that operating-system path alias a second time.
  [[ -f "$contract_path" && ! -L "$contract_path" && -s "$contract_path" ]] || return 1
  jq -e '
    type == "object" and
    (keys | sort) == ["critical_counts", "critical_inventory", "migration_versions", "provenance", "relations", "schema_version", "schemas", "sql_dump_sha256"] and
    .schema_version == 2 and
    (.sql_dump_sha256 == null or
      (.sql_dump_sha256 | type == "string" and test("^[a-fA-F0-9]{64}$"))) and
    .provenance == {
      baseline: "yenhubs-reticulum-pre-sitting-2026-07",
      compatible_with: ["pre-sitting-2026-07", "sitting-candidate-2026-07"],
      minimum_relation_count: 356,
      minimum_migration_count: 94,
      minimum_hubs_count: 17
    } and
    .schemas == ["coturn", "ret0", "ret0_admin"] and
    (.relations | type == "array") and
    (.relations | length) == .critical_counts.relations and
    (.relations | length) >= .provenance.minimum_relation_count and
    all(.relations[];
      (keys | sort) == ["name", "schema", "type"] and
      (.schema == "coturn" or .schema == "ret0" or .schema == "ret0_admin") and
      (.name | type == "string" and test("^[A-Za-z_][A-Za-z0-9_]*$")) and
      (.type == "BASE TABLE" or .type == "VIEW" or .type == "FOREIGN")) and
    ([.relations[] | (.schema + "/" + .name)] | unique | length) == (.relations | length) and
    ([.relations[] | select(.schema == "ret0") | .name] | index("schema_migrations")) != null and
    ([.relations[] | select(.schema == "ret0") | .name] | index("hubs")) != null and
    ([.relations[] | select(.schema == "ret0") | .name] | index("owned_files")) != null and
    ([.relations[] | select(.schema == "ret0_admin")] | length) > 0 and
    ([.relations[] | select(.schema == "coturn")] | length) > 0 and
    (.migration_versions | type == "array") and
    all(.migration_versions[]; type == "string" and test("^[0-9]+$")) and
    (.migration_versions | unique | length) == (.migration_versions | length) and
    (.migration_versions | length) == .critical_counts.migrations and
    (.critical_inventory | keys | sort) == ["active_owned_file_uuids", "hub_sids", "owned_files"] and
    (.critical_inventory.hub_sids | type == "array") and
    all(.critical_inventory.hub_sids[];
      type == "string" and test("^[A-Za-z0-9._-]+$")) and
    (.critical_inventory.hub_sids | unique | length) == (.critical_inventory.hub_sids | length) and
    (.critical_inventory.hub_sids | length) == .critical_counts.hubs and
    (.critical_inventory.owned_files | type == "array") and
    all(.critical_inventory.owned_files[];
      (keys | sort) == ["state", "uuid"] and
      (.uuid | type == "string" and test("^[A-Za-z0-9._-]+$")) and
      (.state | type == "string" and test("^[A-Za-z0-9._-]+$"))) and
    ([.critical_inventory.owned_files[].uuid] | unique | length) ==
      (.critical_inventory.owned_files | length) and
    (.critical_inventory.owned_files | length) == .critical_counts.owned_files and
    (.critical_inventory.active_owned_file_uuids | type == "array") and
    all(.critical_inventory.active_owned_file_uuids[];
      type == "string" and test("^[A-Za-z0-9._-]+$")) and
    (.critical_inventory.active_owned_file_uuids | unique | length) ==
      (.critical_inventory.active_owned_file_uuids | length) and
    (.critical_inventory.active_owned_file_uuids | length) == .critical_counts.active_owned_files and
    ([.critical_inventory.owned_files[] | select(.state == "active") | .uuid] | sort) ==
      (.critical_inventory.active_owned_file_uuids | sort) and
    (.critical_counts | keys | sort) == ["active_owned_files", "hubs", "migrations", "owned_files", "relations"] and
    all(.critical_counts[]; type == "number" and floor == . and . >= 0) and
    .critical_counts.migrations >= .provenance.minimum_migration_count and
    .critical_counts.hubs >= .provenance.minimum_hubs_count and
    .critical_counts.owned_files > 0 and
    .critical_counts.active_owned_files > 0 and
    .critical_counts.active_owned_files <= .critical_counts.owned_files
  ' "$contract_path" >/dev/null
}

recovery_capture_live_database_contract() {
  local pgsql_pod="$1"
  local output_path="$2"
  local query
  query="$(recovery_database_contract_sql)" || return 1
  # Expansion is intentionally deferred to the PostgreSQL container.
  # shellcheck disable=SC2016
  if ! printf '%s\n' "$query" |
    recovery_kubectl exec -i -n "$NAMESPACE" "$pgsql_pod" -- sh -ec \
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -At' |
    jq -eS '.' >"$output_path"; then
    rm -f -- "$output_path"
    return 1
  fi
  chmod 600 "$output_path"
  recovery_database_contract_is_acceptable "$output_path"
}

recovery_database_contracts_match() {
  local expected_path="$1"
  local actual_path="$2"
  recovery_database_contract_is_acceptable "$expected_path" &&
    recovery_database_contract_is_acceptable "$actual_path" &&
    cmp -s <(jq -cS 'del(.sql_dump_sha256)' "$expected_path") \
      <(jq -cS 'del(.sql_dump_sha256)' "$actual_path")
}

# Bind every byte of the canonical plain SQL stream to the checksummed sidecar.
# Live contracts deliberately carry null because no dump exists yet; checkpoint
# contracts carry the exact SHA-256 of the decompressed pg_dump output. This
# makes any DDL, COPY block, data row, function, index, constraint or type drift
# fail offline validation, including objects outside the critical inventory.
recovery_bind_database_contract_to_dump() {
  local input_contract="$1"
  local sql_path="$2"
  local output_contract="$3"
  local sql_digest
  recovery_database_contract_is_acceptable "$input_contract" || return 1
  [[ -f "$sql_path" && ! -L "$sql_path" && -s "$sql_path" ]] || return 1
  sql_digest="$(recovery_sha256_digest "$sql_path")" || return 1
  if ! jq -eS --arg digest "$sql_digest" \
    '.sql_dump_sha256 = $digest' "$input_contract" >"$output_contract"; then
    rm -f -- "$output_contract"
    return 1
  fi
  chmod 600 "$output_contract"
  recovery_database_contract_is_acceptable "$output_contract"
}

recovery_deployment_inventory_is_acceptable() {
  local inventory_path="$1"
  local expected_namespace="$2"
  local expected_namespace_uid="$3"
  local expected_images_json="${4:-}"
  local expected_runner_image="${5:-}"
  jq -e \
    --arg namespace "$expected_namespace" \
    --arg namespace_uid "$expected_namespace_uid" \
    --arg expected_runner "$expected_runner_image" \
    --argjson expected_images "${expected_images_json:-null}" '
    def expected_deployments:
      ["bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
       "pgbouncer", "pgbouncer-t", "photomnemonic", "pgsql", "reticulum", "spoke"];
    def expected_pairs:
      ["bot-orchestrator/bot-orchestrator", "coturn/coturn", "dialog/dialog",
       "haproxy/haproxy", "hubs/hubs", "nearspark/nearspark", "pgbouncer/pgbouncer",
       "pgbouncer-t/pgbouncer-t", "photomnemonic/photomnemonic"] +
      (if .bot_runner_runtime.mode == "process-local"
       then ["pgsql/postgresql"]
       elif .bot_runner_runtime.mode == "kubernetes-pod"
       then ["pgsql/pgsql"]
       else [] end) +
      ["reticulum/postgrest", "reticulum/reticulum", "spoke/spoke"];
    def trusted_repository($pair; $image):
      ($image | split("@sha256:")[0]) as $repository |
      if $pair == "bot-orchestrator/bot-orchestrator" then $repository == "ghcr.io/yengalvez/bot-orchestrator"
      elif $pair == "coturn/coturn" then $repository == "ghcr.io/yengalvez/coturn"
      elif $pair == "dialog/dialog" then $repository == "ghcr.io/yengalvez/dialog"
      elif $pair == "haproxy/haproxy" then
        ($repository == "ghcr.io/yengalvez/haproxy" or
         $repository == "docker.io/haproxytech/kubernetes-ingress" or
         $repository == "haproxytech/kubernetes-ingress")
      elif $pair == "hubs/hubs" then $repository == "ghcr.io/yengalvez/hubs"
      elif $pair == "nearspark/nearspark" then
        ($repository == "ghcr.io/yengalvez/nearspark" or
         $repository == "docker.io/mozillareality/nearspark" or
         $repository == "mozillareality/nearspark")
      elif ($pair == "pgbouncer/pgbouncer" or $pair == "pgbouncer-t/pgbouncer-t") then
        ($repository == "ghcr.io/yengalvez/pgbouncer" or
         $repository == "docker.io/mozillareality/pgbouncer" or
         $repository == "docker.io/edoburu/pgbouncer" or
         $repository == "edoburu/pgbouncer")
      elif $pair == "photomnemonic/photomnemonic" then $repository == "ghcr.io/yengalvez/photomnemonic"
      elif ($pair == "pgsql/pgsql" or $pair == "pgsql/postgresql") then
        ($repository == "ghcr.io/yengalvez/postgres" or
         $repository == "docker.io/mozillareality/postgres" or
         $repository == "docker.io/library/postgres" or $repository == "postgres")
      elif $pair == "reticulum/postgrest" then
        ($repository == "ghcr.io/yengalvez/postgrest" or
         $repository == "docker.io/mozillareality/postgrest" or
         $repository == "docker.io/postgrest/postgrest" or
         $repository == "postgrest/postgrest")
      elif $pair == "reticulum/reticulum" then $repository == "ghcr.io/yengalvez/reticulum"
      elif $pair == "spoke/spoke" then $repository == "ghcr.io/yengalvez/spoke"
      else false end;
    .schema_version as $inventory_schema |
    (keys | sort) ==
      ["bot_runner_runtime", "deployments", "namespace", "namespace_uid", "schema_version"] and
    (.schema_version == 3 or .schema_version == 4) and
    .namespace == $namespace and
    .namespace_uid == $namespace_uid and
    (.bot_runner_runtime | type == "object" and
      (if $inventory_schema == 3
       then (keys | sort) == ["control_plane", "image", "mode", "recovery_epoch"]
       else (keys | sort) == ["control_plane", "generation", "image", "mode", "recovery_epoch"]
       end)) and
    ((.bot_runner_runtime.recovery_epoch == {state:"legacy-absent"}) or
      (.bot_runner_runtime.recovery_epoch | type == "object" and
       (keys | sort) == ["state", "value"] and .state == "bound" and
       (.value | type == "string" and
        test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")))) and
    ((.bot_runner_runtime.mode == "process-local" and
       .bot_runner_runtime.image == null and
       ($inventory_schema == 3 or .bot_runner_runtime.generation == "legacy-absent") and
       .bot_runner_runtime.recovery_epoch == {state:"legacy-absent"} and
       .bot_runner_runtime.control_plane == {state:"legacy-absent"}) or
      (.bot_runner_runtime.mode == "kubernetes-pod" and
       ($inventory_schema == 3 or .bot_runner_runtime.generation == "durable-v2") and
       .bot_runner_runtime.recovery_epoch.state == "bound" and
       (.bot_runner_runtime.image | type == "string" and
        test("^ghcr\\.io/yengalvez/bot-runner@sha256:[a-fA-F0-9]{64}$")) and
       (.bot_runner_runtime.control_plane | type == "object" and
        (keys | sort) == [
          "cluster_resources", "namespaced_resources", "namespaces", "state"
        ] and .state == "kubernetes-active" and
        (.namespaces | type == "array" and length == 2) and
        ([.namespaces[].name] | sort) == ([$namespace, "hcce-bot-runners"] | sort) and
        ([.namespaces[].name] | unique | length) == 2 and
        all(.namespaces[];
          (if $inventory_schema == 3
           then (keys | sort) == ["api_version", "kind", "name", "uid"]
           else (keys | sort) == ["api_version", "kind", "name", "resource_version", "uid"] and
             (.resource_version | type == "string" and length > 0)
           end) and
          .api_version == "v1" and .kind == "Namespace" and
          (.uid | type == "string" and length > 0)) and
        ([.namespaces[] | select(.name == $namespace) | .uid] == [$namespace_uid]) and
        (if $inventory_schema == 3 then
          (.namespaced_resources | type == "array" and length == 7) and
          ([.namespaced_resources[] |
            [.api_version, .kind, .namespace, .name]] | sort) == ([
              ["v1", "Secret", "hcce-bot-runners", "bot-images-pull"],
              ["v1", "ServiceAccount", "hcce-bot-runners", "bot-runner"],
              ["v1", "ResourceQuota", "hcce-bot-runners", "bot-runner-capacity"],
              ["rbac.authorization.k8s.io/v1", "Role", "hcce-bot-runners", "bot-orchestrator-runner-pods"],
              ["rbac.authorization.k8s.io/v1", "RoleBinding", "hcce-bot-runners", "bot-orchestrator-runner-pods"],
              ["networking.k8s.io/v1", "NetworkPolicy", "hcce-bot-runners", "bot-runner-default-deny"],
              ["networking.k8s.io/v1", "NetworkPolicy", "hcce-bot-runners", "bot-runner-egress"]
            ] | sort) and
          all(.namespaced_resources[];
            (keys | sort) == ["api_version", "kind", "name", "namespace", "uid"] and
            (.uid | type == "string" and length > 0)) and
          (.cluster_resources | type == "array" and length == 2) and
          ([.cluster_resources[] | [.api_version, .kind, .name]] | sort) == ([
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "bot-runner-pods.yenhubs.org"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "bot-runner-pods.yenhubs.org"]
          ] | sort) and
          all(.cluster_resources[];
            (keys | sort) == ["api_version", "kind", "name", "uid"] and
            (.uid | type == "string" and length > 0))
        else
          (.namespaces | type == "array" and length == 2) and
          all(.namespaces[];
            (keys | sort) == ["api_version", "kind", "name", "resource_version", "uid"] and
            (.resource_version | type == "string" and length > 0)) and
          (.namespaced_resources | type == "array" and length == 13) and
          ([.namespaced_resources[] |
            [.api_version, .kind, .namespace, .name]] | sort) == ([
              ["v1", "ServiceAccount", $namespace, "bot-orchestrator"],
              ["rbac.authorization.k8s.io/v1", "Role", $namespace, "bot-orchestrator-runner-pods"],
              ["rbac.authorization.k8s.io/v1", "RoleBinding", $namespace, "bot-orchestrator-runner-pods"],
              ["v1", "ConfigMap", $namespace, "yenhubs-runner-cutover-v2"],
              ["v1", "Secret", "hcce-bot-runners", "bot-images-pull"],
              ["v1", "ServiceAccount", "hcce-bot-runners", "bot-runner"],
              ["v1", "ServiceAccount", "hcce-bot-runners", "bot-runner-guard"],
              ["v1", "ResourceQuota", "hcce-bot-runners", "bot-runner-capacity"],
              ["v1", "ResourceQuota", "hcce-bot-runners", "bot-runner-guard-capacity"],
              ["rbac.authorization.k8s.io/v1", "Role", "hcce-bot-runners", "bot-orchestrator-runner-pods"],
              ["rbac.authorization.k8s.io/v1", "RoleBinding", "hcce-bot-runners", "bot-orchestrator-runner-pods"],
              ["networking.k8s.io/v1", "NetworkPolicy", "hcce-bot-runners", "bot-runner-default-deny"],
              ["networking.k8s.io/v1", "NetworkPolicy", "hcce-bot-runners", "bot-runner-egress"]
            ] | sort) and
          all(.namespaced_resources[];
            (keys | sort) == ["api_version", "kind", "name", "namespace", "resource_version", "uid"] and
            (.uid | type == "string" and length > 0) and
            (.resource_version | type == "string" and length > 0)) and
          (.cluster_resources | type == "array" and length == 10) and
          ([.cluster_resources[] | [.api_version, .kind, .name]] | sort) == ([
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "bot-runner-pods.yenhubs.org"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "bot-runner-pods.yenhubs.org"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "bot-runner-durable-protocol.yenhubs.org"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "bot-runner-durable-protocol.yenhubs.org"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "yenhubs-runner-cutover-journal-v2"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "yenhubs-runner-cutover-journal-v2"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "bot-orchestrator-fence-protocol.yenhubs.org"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "bot-orchestrator-fence-protocol.yenhubs.org"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "recovery-operation-pod-fence.yenhubs.org"],
            ["admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "recovery-operation-pod-fence.yenhubs.org"]
          ] | sort) and
          all(.cluster_resources[];
            (keys | sort) == ["api_version", "kind", "name", "resource_version", "uid"] and
            (.uid | type == "string" and length > 0) and
            (.resource_version | type == "string" and length > 0))
        end)))) and
    ($expected_runner == "" or
      .bot_runner_runtime.mode == "process-local" or
      .bot_runner_runtime.image == $expected_runner) and
    (.deployments | type == "array") and
    ([.deployments[].name] | sort) == (expected_deployments | sort) and
    ([.deployments[].name] | unique | length) == (.deployments | length) and
    ([.deployments[] | select(.name == "bot-orchestrator") | .replicas] == [1]) and
    all(.deployments[];
      (.uid | type == "string" and length > 0) and
      (.replicas | type == "number" and floor == . and . >= 0) and
      (.init_containers | type == "array" and length == 0) and
      (.containers | type == "array" and length > 0) and
      ([.containers[].name] | unique | length) == (.containers | length) and
      all(.containers[];
        (.name | type == "string" and length > 0) and
        (.image | type == "string" and test("@sha256:[a-fA-F0-9]{64}$")))) and
    ([.deployments[] as $deployment
      | $deployment.containers[]
      | ($deployment.name + "/" + .name)] | sort) == (expected_pairs | sort) and
    ([.deployments[] as $deployment | $deployment.containers[] |
      trusted_repository(($deployment.name + "/" + .name); .image)] | all) and
    ($expected_images == null or (
      ($expected_images | type == "object") and
      (($expected_images | keys | sort) == (expected_pairs | sort)) and
      ([.deployments[] as $deployment
        | $deployment.containers[]
        | .image == $expected_images[$deployment.name + "/" + .name]] | all)))
  ' "$inventory_path" >/dev/null
}

recovery_checkpoint_deployment_inventory_is_acceptable() {
  local inventory_path="$1" expected_namespace="$2" origin_namespace_uid
  origin_namespace_uid="$(jq -er \
    '.namespace_uid | select(type == "string" and length > 0)' \
    "$inventory_path")" || return 1
  recovery_deployment_inventory_is_acceptable \
    "$inventory_path" "$expected_namespace" "$origin_namespace_uid"
}

recovery_inventory_core_images_match() {
  local inventory_path="$1"
  local hubs_image="$2"
  local reticulum_image="$3"
  local bot_image="$4"
  jq -e --arg hubs "$hubs_image" --arg reticulum "$reticulum_image" --arg bot "$bot_image" '
    ([.deployments[] | select(.name == "hubs") | .containers[] | select(.name == "hubs") | .image] == [$hubs]) and
    ([.deployments[] | select(.name == "reticulum") | .containers[] | select(.name == "reticulum") | .image] == [$reticulum]) and
    ([.deployments[] | select(.name == "bot-orchestrator") | .containers[] | select(.name == "bot-orchestrator") | .image] == [$bot])
  ' "$inventory_path" >/dev/null
}

recovery_private_values_file_is_acceptable() {
  local values_path="$1" mode owner
  recovery_require_regular_direct_file "$values_path" || return 1
  if mode="$(stat -f '%Lp' "$values_path" 2>/dev/null)"; then
    owner="$(stat -f '%u' "$values_path" 2>/dev/null)" || return 1
  elif mode="$(stat -c '%a' "$values_path" 2>/dev/null)"; then
    owner="$(stat -c '%u' "$values_path" 2>/dev/null)" || return 1
  else
    return 1
  fi
  [[ "$mode" == 600 || "$mode" == 0600 ]] || return 1
  [[ "$owner" == "$(id -u)" ]]
}

recovery_runner_epoch_from_values() {
  local values_path="$1" epoch parser_path="$RECOVERY_SAFETY_DIR/../parse-local-values.mjs"
  recovery_private_values_file_is_acceptable "$values_path" || return 1
  epoch="$(command node "$parser_path" "$values_path" \
    --get BOT_RUNNER_RECOVERY_EPOCH)" || return 1
  [[ "$epoch" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || return 1
  printf '%s\n' "$epoch"
}

recovery_live_runner_epoch() {
  local deployment deployment_json epoch expected_epoch="" first=1
  for deployment in reticulum bot-orchestrator; do
    deployment_json="$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o json
    )" || return 1
    epoch="$(printf '%s' "$deployment_json" | jq -er \
      --arg deployment "$deployment" --arg namespace "$NAMESPACE" '
      select(.apiVersion == "apps/v1" and .kind == "Deployment" and
        .metadata.name == $deployment and .metadata.namespace == $namespace) |
      ((.spec.template.metadata.annotations // {})[
        "yenhubs.org/bot-runner-recovery-epoch"
      ] // "") | select(type == "string")
    ')" || return 1
    [[ -z "$epoch" ||
       "$epoch" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || return 1
    if [[ "$first" == 1 ]]; then
      expected_epoch="$epoch"
      first=0
    elif [[ "$epoch" != "$expected_epoch" ]]; then
      return 1
    fi
  done
  printf '%s\n' "$expected_epoch"
}

recovery_require_restore_epoch_candidate() {
  local inventory_path="$1" values_path="$2"
  local checkpoint_state checkpoint_epoch candidate_epoch live_epoch
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  checkpoint_state="$(jq -er '.bot_runner_runtime.recovery_epoch.state' \
    "$inventory_path")" || return 1
  checkpoint_epoch="$(jq -r '.bot_runner_runtime.recovery_epoch.value // ""' \
    "$inventory_path")" || return 1
  if ! candidate_epoch="$(
    recovery_runner_epoch_from_values "$values_path"
  )"; then
    printf 'A direct owner-only VALUES_FILE with one canonical recovery epoch is required.\n' >&2
    return 1
  fi
  if ! live_epoch="$(recovery_live_runner_epoch)"; then
    printf 'Could not verify the live Reticulum/parent recovery-epoch binding.\n' >&2
    return 1
  fi
  if [[ "$checkpoint_state" == bound && "$candidate_epoch" == "$checkpoint_epoch" ]]; then
    printf 'Restore is blocked until BOT_RUNNER_RECOVERY_EPOCH is rotated through the standard generated-manifest flow.\n' >&2
    return 1
  fi
  if [[ -n "$live_epoch" && "$candidate_epoch" == "$live_epoch" ]]; then
    printf 'The restore-fence epoch candidate must differ from the currently live issuing epoch.\n' >&2
    return 1
  fi
}

recovery_require_durable_checkpoint_source_matches_live() {
  local inventory_path="$1" mode checkpoint_epoch live_epoch
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  [[ "${RECOVERY_CHECKPOINT_RUNNER_GENERATION:-}" == durable-v2 &&
     "$(jq -er '.schema_version' "$inventory_path")" == 4 ]] || return 1
  mode="$(jq -er '.bot_runner_runtime.mode' "$inventory_path")" || return 1
  [[ "$mode" == kubernetes-pod ]] || return 1
  recovery_require_live_runner_control_plane_matches_checkpoint \
    "$inventory_path" || return 1
  checkpoint_epoch="$(jq -er '
    .bot_runner_runtime.recovery_epoch |
    select(.state == "bound") |
    .value | select(type == "string" and
      test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"))
  ' "$inventory_path")" || return 1
  live_epoch="$(recovery_live_runner_epoch)" || return 1
  [[ "$live_epoch" == "$checkpoint_epoch" ]] || {
    printf 'Live durable runner epoch does not match the checkpoint pre-fence epoch.\n' >&2
    return 1
  }
}

recovery_require_restore_target_manifest_candidate() {
  local values_path="$1" expected_phase="$2" activation_phase recovery_phase
  local manifest_path="${HCCE_MANIFEST_PATH:-$RECOVERY_SAFETY_DIR/../../hubs-cloud/community-edition/hcce.yaml}"
  local manifest_verifier="$RECOVERY_SAFETY_DIR/../../hubs-cloud/community-edition/generate_script/verify-generated-manifest.js"
  local parser_path="$RECOVERY_SAFETY_DIR/../parse-local-values.mjs"
  [[ "$expected_phase" == active || "$expected_phase" == restore-fence ]] || return 2
  if [[ -n "${YENHUBS_RECOVERY_GENERATED_MANIFEST_VERIFIER:-}" ]]; then
    recovery_require_local_fixture_attestation || return 1
    manifest_verifier="$YENHUBS_RECOVERY_GENERATED_MANIFEST_VERIFIER"
  fi
  recovery_private_values_file_is_acceptable "$values_path" || return 1
  recovery_require_regular_direct_file "$manifest_path" || return 1
  recovery_require_regular_direct_file "$manifest_verifier" || return 1
  activation_phase="$(command node "$parser_path" "$values_path" \
    --get BOT_RUNNER_ACTIVATION_PHASE)" || return 1
  recovery_phase="$(command node "$parser_path" "$values_path" \
    --get BOT_RUNNER_RECOVERY_PHASE)" || return 1
  [[ "$activation_phase" == active && "$recovery_phase" == "$expected_phase" ]] || {
    printf 'The target values are not bound to the required runner recovery phase.\n' >&2
    return 1
  }
  recovery_runner_epoch_from_values "$values_path" >/dev/null || return 1
  HCCE_INPUT_VALUES_PATH="$values_path" HCCE_MANIFEST_PATH="$manifest_path" \
    command node "$manifest_verifier" >/dev/null || {
    printf 'The target generated manifest is invalid or does not match its values.\n' >&2
    return 1
  }
}

recovery_require_live_restore_fence_epoch() {
  local values_path="$1" pre_fence_epoch="$2" candidate_epoch live_epoch
  candidate_epoch="$(recovery_runner_epoch_from_values "$values_path")" || return 1
  live_epoch="$(recovery_live_runner_epoch)" || return 1
  [[ -n "$live_epoch" && "$live_epoch" == "$candidate_epoch" &&
     "$live_epoch" != "$pre_fence_epoch" ]] || {
    printf 'The live restore-fence epoch is not the exact new candidate.\n' >&2
    return 1
  }
}

recovery_live_runner_recovery_phase() {
  local deployment deployment_json phase expected_phase="" first=1
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn pgsql; do
    deployment_json="$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o json
    )" || return 1
    phase="$(jq -er --arg namespace "$NAMESPACE" --arg name "$deployment" '
      select(.apiVersion == "apps/v1" and .kind == "Deployment" and
        .metadata.namespace == $namespace and .metadata.name == $name) |
      ((.metadata.annotations // {})[
        "yenhubs.org/bot-runner-recovery-phase"
      ] // "") | select(. == "active" or . == "restore-fence")
    ' <<<"$deployment_json")" || return 1
    if [[ "$first" == 1 ]]; then
      expected_phase="$phase"
      first=0
    elif [[ "$phase" != "$expected_phase" ]]; then
      return 1
    fi
  done
  printf '%s\n' "$expected_phase"
}

recovery_require_live_runner_recovery_phase() {
  local expected_phase="$1" deployment deployment_json
  [[ "$expected_phase" == active || "$expected_phase" == restore-fence ]] || return 2
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn pgsql; do
    deployment_json="$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o json
    )" || return 1
    jq -e --arg namespace "$NAMESPACE" --arg name "$deployment" \
      --arg phase "$expected_phase" '
      .apiVersion == "apps/v1" and .kind == "Deployment" and
      .metadata.namespace == $namespace and .metadata.name == $name and
      ((.metadata.annotations // {})[
        "yenhubs.org/bot-runner-recovery-phase"
      ] == $phase)
    ' >/dev/null <<<"$deployment_json" || {
      printf 'Deployment/%s is not bound to recovery phase %s.\n' \
        "$deployment" "$expected_phase" >&2
      return 1
    }
  done
}

recovery_require_live_runner_active_control_plane_exact() {
  local values_path="$1" output
  local verifier="$RECOVERY_SAFETY_DIR/../../hubs-cloud/community-edition/apply/verify-live-runner-control-plane.js"
  local manifest_verifier="$RECOVERY_SAFETY_DIR/../../hubs-cloud/community-edition/generate_script/verify-generated-manifest.js"
  local manifest_path="${HCCE_MANIFEST_PATH:-$RECOVERY_SAFETY_DIR/../../hubs-cloud/community-edition/hcce.yaml}"

  if [[ -n "${YENHUBS_RECOVERY_RUNNER_CONTROL_PLANE_VERIFIER:-}" ]]; then
    recovery_require_local_fixture_attestation || {
      printf 'A runner control-plane verifier override is allowed only in the isolated fixture context.\n' >&2
      return 1
    }
    verifier="$YENHUBS_RECOVERY_RUNNER_CONTROL_PLANE_VERIFIER"
  fi
  if [[ -n "${YENHUBS_RECOVERY_GENERATED_MANIFEST_VERIFIER:-}" ]]; then
    recovery_require_local_fixture_attestation || {
      printf 'A generated-manifest verifier override is allowed only in the isolated fixture context.\n' >&2
      return 1
    }
    manifest_verifier="$YENHUBS_RECOVERY_GENERATED_MANIFEST_VERIFIER"
  fi
  recovery_private_values_file_is_acceptable "$values_path" || {
    printf 'The active runner control-plane gate requires one direct owner-only VALUES_FILE.\n' >&2
    return 1
  }
  recovery_require_regular_direct_file "$verifier" || {
    printf 'The exact Cloud runner control-plane verifier is unavailable or unsafe.\n' >&2
    return 1
  }
  recovery_require_regular_direct_file "$manifest_verifier" || {
    printf 'The exact generated Cloud manifest verifier is unavailable or unsafe.\n' >&2
    return 1
  }
  recovery_require_regular_direct_file "$manifest_path" || {
    printf 'The tracked generated Cloud manifest is unavailable or unsafe.\n' >&2
    return 1
  }
  [[ -n "${EXPECTED_KUBE_CONTEXT:-}" &&
     "$EXPECTED_KUBE_CONTEXT" == "${EXPECTED_KUBE_CONTEXT//[[:space:]]/}" ]] || return 1

  # The Cloud verifier compares every live control-plane object with the
  # generated manifest, including the ValidatingAdmissionPolicy/binding and
  # the four exact effective-RBAC SelfSubjectRulesReviews. Requiring the six
  # consumer annotations to be active makes an inert restore-fence manifest
  # ineligible even if that fenced control plane is otherwise internally exact.
  recovery_require_live_runner_recovery_phase active || return 1
  if ! HCCE_INPUT_VALUES_PATH="$values_path" \
    HCCE_MANIFEST_PATH="$manifest_path" \
      command node "$manifest_verifier" >/dev/null; then
    printf 'The generated Cloud manifest is invalid or does not match its active input values.\n' >&2
    return 1
  fi
  if ! output="$({
    HCCE_INPUT_VALUES_PATH="$values_path" \
    HCCE_MANIFEST_PATH="$manifest_path" \
    KUBECTL_CONTEXT="$EXPECTED_KUBE_CONTEXT" \
      command node "$verifier"
  })"; then
    printf 'The active runner control plane is not exact; refusing parent authority.\n' >&2
    return 1
  fi
  [[ "$output" == runner_live_control_plane_verified ]] || {
    printf 'The active runner control-plane verifier returned an unexpected result.\n' >&2
    return 1
  }
}

# Checkpoint creation must work both before and after the isolated runner
# rollout without ever treating a partial rollout as the legacy runtime.  The
# legacy branch authorizes only capture/resume of the exact process-local
# security boundary that is already live; it is not a deployment gate.
recovery_runner_isolation_residual_state() {
  local deployment deployment_json annotation_present
  local resource name resource_namespace resource_json residual=0
  for deployment in \
    reticulum pgbouncer pgbouncer-t bot-orchestrator coturn pgsql; do
    deployment_json="$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o json
    )" || return 1
    annotation_present="$(jq -r --arg namespace "$NAMESPACE" \
      --arg deployment "$deployment" '
      if .apiVersion == "apps/v1" and .kind == "Deployment" and
         .metadata.namespace == $namespace and .metadata.name == $deployment
      then
        [((.metadata.annotations // {}) | keys),
         ((.spec.template.metadata.annotations // {}) | keys)] |
        flatten |
        any(. == "yenhubs.org/bot-runner-recovery-epoch" or
            . == "yenhubs.org/bot-runner-recovery-phase" or
            . == "yenhubs.org/runner-activation-phase")
      else
        "invalid"
      end
    ' <<<"$deployment_json")" || return 1
    case "$annotation_present" in
      false) ;;
      true) residual=1 ;;
      *) return 1 ;;
    esac
  done
  while IFS=$'\t' read -r resource name resource_namespace; do
    if [[ "$resource_namespace" == cluster ]]; then
      resource_json="$(
        recovery_kubectl get "$resource" "$name" --ignore-not-found -o json
      )" || return 1
    else
      resource_json="$(
        recovery_kubectl get "$resource" "$name" -n "$resource_namespace" \
          --ignore-not-found -o json
      )" || return 1
    fi
    [[ -z "$resource_json" ]] || residual=1
  done <<EOF
namespace	hcce-bot-runners	cluster
serviceaccount	bot-orchestrator	$NAMESPACE
role	bot-orchestrator-runner-pods	$NAMESPACE
rolebinding	bot-orchestrator-runner-pods	$NAMESPACE
configmap	yenhubs-runner-cutover-v2	$NAMESPACE
secret	bot-images-pull	hcce-bot-runners
serviceaccount	bot-runner	hcce-bot-runners
serviceaccount	bot-runner-guard	hcce-bot-runners
resourcequota	bot-runner-capacity	hcce-bot-runners
resourcequota	bot-runner-guard-capacity	hcce-bot-runners
role	bot-orchestrator-runner-pods	hcce-bot-runners
rolebinding	bot-orchestrator-runner-pods	hcce-bot-runners
networkpolicy	bot-runner-default-deny	hcce-bot-runners
networkpolicy	bot-runner-egress	hcce-bot-runners
validatingadmissionpolicy	bot-runner-pods.yenhubs.org	cluster
validatingadmissionpolicybinding	bot-runner-pods.yenhubs.org	cluster
validatingadmissionpolicy	bot-runner-durable-protocol.yenhubs.org	cluster
validatingadmissionpolicybinding	bot-runner-durable-protocol.yenhubs.org	cluster
validatingadmissionpolicy	yenhubs-runner-cutover-journal-v2	cluster
validatingadmissionpolicybinding	yenhubs-runner-cutover-journal-v2	cluster
validatingadmissionpolicy	bot-orchestrator-fence-protocol.yenhubs.org	cluster
validatingadmissionpolicybinding	bot-orchestrator-fence-protocol.yenhubs.org	cluster
validatingadmissionpolicy	recovery-operation-pod-fence.yenhubs.org	cluster
validatingadmissionpolicybinding	recovery-operation-pod-fence.yenhubs.org	cluster
EOF
  if [[ "$residual" == 0 ]]; then
    printf 'absent\n'
  else
    printf 'present\n'
  fi
}

recovery_require_live_process_local_runner_contract_exact() {
  local values_path="$1" expected_image parent_json reticulum_json pgsql_json
  local ret_config_json configs_json residual_state
  local strategy_scope="${2:-strict-recreate}"
  local parser_path="$RECOVERY_SAFETY_DIR/../parse-local-values.mjs"

  [[ "$strategy_scope" == strict-recreate ||
     "$strategy_scope" == freeze-checkpoint ||
     "$strategy_scope" == cold-rebind-target ]] || return 2

  recovery_private_values_file_is_acceptable "$values_path" || {
    printf 'The process-local checkpoint gate requires one direct owner-only VALUES_FILE.\n' >&2
    return 1
  }
  expected_image="$(command node "$parser_path" "$values_path" \
    --get OVERRIDE_BOT_ORCHESTRATOR_IMAGE)" || return 1
  [[ "$expected_image" =~ ^ghcr\.io/yengalvez/bot-orchestrator@sha256:[a-fA-F0-9]{64}$ ]] || {
    printf 'The process-local bot-orchestrator image is not an exact trusted digest.\n' >&2
    return 1
  }
  parent_json="$(
    recovery_kubectl get deployment bot-orchestrator -n "$NAMESPACE" -o json
  )" || return 1
  reticulum_json="$(
    recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o json
  )" || return 1
  pgsql_json="$(
    recovery_kubectl get deployment pgsql -n "$NAMESPACE" -o json
  )" || return 1
  ret_config_json="$(
    recovery_kubectl get configmap ret-config -n "$NAMESPACE" -o json
  )" || return 1
  configs_json="$(
    recovery_kubectl get secret configs -n "$NAMESPACE" -o json
  )" || return 1

  jq -e --arg namespace "$NAMESPACE" --arg image "$expected_image" \
    --arg strategy_scope "$strategy_scope" '
    def one_env($name):
      [(.spec.template.spec.containers[0].env // [])[] | select(.name == $name)];
    def literal_env($name; $value):
      (one_env($name) | length == 1) and
      (one_env($name)[0] == {name:$name,value:$value});
    def forbidden_runner_binding:
      [(.spec.template.spec.containers[0].env // [])[] | .name] |
      any(. == "BOT_RUNNER_ACCESS_KEY" or
          . == "BOT_ORCHESTRATOR_ACCESS_KEY" or
          . == "DASHBOARD_ACCESS_KEY" or
          . == "BOT_RUNNER_IMAGE" or . == "BOT_RUNNER_RECOVERY_EPOCH" or
          . == "POD_NAMESPACE" or . == "ORCHESTRATOR_POD_NAME" or
          . == "ORCHESTRATOR_POD_UID" or . == "RUNNER_NAMESPACE" or
          . == "RUNNER_POD_NAMESPACE" or . == "RUNNER_CONTROL_URL");
    def has_runner_annotation:
      [((.metadata.annotations // {}) | keys),
       ((.spec.template.metadata.annotations // {}) | keys)] |
      flatten |
      any(. == "yenhubs.org/bot-runner-recovery-epoch" or
          . == "yenhubs.org/bot-runner-recovery-phase" or
          . == "yenhubs.org/runner-activation-phase" or
          . == "yenhubs.org/bot-orchestrator-access-key-checksum");
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "bot-orchestrator" and .metadata.namespace == $namespace and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (if $strategy_scope == "strict-recreate" or
        $strategy_scope == "cold-rebind-target" then
       .spec.strategy.type == "Recreate"
     else
       (.spec.strategy.type == "Recreate" or
        (.spec.strategy.type == "RollingUpdate" and
         ((.spec.strategy | keys) | sort) == ["rollingUpdate","type"] and
         ((.spec.strategy.rollingUpdate | keys) | sort) ==
           ["maxSurge","maxUnavailable"] and
         all((.spec.strategy.rollingUpdate.maxSurge,
              .spec.strategy.rollingUpdate.maxUnavailable);
           (type == "number" and floor == . and . >= 0) or
           (type == "string" and test("^(0|[1-9][0-9]*)(%?)$")))))
     end) and
    .spec.selector == {matchLabels:{app:"bot-orchestrator"}} and
    .spec.template.metadata.labels.app == "bot-orchestrator" and
    .spec.template.spec.automountServiceAccountToken == false and
    ((.spec.template.spec.serviceAccountName // "default") == "default") and
    (if $strategy_scope == "cold-rebind-target" then
       (.spec.template.spec.imagePullSecrets // []) == [{name:"bot-images-pull"}]
     else
       (.spec.template.spec.imagePullSecrets // []) == []
     end) and
    ((.spec.template.spec.initContainers // []) == []) and
    ((.spec.template.spec.ephemeralContainers // []) == []) and
    ((.spec.template.spec.hostNetwork // false) == false) and
    ((.spec.template.spec.hostPID // false) == false) and
    ((.spec.template.spec.hostIPC // false) == false) and
    ((.spec.template.spec.shareProcessNamespace // false) == false) and
    (.spec.template.spec.containers | length == 1) and
    .spec.template.spec.containers[0].name == "bot-orchestrator" and
    .spec.template.spec.containers[0].image == $image and
    ((.spec.template.spec.containers[0].command // []) == []) and
    ((.spec.template.spec.containers[0].args // []) == []) and
    ((.spec.template.spec.containers[0].envFrom // []) == []) and
    (.spec.template.spec.containers[0].lifecycle // null) == null and
    .spec.template.spec.containers[0].securityContext == {
      runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,
      allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,
      capabilities:{drop:["ALL"]},seccompProfile:{type:"RuntimeDefault"}
    } and
    (.spec.template.spec.containers[0].volumeMounts | length == 1) and
    .spec.template.spec.containers[0].volumeMounts[0].name == "bot-orchestrator-tmp" and
    .spec.template.spec.containers[0].volumeMounts[0].mountPath == "/tmp" and
    ((.spec.template.spec.containers[0].volumeMounts[0].subPath // "") == "") and
    (.spec.template.spec.volumes | length == 1) and
    .spec.template.spec.volumes[0] == {
      name:"bot-orchestrator-tmp",emptyDir:{sizeLimit:"256Mi"}
    } and
    (one_env("BOT_ACCESS_KEY") | length == 1) and
    (one_env("BOT_ACCESS_KEY")[0].name == "BOT_ACCESS_KEY") and
    (one_env("BOT_ACCESS_KEY")[0].valueFrom.secretKeyRef.name == "configs") and
    (one_env("BOT_ACCESS_KEY")[0].valueFrom.secretKeyRef.key == "BOT_ACCESS_KEY") and
    ((one_env("BOT_ACCESS_KEY")[0].valueFrom.secretKeyRef.optional // false) == false) and
    literal_env("RUNNER_AUTOSTART"; "true") and
    literal_env("RUNNER_BACKEND"; "ghost") and
    literal_env("GHOST_RUNNER_SCRIPT"; "/app/run-ghost-runner.js") and
    (forbidden_runner_binding | not) and (has_runner_annotation | not)
  ' >/dev/null <<<"$parent_json" || {
    printf 'The live process-local bot runtime does not match its exact checkpoint contract.\n' >&2
    return 1
  }
  jq -e --arg namespace "$NAMESPACE" '
    def candidate_env:
      [.spec.template.spec.containers[] |
        select(.name == "reticulum") | (.env // [])[] | .name] |
      any(. == "turkeyCfg_BOT_RUNNER_ACCESS_KEY" or
          . == "turkeyCfg_BOT_ORCHESTRATOR_ACCESS_KEY" or
          . == "turkeyCfg_DASHBOARD_ACCESS_KEY" or
          . == "turkeyCfg_BOT_RUNNER_RECOVERY_EPOCH");
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "reticulum" and .metadata.namespace == $namespace and
    (.spec.template.spec.containers | type == "array") and
    ([.spec.template.spec.containers[] | select(.name == "reticulum")] | length == 1) and
    (candidate_env | not) and
    ([((.metadata.annotations // {}) | keys),
      ((.spec.template.metadata.annotations // {}) | keys)] |
      flatten |
      any(. == "yenhubs.org/bot-runner-recovery-epoch" or
          . == "yenhubs.org/bot-runner-recovery-phase" or
          . == "yenhubs.org/runner-activation-phase" or
          . == "yenhubs.org/bot-runner-access-key-checksum" or
          . == "yenhubs.org/bot-orchestrator-access-key-checksum" or
          . == "yenhubs.org/dashboard-access-key-checksum") | not)
  ' >/dev/null <<<"$reticulum_json" || {
    printf 'Reticulum has partial isolated-runner recovery bindings.\n' >&2
    return 1
  }
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "pgsql" and .metadata.namespace == $namespace and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    ((.spec.template.spec.initContainers // []) == []) and
    (.spec.template.spec.containers | type == "array" and length == 1) and
    .spec.template.spec.containers[0].name == "postgresql"
  ' >/dev/null <<<"$pgsql_json" || {
    printf 'The live process-local PostgreSQL container does not match the historical AUD-065 contract.\n' >&2
    return 1
  }
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "v1" and .kind == "Secret" and
    .metadata.name == "configs" and .metadata.namespace == $namespace and
    .metadata.deletionTimestamp == null and
    (([(.data // {}), (.stringData // {})] | map(keys) | add) as $keys |
      (["BOT_RUNNER_ACCESS_KEY", "BOT_ORCHESTRATOR_ACCESS_KEY",
        "DASHBOARD_ACCESS_KEY"] | all(. as $name | ($keys | index($name)) == null)))
  ' >/dev/null <<<"$configs_json" || {
    printf 'The live configs Secret contains isolated-runner credentials; refusing process-local fallback.\n' >&2
    return 1
  }
  jq -e --arg namespace "$NAMESPACE" --arg strategy_scope "$strategy_scope" '
    .apiVersion == "v1" and .kind == "ConfigMap" and
    .metadata.name == "ret-config" and .metadata.namespace == $namespace and
    .metadata.deletionTimestamp == null and
    ((.data // {})["config.toml.template"] | select(type == "string")) as $text |
    ([((.data // {})[] | select(type == "string"))] | join("\n")) as $all_text |
    (["<BOT_RUNNER_ACCESS_KEY>", "<BOT_ORCHESTRATOR_ACCESS_KEY>",
      "<DASHBOARD_ACCESS_KEY>", "<BOT_RUNNER_RECOVERY_EPOCH>"] |
      all(. as $marker | ($all_text | contains($marker) | not))) and
    ($all_text | [scan("(?m)^\\[ret\\.\u0022Elixir\\.Ret\\.BotOrchestrator\u0022\\]$")] |
      length) as $all_section_count |
    ($text | [scan("(?m)^\\[ret\\.\u0022Elixir\\.Ret\\.BotOrchestrator\u0022\\]$")] |
      length) as $template_section_count |
    if $strategy_scope == "strict-recreate" then
      $all_section_count == 0
    elif $strategy_scope == "cold-rebind-target" then
      $all_section_count == 1 and $template_section_count == 1 and
      ($text | [scan("(?m)^\\[ret\\.\u0022Elixir\\.Ret\\.BotOrchestrator\u0022\\]\\r?\\nendpoint = \u0022http://bot-orchestrator\\.<POD_NS>:5001\u0022\\r?\\naccess_key = \u0022<BOT_ACCESS_KEY>\u0022(?:\\r?\\n[ \\t]*)*(?:\\r?\\n(?=\\[)|$)")] | length) == 1
    elif $all_section_count == 0 then
      true
    else
      $all_section_count == 1 and $template_section_count == 1 and
      ($text | [scan("(?m)^\\[ret\\.\u0022Elixir\\.Ret\\.BotOrchestrator\u0022\\]\\r?\\nendpoint = \u0022http://bot-orchestrator\\.<POD_NS>:5001\u0022\\r?\\naccess_key = \u0022<BOT_ACCESS_KEY>\u0022(?:\\r?\\n[ \\t]*)*(?:\\r?\\n(?=\\[)|$)")] | length) == 1
    end
  ' >/dev/null <<<"$ret_config_json" || {
    printf 'The live Reticulum config contains isolated-runner markers; refusing process-local fallback.\n' >&2
    return 1
  }
  residual_state="$(recovery_runner_isolation_residual_state)" || return 1
  [[ "$residual_state" == absent ]] || {
    printf 'Isolated-runner resources or annotations remain; refusing process-local fallback.\n' >&2
    return 1
  }
  recovery_require_no_managed_bot_runner_pods || return 1
}

# Restore, rotation and general inventory callers always retain the historical
# exact Recreate requirement. Environment markers must never widen this gate.
recovery_require_live_process_local_runner_exact() {
  recovery_require_live_process_local_runner_contract_exact "$1" strict-recreate
}

# A freshly generated legacy cold-rebind target keeps the process-local
# Reticulum endpoint and the single GHCR pull-secret reference needed by the
# private bot-orchestrator image.  This scope is intentionally separate from
# the historical in-place/restore gate above.
recovery_require_live_process_local_cold_rebind_target_exact() {
  recovery_require_live_process_local_runner_contract_exact \
    "$1" cold-rebind-target
}

recovery_require_live_process_local_freeze_checkpoint_exact() {
  local values_path="$1" checkpoint_format="$2" runner_mode="$3"
  [[ "$checkpoint_format" == freeze-bundle-v1 &&
     "$runner_mode" == process-local ]] || return 2
  recovery_require_live_process_local_runner_contract_exact \
    "$values_path" freeze-checkpoint
}

recovery_checkpoint_runner_mode_candidate() {
  local parent_json reticulum_json residual_state
  parent_json="$(
    recovery_kubectl get deployment bot-orchestrator -n "$NAMESPACE" -o json
  )" || return 1
  reticulum_json="$(
    recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o json
  )" || return 1
  residual_state="$(recovery_runner_isolation_residual_state)" || return 1
  jq -ern --arg namespace "$NAMESPACE" --argjson parent "$parent_json" \
    --argjson reticulum "$reticulum_json" \
    --arg residual_state "$residual_state" '
    def valid_deployment($value; $name):
      $value.apiVersion == "apps/v1" and $value.kind == "Deployment" and
      $value.metadata.name == $name and $value.metadata.namespace == $namespace;
    def runner_annotations($value):
      [((($value.metadata.annotations // {}) | keys)),
       ((($value.spec.template.metadata.annotations // {}) | keys))] |
      flatten |
      any(. == "yenhubs.org/bot-runner-recovery-epoch" or
          . == "yenhubs.org/bot-runner-recovery-phase" or
          . == "yenhubs.org/runner-activation-phase" or
          . == "yenhubs.org/bot-runner-access-key-checksum" or
          . == "yenhubs.org/bot-orchestrator-access-key-checksum" or
          . == "yenhubs.org/dashboard-access-key-checksum");
    if (valid_deployment($parent; "bot-orchestrator") | not) or
       (valid_deployment($reticulum; "reticulum") | not) or
       ($parent.spec.template.spec.containers | type) != "array" or
       ([$parent.spec.template.spec.containers[] |
         select(.name == "bot-orchestrator")] | length) != 1
    then error("invalid_runner_parent")
    else
      ($parent.spec.template.spec.containers[] |
        select(.name == "bot-orchestrator")) as $container |
      ([($container.env // [])[].name] |
        any(. == "BOT_RUNNER_ACCESS_KEY" or
            . == "BOT_ORCHESTRATOR_ACCESS_KEY" or
            . == "DASHBOARD_ACCESS_KEY" or
            . == "BOT_RUNNER_IMAGE" or . == "BOT_RUNNER_RECOVERY_EPOCH" or
            . == "POD_NAMESPACE" or . == "ORCHESTRATOR_POD_NAME" or
            . == "ORCHESTRATOR_POD_UID" or . == "RUNNER_NAMESPACE" or
            . == "RUNNER_POD_NAMESPACE" or . == "RUNNER_CONTROL_URL")) as $binding |
      ([($reticulum.spec.template.spec.containers // [])[] |
        select(.name == "reticulum") | (.env // [])[].name] |
        any(. == "turkeyCfg_BOT_RUNNER_ACCESS_KEY" or
            . == "turkeyCfg_BOT_ORCHESTRATOR_ACCESS_KEY" or
            . == "turkeyCfg_DASHBOARD_ACCESS_KEY" or
            . == "turkeyCfg_BOT_RUNNER_RECOVERY_EPOCH")) as $ret_binding |
      if $residual_state == "present" or
         (($parent.spec.template.spec.serviceAccountName // "default") != "default") or
         $parent.spec.template.spec.automountServiceAccountToken != false or
         (($parent.spec.template.spec.imagePullSecrets // []) | length > 0) or
         $binding or $ret_binding or runner_annotations($parent) or
         runner_annotations($reticulum)
      then "kubernetes-pod" else "process-local" end
    end
  '
}

recovery_require_checkpoint_runner_mode_exact() {
  local values_path="$1" expected_mode="${2:-}" candidate_mode
  local process_local_scope="${3:-strict-recreate}"
  [[ -z "$expected_mode" || "$expected_mode" == process-local ||
     "$expected_mode" == kubernetes-pod ]] || return 2
  [[ "$process_local_scope" == strict-recreate ||
     "$process_local_scope" == freeze-checkpoint ||
     "$process_local_scope" == cold-rebind-target ]] || return 2
  candidate_mode="$(recovery_checkpoint_runner_mode_candidate)" || {
    printf 'Could not classify the live checkpoint runner boundary.\n' >&2
    return 1
  }
  if [[ -n "$expected_mode" && "$candidate_mode" != "$expected_mode" ]]; then
    printf 'Checkpoint runner mode changed while writers were fenced.\n' >&2
    return 1
  fi
  case "$candidate_mode" in
    process-local)
      if [[ "$process_local_scope" == freeze-checkpoint ]]; then
        recovery_require_live_process_local_freeze_checkpoint_exact \
          "$values_path" freeze-bundle-v1 process-local || return 1
      elif [[ "$process_local_scope" == cold-rebind-target ]]; then
        recovery_require_live_process_local_cold_rebind_target_exact \
          "$values_path" || return 1
      else
        recovery_require_live_process_local_runner_exact "$values_path" || return 1
      fi
      ;;
    kubernetes-pod)
      # Any isolated-runner signal selects this branch.  A partial bootstrap,
      # admission, restore-fence or drifted setup must fail here and must never
      # fall back to the legacy authorization path.
      recovery_require_live_runner_active_control_plane_exact "$values_path" || return 1
      ;;
    *)
      return 1
      ;;
  esac
  printf '%s\n' "$candidate_mode"
}

recovery_resource_identity_tsv() {
  local scope="$1" resource="$2" name="$3" namespace="${4:-}"
  if [[ "$scope" == namespaced ]]; then
    recovery_kubectl get "$resource" "$name" -n "$namespace" \
      -o 'jsonpath={.apiVersion}{"\t"}{.kind}{"\t"}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.metadata.uid}'
  elif [[ "$scope" == cluster ]]; then
    recovery_kubectl get "$resource" "$name" \
      -o 'jsonpath={.apiVersion}{"\t"}{.kind}{"\t"}{.metadata.name}{"\t"}{.metadata.uid}'
  else
    return 2
  fi
}

recovery_require_live_runner_control_plane_matches_checkpoint() {
  local inventory_path="$1" mode target_mode="${RESTORE_TARGET_MODE:-in-place}" expected_uid identity
  local api_version kind namespace name uid extra expected_namespace
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  mode="$(jq -er '.bot_runner_runtime.mode' "$inventory_path")" || return 1
  [[ "$mode" == kubernetes-pod ]] || return 0
  [[ "$(jq -er '.schema_version' "$inventory_path")" == 4 ]] || return 1
  [[ "$target_mode" == in-place ]] || return 1

  expected_uid="$(jq -er '
    [.bot_runner_runtime.control_plane.namespaces[] |
      select(.name == "hcce-bot-runners") | .uid] |
    select(length == 1) | .[0]
  ' "$inventory_path")" || return 1
  identity="$(recovery_resource_identity_tsv cluster namespace hcce-bot-runners)" || return 1
  IFS=$'\t' read -r api_version kind name uid extra <<<"$identity"
  [[ -z "${extra:-}" && "$api_version" == v1 && "$kind" == Namespace &&
     "$name" == hcce-bot-runners && "$uid" == "$expected_uid" ]] || return 1

  while IFS='|' read -r resource expected_api expected_kind expected_namespace expected_name; do
    expected_uid="$(jq -er --arg api "$expected_api" --arg kind "$expected_kind" \
      --arg namespace "$expected_namespace" --arg name "$expected_name" '
      [.bot_runner_runtime.control_plane.namespaced_resources[] |
        select(.api_version == $api and .kind == $kind and
          .namespace == $namespace and .name == $name) | .uid] |
      select(length == 1) | .[0]
    ' "$inventory_path")" || return 1
    identity="$(recovery_resource_identity_tsv namespaced "$resource" \
      "$expected_name" "$expected_namespace")" || return 1
    IFS=$'\t' read -r api_version kind namespace name uid extra <<<"$identity"
    [[ -z "${extra:-}" && "$api_version" == "$expected_api" &&
       "$kind" == "$expected_kind" && "$namespace" == "$expected_namespace" &&
       "$name" == "$expected_name" && "$uid" == "$expected_uid" ]] || return 1
  done <<RUNNER_RESOURCES
serviceaccount|v1|ServiceAccount|$NAMESPACE|bot-orchestrator
role|rbac.authorization.k8s.io/v1|Role|$NAMESPACE|bot-orchestrator-runner-pods
rolebinding|rbac.authorization.k8s.io/v1|RoleBinding|$NAMESPACE|bot-orchestrator-runner-pods
configmap|v1|ConfigMap|$NAMESPACE|yenhubs-runner-cutover-v2
secret|v1|Secret|hcce-bot-runners|bot-images-pull
serviceaccount|v1|ServiceAccount|hcce-bot-runners|bot-runner
serviceaccount|v1|ServiceAccount|hcce-bot-runners|bot-runner-guard
resourcequota|v1|ResourceQuota|hcce-bot-runners|bot-runner-capacity
resourcequota|v1|ResourceQuota|hcce-bot-runners|bot-runner-guard-capacity
role|rbac.authorization.k8s.io/v1|Role|hcce-bot-runners|bot-orchestrator-runner-pods
rolebinding|rbac.authorization.k8s.io/v1|RoleBinding|hcce-bot-runners|bot-orchestrator-runner-pods
networkpolicy|networking.k8s.io/v1|NetworkPolicy|hcce-bot-runners|bot-runner-default-deny
networkpolicy|networking.k8s.io/v1|NetworkPolicy|hcce-bot-runners|bot-runner-egress
RUNNER_RESOURCES
  while IFS='|' read -r resource expected_api expected_kind expected_name; do
    expected_uid="$(jq -er --arg api "$expected_api" --arg kind "$expected_kind" \
      --arg name "$expected_name" '
      [.bot_runner_runtime.control_plane.cluster_resources[] |
        select(.api_version == $api and .kind == $kind and .name == $name) | .uid] |
      select(length == 1) | .[0]
    ' "$inventory_path")" || return 1
    identity="$(recovery_resource_identity_tsv cluster "$resource" "$expected_name")" || return 1
    IFS=$'\t' read -r api_version kind name uid extra <<<"$identity"
    [[ -z "${extra:-}" && "$api_version" == "$expected_api" &&
       "$kind" == "$expected_kind" && "$name" == "$expected_name" &&
       "$uid" == "$expected_uid" ]] || return 1
  done <<'RUNNER_CLUSTER_RESOURCES'
validatingadmissionpolicy|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicy|bot-runner-pods.yenhubs.org
validatingadmissionpolicybinding|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicyBinding|bot-runner-pods.yenhubs.org
validatingadmissionpolicy|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicy|bot-runner-durable-protocol.yenhubs.org
validatingadmissionpolicybinding|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicyBinding|bot-runner-durable-protocol.yenhubs.org
validatingadmissionpolicy|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicy|yenhubs-runner-cutover-journal-v2
validatingadmissionpolicybinding|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicyBinding|yenhubs-runner-cutover-journal-v2
validatingadmissionpolicy|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicy|bot-orchestrator-fence-protocol.yenhubs.org
validatingadmissionpolicybinding|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicyBinding|bot-orchestrator-fence-protocol.yenhubs.org
validatingadmissionpolicy|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicy|recovery-operation-pod-fence.yenhubs.org
validatingadmissionpolicybinding|admissionregistration.k8s.io/v1|ValidatingAdmissionPolicyBinding|recovery-operation-pod-fence.yenhubs.org
RUNNER_CLUSTER_RESOURCES
}

recovery_require_checkpoint_generation_matches_live() {
  local inventory_path="$1" values_path="$2" expected_generation mode
  local checkpoint_epoch live_epoch
  expected_generation="${RECOVERY_CHECKPOINT_RUNNER_GENERATION:-$(jq -er '
    if .schema_version == 3 then "legacy-absent"
    else .bot_runner_runtime.generation end
  ' "$inventory_path")}" || return 1
  mode="$(jq -er '.bot_runner_runtime.mode' "$inventory_path")" || return 1
  case "$expected_generation" in
    legacy-absent)
      [[ "$mode" == process-local ]] || return 1
      if [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind ]]; then
        recovery_require_live_process_local_cold_rebind_target_exact \
          "$values_path"
      else
        recovery_require_live_process_local_runner_exact "$values_path"
      fi
      ;;
    durable-v2)
      [[ "$mode" == kubernetes-pod ]] || return 1
      [[ "$(recovery_require_checkpoint_runner_mode_exact \
        "$values_path" kubernetes-pod)" == kubernetes-pod ]] || return 1
      recovery_require_live_runner_control_plane_matches_checkpoint \
        "$inventory_path" || return 1
      checkpoint_epoch="$(jq -er '
        .bot_runner_runtime.recovery_epoch |
        select(.state == "bound") |
        .value | select(type == "string" and
          test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"))
      ' "$inventory_path")" || return 1
      live_epoch="$(recovery_live_runner_epoch)" || return 1
      [[ "$live_epoch" == "$checkpoint_epoch" ]] || {
        printf 'Live durable runner epoch does not match the checkpoint pre-fence epoch.\n' >&2
        return 1
      }
      ;;
    *)
      return 1
      ;;
  esac
}

recovery_require_live_images_match_checkpoint() {
  local inventory_path="$1" deployments_json inventory_namespace
  inventory_namespace="$NAMESPACE"
  if [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind ]]; then
    # The frozen inventory is source evidence. Its namespace is already bound
    # to freeze metadata and checksums; a reconstructed target may use another
    # namespace name as well as new UIDs. Validate the inventory against its
    # recorded source name, then compare only its image projection to live.
    inventory_namespace="$(jq -er \
      '.namespace | select(type == "string" and length > 0)' \
      "$inventory_path")" || return 1
  fi
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$inventory_namespace" || return 1
  deployments_json="$(
    recovery_kubectl_get_namespaced_list deployments "$NAMESPACE"
  )" || return 1
  jq -e --argjson live "$deployments_json" '
    def projection($items):
      [$items[] | {
        name:.metadata.name,
        init_containers:[(.spec.template.spec.initContainers // [])[] |
          {name:.name,image:.image}] | sort_by(.name),
        containers:[.spec.template.spec.containers[] |
          {name:.name,image:.image}] | sort_by(.name)
      }] | sort_by(.name);
    ($live | type == "object" and (.items | type) == "array") and
    (projection($live.items) ==
      ([.deployments[] | {
        name:.name,init_containers:.init_containers,containers:.containers
      }] | sort_by(.name)))
  ' "$inventory_path" >/dev/null
}

recovery_checkpoint_image_for_pair() {
  local inventory_path="$1"
  local pair="$2"
  local trusted_repository="$3"
  local deployment_name container_name image
  [[ "$pair" == */* && "$trusted_repository" =~ ^[A-Za-z0-9._/-]+$ ]] || return 2
  deployment_name="${pair%%/*}"
  container_name="${pair#*/}"
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  image="$(jq -er \
    --arg deployment "$deployment_name" --arg container "$container_name" '
      [.deployments[] | select(.name == $deployment) | .containers[] |
        select(.name == $container) | .image] |
      select(length == 1) | .[0]
    ' "$inventory_path")" || return 1
  [[ "$image" =~ @sha256:[a-fA-F0-9]{64}$ &&
     "${image%@sha256:*}" == "$trusted_repository" ]] || return 1
  printf '%s\n' "$image"
}

recovery_set_materialized_checkpoint_cleanup_allowlist() {
  local stamp="$1" metadata_schema="$2" artifact
  local -a cleanup_paths=(
    "f:.yenhubs-recovery-owner"
    "d:checkpoint"
    "f:checkpoint/SHA256SUMS"
  )
  [[ "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ &&
     ( "$metadata_schema" == 2 || "$metadata_schema" == 3 ||
       "$metadata_schema" == freeze-bundle-v1 ) ]] || return 2
  if [[ "$metadata_schema" == freeze-bundle-v1 ]]; then
    while IFS= read -r artifact; do
      cleanup_paths+=("f:checkpoint/$artifact")
    done < <(recovery_freeze_bundle_artifacts "$stamp")
  else
    while IFS= read -r artifact; do
      cleanup_paths+=("f:checkpoint/$artifact")
    done < <(recovery_checkpoint_artifacts "$stamp" "$metadata_schema")
  fi
  RECOVERY_MATERIALIZED_ALLOWED_PATHS=("${cleanup_paths[@]}")
}

recovery_materialize_checkpoint() {
  local input_artifact="$1"
  local validator="$2"
  local directory stamp dump_name storage_name contract_name inventory_name evidence_name artifact
  local metadata_schema runner_generation evidence_digest=""
  local dump_digest storage_digest inventory_digest
  local materialized_dir materialized_parent materialized_base checkpoint_copy_dir
  local materialized_private_token="" materialized_setup_status=0
  local materialized_pending_signal_status=0
  local saved_int_trap saved_term_trap
  local metadata_copy_digest manifest_copy_digest source_metadata_digest source_manifest_digest
  if ! recovery_cleanup_materialized_checkpoint; then
    printf 'A previous private checkpoint snapshot could not be retired exactly.\n' >&2
    return 1
  fi
  if ! recovery_require_regular_direct_file "$input_artifact"; then
    printf 'Restore artifacts must be regular files, not links.\n' >&2
    return 1
  fi
  if ! stamp="$(recovery_checkpoint_stamp_from_artifact "$input_artifact")"; then
    printf 'Restore artifact name does not contain a valid checkpoint stamp.\n' >&2
    return 1
  fi
  directory="$(cd "$(dirname "$input_artifact")" && pwd -P)"
  dump_name="retdb-$stamp.sql.gz"
  storage_name="ret-storage-$stamp.tar.gz"
  contract_name="database-contract.json"
  inventory_name="deployment-images.json"
  evidence_name="runner-cutover-evidence.json"
  saved_int_trap="$(trap -p INT)"
  saved_term_trap="$(trap -p TERM)"
  # Record the first cooperative interruption in the parent while each child
  # ignores it across mktemp, token capture and marker publication. Ownership
  # becomes usable before the original caller trap receives the deferred
  # signal; SIGKILL can still leave an unavoidable private orphan.
  trap 'if [[ "$materialized_pending_signal_status" == 0 ]]; then materialized_pending_signal_status=130; trap "" INT TERM; fi' INT
  trap 'if [[ "$materialized_pending_signal_status" == 0 ]]; then materialized_pending_signal_status=143; trap "" INT TERM; fi' TERM
  if ! materialized_dir="$(
      trap '' INT TERM
      mktemp -d "${TMPDIR:-/tmp}/yenhubs-restore-$stamp.XXXXXX"
    )"; then
    materialized_setup_status=1
  elif ! materialized_parent="$(
      trap '' INT TERM
      cd "$(dirname "$materialized_dir")" && pwd -P
    )"; then
    materialized_setup_status=1
  else
    materialized_base="$(basename "$materialized_dir")"
    if [[ ! "$materialized_base" =~ ^yenhubs-restore-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$ ]]; then
      materialized_setup_status=1
    else
      materialized_dir="$materialized_parent/$materialized_base"
      if ! materialized_private_token="$(
          trap '' INT TERM
          recovery_capture_private_directory_token "$materialized_dir"
        )"; then
        materialized_setup_status=1
      elif ! (trap '' INT TERM; umask 077; set -C; printf '%s\n' \
          yenhubs-recovery-materialized-v1 \
          >"$materialized_dir/.yenhubs-recovery-owner") 2>/dev/null; then
        materialized_setup_status=1
      else
        RECOVERY_MATERIALIZED_DIR="$materialized_dir"
        RECOVERY_MATERIALIZED_PARENT="$materialized_parent"
        RECOVERY_MATERIALIZED_MARKER="$materialized_dir/.yenhubs-recovery-owner"
        RECOVERY_MATERIALIZED_PRIVATE_TOKEN="$materialized_private_token"
        RECOVERY_MATERIALIZED_ALLOWED_PATHS=(
          "f:.yenhubs-recovery-owner"
          "d:checkpoint"
          "f:checkpoint/checkpoint-metadata.json"
          "f:checkpoint/SHA256SUMS"
        )
        RECOVERY_MATERIALIZED_CLEANUP_ATTEMPTED=0
        RECOVERY_MATERIALIZED_RETIRED=0
        RECOVERY_MATERIALIZED_OWNED=1
      fi
    fi
  fi
  # trap -p emits shell-owned syntax; restoring that exact trusted output is
  # the only Bash 3.2-compatible way to preserve an arbitrary caller handler.
  # shellcheck disable=SC2294
  if [[ -n "$saved_int_trap" ]]; then eval "$saved_int_trap"; else trap - INT; fi
  # shellcheck disable=SC2294
  if [[ -n "$saved_term_trap" ]]; then eval "$saved_term_trap"; else trap - TERM; fi
  if [[ "$materialized_pending_signal_status" == 130 ]]; then
    kill -INT "${BASHPID:-$$}"
    return 130
  elif [[ "$materialized_pending_signal_status" == 143 ]]; then
    kill -TERM "${BASHPID:-$$}"
    return 143
  fi
  if [[ "$materialized_setup_status" != 0 ]]; then
    printf 'Could not bind the private checkpoint directory identity and marker; any empty orphan was preserved.\n' >&2
    return 1
  fi
  checkpoint_copy_dir="$materialized_dir/checkpoint"
  if ! (umask 077; mkdir -- "$checkpoint_copy_dir"); then
    recovery_cleanup_materialized_checkpoint || :
    printf 'Could not create the private checkpoint snapshot directory.\n' >&2
    return 1
  fi

  # The metadata and digest manifest define one immutable checkpoint view. Copy
  # them first and never derive restore authority from the mutable source again.
  for artifact in checkpoint-metadata.json SHA256SUMS; do
    if ! recovery_require_regular_direct_file "$directory/$artifact" ||
       ! COPYFILE_DISABLE=1 command cp "$directory/$artifact" \
         "$checkpoint_copy_dir/$artifact" ||
       ! chmod 600 "$checkpoint_copy_dir/$artifact"; then
      recovery_cleanup_materialized_checkpoint || :
      printf 'Could not materialize private checkpoint metadata.\n' >&2
      return 1
    fi
  done
  if jq -e '.schema == "freeze-bundle-v1"' \
      "$checkpoint_copy_dir/checkpoint-metadata.json" >/dev/null 2>&1; then
    metadata_schema=freeze-bundle-v1
  else
    metadata_schema="$(recovery_checkpoint_metadata_schema "$checkpoint_copy_dir")" || {
      recovery_cleanup_materialized_checkpoint || :
      printf 'Checkpoint metadata schema is missing or unsupported.\n' >&2
      return 1
    }
  fi
  if ! recovery_set_materialized_checkpoint_cleanup_allowlist \
      "$stamp" "$metadata_schema"; then
    recovery_cleanup_materialized_checkpoint || :
    printf 'Could not bind the materialized checkpoint cleanup contract.\n' >&2
    return 1
  fi
  if [[ "$metadata_schema" == freeze-bundle-v1 ]]; then
    recovery_validate_freeze_bundle_layout "$directory" "$stamp" || {
      recovery_cleanup_materialized_checkpoint || :
      return 1
    }
    while IFS= read -r artifact; do
      [[ "$artifact" != checkpoint-metadata.json ]] || continue
      if ! recovery_require_regular_direct_file "$directory/$artifact" ||
         ! COPYFILE_DISABLE=1 command cp "$directory/$artifact" \
           "$checkpoint_copy_dir/$artifact" ||
         ! chmod 600 "$checkpoint_copy_dir/$artifact"; then
        recovery_cleanup_materialized_checkpoint || :
        printf 'Could not materialize the freeze bundle artifacts.\n' >&2
        return 1
      fi
    done < <(recovery_freeze_bundle_artifacts "$stamp")
  else
    recovery_validate_checkpoint_layout "$directory" "$stamp" "$metadata_schema" || {
      recovery_cleanup_materialized_checkpoint || :
      return 1
    }
    while IFS= read -r artifact; do
      [[ "$artifact" != checkpoint-metadata.json ]] || continue
      if ! recovery_require_regular_direct_file "$directory/$artifact" ||
         ! COPYFILE_DISABLE=1 command cp "$directory/$artifact" \
           "$checkpoint_copy_dir/$artifact" ||
         ! chmod 600 "$checkpoint_copy_dir/$artifact"; then
        recovery_cleanup_materialized_checkpoint || :
        printf 'Could not materialize the checkpoint artifacts.\n' >&2
        return 1
      fi
    done < <(recovery_checkpoint_artifacts "$stamp" "$metadata_schema")
  fi

  if [[ "$metadata_schema" == freeze-bundle-v1 ]]; then
    recovery_verify_freeze_bundle_directory "$checkpoint_copy_dir" "$stamp"
  else
    recovery_verify_checkpoint_directory "$checkpoint_copy_dir" "$stamp"
  fi || {
    recovery_cleanup_materialized_checkpoint || :
    printf 'Private checkpoint snapshot failed integrity validation.\n' >&2
    return 1
  }
  if [[ "$metadata_schema" == freeze-bundle-v1 ]]; then
    if ! dump_digest="$(recovery_sha256_digest "$checkpoint_copy_dir/$dump_name")" ||
       ! storage_digest="$(recovery_sha256_digest "$checkpoint_copy_dir/$storage_name")" ||
       ! inventory_digest="$(recovery_sha256_digest "$checkpoint_copy_dir/$inventory_name")"; then
      recovery_cleanup_materialized_checkpoint || :
      printf 'Could not resolve exact freeze bundle artifact digests.\n' >&2
      return 1
    fi
  elif ! dump_digest="$(recovery_checkpoint_digest_for "$checkpoint_copy_dir" "$dump_name")" ||
       ! storage_digest="$(recovery_checkpoint_digest_for "$checkpoint_copy_dir" "$storage_name")" ||
       ! inventory_digest="$(recovery_checkpoint_digest_for "$checkpoint_copy_dir" "$inventory_name")"; then
    recovery_cleanup_materialized_checkpoint || :
    printf 'Could not resolve exact checkpoint artifact digests.\n' >&2
    return 1
  fi
  if [[ "$metadata_schema" == 3 ]] &&
     ! evidence_digest="$(recovery_checkpoint_digest_for \
       "$checkpoint_copy_dir" "$evidence_name")"; then
    recovery_cleanup_materialized_checkpoint || :
    printf 'Could not resolve the runner cutover evidence digest.\n' >&2
    return 1
  fi
  if ! "$validator" "$checkpoint_copy_dir/$dump_name" \
    "$checkpoint_copy_dir/$storage_name" >/dev/null; then
    recovery_cleanup_materialized_checkpoint || :
    printf 'Materialized checkpoint pair failed joint validation.\n' >&2
    return 1
  fi

  # A concurrent publication or directory replacement must not silently turn
  # the private view into an A/B mixture. Revalidate the source and require its
  # defining metadata and manifest to remain byte-identical to the private view.
  if [[ "$metadata_schema" == freeze-bundle-v1 ]]; then
    recovery_verify_freeze_bundle_directory "$directory" "$stamp"
  else
    recovery_validate_checkpoint_layout "$directory" "$stamp" "$metadata_schema" &&
      recovery_validate_sha256_manifest "$directory" "$stamp" "$metadata_schema"
  fi || {
    recovery_cleanup_materialized_checkpoint || :
    printf 'Checkpoint source changed while it was being materialized.\n' >&2
    return 1
  }
  if ! metadata_copy_digest="$(recovery_sha256_digest \
       "$checkpoint_copy_dir/checkpoint-metadata.json")" ||
     ! manifest_copy_digest="$(recovery_sha256_digest \
       "$checkpoint_copy_dir/SHA256SUMS")" ||
     ! source_metadata_digest="$(recovery_sha256_digest \
       "$directory/checkpoint-metadata.json")" ||
     ! source_manifest_digest="$(recovery_sha256_digest "$directory/SHA256SUMS")" ||
     [[ "$source_metadata_digest" != "$metadata_copy_digest" ||
        "$source_manifest_digest" != "$manifest_copy_digest" ]]; then
    recovery_cleanup_materialized_checkpoint || :
    printf 'Checkpoint source changed while it was being materialized.\n' >&2
    return 1
  fi

  RECOVERY_CHECKPOINT_STAMP="$stamp"
  RECOVERY_DUMP_SHA256="$dump_digest"
  RECOVERY_STORAGE_SHA256="$storage_digest"
  RECOVERY_DUMP_COPY="$checkpoint_copy_dir/$dump_name"
  RECOVERY_STORAGE_COPY="$checkpoint_copy_dir/$storage_name"
  RECOVERY_DATABASE_CONTRACT_COPY="$checkpoint_copy_dir/$contract_name"
  RECOVERY_DEPLOYMENT_INVENTORY_COPY="$checkpoint_copy_dir/$inventory_name"
  RECOVERY_CHECKPOINT_METADATA_COPY="$checkpoint_copy_dir/checkpoint-metadata.json"
  RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$inventory_digest"
  RECOVERY_CHECKPOINT_METADATA_SCHEMA="$metadata_schema"
  if [[ "$metadata_schema" == freeze-bundle-v1 ]]; then
    RECOVERY_CHECKPOINT_OPERATION_ID="$(jq -er '
      .operation.id | select(type == "string" and test("^[a-f0-9]{32}$"))
    ' "$RECOVERY_CHECKPOINT_METADATA_COPY")"
    RECOVERY_FREEZE_ID="$(jq -er '
      .freeze_id | select(type == "string" and test("^[a-f0-9]{32}$"))
    ' "$RECOVERY_CHECKPOINT_METADATA_COPY")"
    RECOVERY_FREEZE_CLIENT_INSTANCE_ID="$(jq -er '
      .client_instance_id | select(type == "string" and
        test("^[a-z0-9][a-z0-9-]{2,62}$"))
    ' "$RECOVERY_CHECKPOINT_METADATA_COPY")"
    RECOVERY_FREEZE_SOURCE_CLUSTER_UID="$(jq -er \
      '.source.cluster.uid | select(type == "string" and length > 0)' \
      "$RECOVERY_CHECKPOINT_METADATA_COPY")"
    RECOVERY_FREEZE_MANIFEST_SHA256="$manifest_copy_digest"
  else
    RECOVERY_CHECKPOINT_OPERATION_ID="$(jq -er '
      .operation_id | select(type == "string" and test("^[a-f0-9]{32}$"))
    ' "$RECOVERY_CHECKPOINT_METADATA_COPY")"
    RECOVERY_FREEZE_ID=""
    RECOVERY_FREEZE_CLIENT_INSTANCE_ID=""
    RECOVERY_FREEZE_SOURCE_CLUSTER_UID=""
    RECOVERY_FREEZE_MANIFEST_SHA256=""
  fi || {
    recovery_cleanup_materialized_checkpoint || :
    return 1
  }
  if [[ "$metadata_schema" == freeze-bundle-v1 ]]; then
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY=""
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256="$inventory_digest"
    RECOVERY_CHECKPOINT_RUNNER_GENERATION=legacy-absent
    RECOVERY_RUNNER_RUNTIME_GENERATION=legacy-absent
  elif [[ "$metadata_schema" == 3 ]]; then
    runner_generation="$(jq -er '
      .runtime_generation | select(. == "legacy-absent" or . == "durable-v2")
    ' "$RECOVERY_CHECKPOINT_METADATA_COPY")" || {
      recovery_cleanup_materialized_checkpoint || :
      return 1
    }
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY="$checkpoint_copy_dir/$evidence_name"
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256="$evidence_digest"
    RECOVERY_CHECKPOINT_RUNNER_GENERATION="$runner_generation"
    RECOVERY_RUNNER_RUNTIME_GENERATION="$runner_generation"
  else
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY=""
    # Historical schema-2 checkpoints predate the standalone evidence file.
    # Their checksummed schema-3 deployment inventory is the exact legacy
    # absence proof, so its digest is the lock binding for this generation.
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256="$inventory_digest"
    RECOVERY_CHECKPOINT_RUNNER_GENERATION=legacy-absent
    RECOVERY_RUNNER_RUNTIME_GENERATION=legacy-absent
  fi
  if [[ "$metadata_schema" == freeze-bundle-v1 ]]; then
    RECOVERY_CHECKPOINT_NAMESPACE_UID="$(jq -er \
      '.source.namespace.uid | select(type == "string" and length > 0)' \
      "$RECOVERY_CHECKPOINT_METADATA_COPY")"
    RECOVERY_CHECKPOINT_PVC_UID="$(jq -er \
      '.source.pvc.uid | select(type == "string" and length > 0)' \
      "$RECOVERY_CHECKPOINT_METADATA_COPY")"
  else
    RECOVERY_CHECKPOINT_NAMESPACE_UID="$(jq -er \
      '.namespace_uid | select(type == "string" and length > 0)' \
      "$RECOVERY_CHECKPOINT_METADATA_COPY")"
    RECOVERY_CHECKPOINT_PVC_UID="$(jq -er \
      '.ret_pvc_uid | select(type == "string" and length > 0)' \
      "$RECOVERY_CHECKPOINT_METADATA_COPY")"
  fi || {
    recovery_cleanup_materialized_checkpoint || :
    return 1
  }
}

recovery_cleanup_materialized_checkpoint() {
  if [[ "${RECOVERY_MATERIALIZED_OWNED:-0}" == 1 ]]; then
    if [[ "${RECOVERY_MATERIALIZED_RETIRED:-0}" == 1 ||
          -z "${RECOVERY_MATERIALIZED_DIR:-}" ||
          -z "${RECOVERY_MATERIALIZED_PARENT:-}" ||
          "${RECOVERY_MATERIALIZED_DIR:-}" != \
            "${RECOVERY_MATERIALIZED_PARENT:-}/"* ||
          "${RECOVERY_MATERIALIZED_MARKER:-}" != \
            "${RECOVERY_MATERIALIZED_DIR:-}/.yenhubs-recovery-owner" ]]; then
      RECOVERY_MATERIALIZED_CLEANUP_ATTEMPTED=1
      printf 'Private materialized checkpoint ownership state is inconsistent; refusing cleanup or reuse.\n' >&2
      return 1
    fi
    if [[ "${RECOVERY_MATERIALIZED_CLEANUP_ATTEMPTED:-0}" == 1 ]]; then
      printf 'Private materialized checkpoint cleanup is latched failed; refusing to reuse this process.\n' >&2
      return 1
    fi
    RECOVERY_MATERIALIZED_CLEANUP_ATTEMPTED=1
    if ! recovery_cleanup_marked_private_directory \
        "${RECOVERY_MATERIALIZED_PRIVATE_TOKEN:-}" \
        .yenhubs-recovery-owner yenhubs-recovery-materialized-v1 \
        "${RECOVERY_MATERIALIZED_ALLOWED_PATHS[@]}"; then
      # Retain every capability and OWNED=1 as a terminal latch. A second
      # materialization in this process must observe the failed retirement and
      # cannot silently replace the state with a new private snapshot.
      printf 'Private materialized checkpoint cleanup failed closed; any exact empty orphan or replacement was preserved.\n' >&2
      return 1
    fi
    RECOVERY_MATERIALIZED_RETIRED=1
    RECOVERY_MATERIALIZED_OWNED=0
  fi
  RECOVERY_MATERIALIZED_DIR=""
  RECOVERY_MATERIALIZED_PARENT=""
  RECOVERY_MATERIALIZED_MARKER=""
  RECOVERY_MATERIALIZED_PRIVATE_TOKEN=""
  RECOVERY_MATERIALIZED_OWNED=0
  RECOVERY_MATERIALIZED_ALLOWED_PATHS=()
  # shellcheck disable=SC2034
  RECOVERY_DUMP_COPY=""
  # shellcheck disable=SC2034
  RECOVERY_STORAGE_COPY=""
  # shellcheck disable=SC2034
  RECOVERY_DATABASE_CONTRACT_COPY=""
  # shellcheck disable=SC2034
  RECOVERY_DEPLOYMENT_INVENTORY_COPY=""
  # shellcheck disable=SC2034
  RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY=""
  # shellcheck disable=SC2034
  RECOVERY_CHECKPOINT_METADATA_COPY=""
  RECOVERY_CHECKPOINT_STAMP=""
  RECOVERY_DUMP_SHA256=""
  RECOVERY_STORAGE_SHA256=""
  # shellcheck disable=SC2034
  RECOVERY_DEPLOYMENT_INVENTORY_SHA256=""
  RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256=""
  # shellcheck disable=SC2034
  RECOVERY_CHECKPOINT_METADATA_SCHEMA=""
  RECOVERY_CHECKPOINT_RUNNER_GENERATION=""
  RECOVERY_RUNNER_RUNTIME_GENERATION=""
  RECOVERY_CHECKPOINT_OPERATION_ID=""
  RECOVERY_CHECKPOINT_NAMESPACE_UID=""
  RECOVERY_CHECKPOINT_PVC_UID=""
  RECOVERY_FREEZE_ID=""
  RECOVERY_FREEZE_CLIENT_INSTANCE_ID=""
  RECOVERY_FREEZE_SOURCE_CLUSTER_UID=""
  RECOVERY_FREEZE_MANIFEST_SHA256=""
  RECOVERY_TARGET_CLUSTER_UID=""
  return 0
}

recovery_dump_copy_row_count() {
  local sql_path="$1"
  local table_name="$2"
  awk -v table_name="$table_name" '
    BEGIN { in_copy=0; copy_headers=0; copy_blocks=0; rows=0; failed=0 }
    $0 ~ ("^COPY ret0\\." table_name "([ (])") {
      copy_headers++
      if ($0 !~ ("^COPY ret0\\." table_name " \\([^)]*\\) FROM stdin;$")) {
        failed=1
        next
      }
      if (in_copy || copy_blocks > 0) {
        failed=1
        next
      }
      in_copy=1
      copy_blocks++
      next
    }
    in_copy && $0 == "\\." { in_copy=0; next }
    in_copy { rows++ }
    END {
      if (failed || copy_headers != 1 || copy_blocks != 1 || in_copy) exit 2
      print rows
    }
  ' "$sql_path"
}

recovery_extract_active_owned_file_uuids() {
  local sql_path="$1"
  awk '
    BEGIN {
      in_owned_files=0
      copy_headers=0
      copy_blocks=0
      uuid_column=0
      state_column=0
      active_count=0
      failed=0
    }
    /^COPY ret0\.owned_files([ (])/ {
      copy_headers++
      if ($0 !~ /^COPY ret0\.owned_files \([^)]*\) FROM stdin;$/) {
        failed=1
        next
      }
      if (in_owned_files || copy_blocks > 0) {
        failed=1
        next
      }
      columns=$0
      sub(/^COPY ret0\.owned_files \(/, "", columns)
      sub(/\) FROM stdin;$/, "", columns)
      column_count=split(columns, names, /,[[:space:]]*/)
      for (column_index=1; column_index<=column_count; column_index++) {
        if (names[column_index] == "owned_file_uuid") uuid_column=column_index
        if (names[column_index] == "state") state_column=column_index
      }
      if (uuid_column == 0 || state_column == 0) {
        failed=1
        next
      }
      copy_blocks++
      in_owned_files=1
      next
    }
    in_owned_files && $0 == "\\." { in_owned_files=0; next }
    in_owned_files {
      value_count=split($0, values, "\t")
      if (value_count < uuid_column || value_count < state_column) {
        failed=1
        next
      }
      if (values[state_column] == "active") active_values[++active_count]=values[uuid_column]
    }
    END {
      if (failed || copy_headers != 1 || copy_blocks != 1 || in_owned_files) exit 2
      for (item_index=1; item_index<=active_count; item_index++) print active_values[item_index]
    }
  ' "$sql_path"
}

recovery_extract_copy_column_values() {
  local sql_path="$1"
  local table_name="$2"
  local column_name="$3"
  [[ "$table_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$column_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 2
  awk -v table_name="$table_name" -v column_name="$column_name" '
    BEGIN { in_copy=0; headers=0; blocks=0; target_column=0; count=0; failed=0 }
    $0 ~ ("^COPY ret0\\." table_name "([ (])") {
      headers++
      if ($0 !~ ("^COPY ret0\\." table_name " \\([^)]*\\) FROM stdin;$") || in_copy || blocks > 0) {
        failed=1
        next
      }
      columns=$0
      sub("^COPY ret0\\." table_name " \\(", "", columns)
      sub(/\) FROM stdin;$/, "", columns)
      column_count=split(columns, names, /,[[:space:]]*/)
      for (column_index=1; column_index<=column_count; column_index++) {
        if (names[column_index] == column_name) target_column=column_index
      }
      if (target_column == 0) { failed=1; next }
      blocks++
      in_copy=1
      next
    }
    in_copy && $0 == "\\." { in_copy=0; next }
    in_copy {
      value_count=split($0, values, "\t")
      if (value_count < target_column || values[target_column] == "" || values[target_column] == "\\N") {
        failed=1
        next
      }
      output[++count]=values[target_column]
    }
    END {
      if (failed || headers != 1 || blocks != 1 || in_copy || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print output[item_index]
    }
  ' "$sql_path"
}

recovery_extract_owned_file_inventory() {
  local sql_path="$1"
  awk '
    BEGIN { in_copy=0; headers=0; blocks=0; uuid_column=0; state_column=0; count=0; failed=0 }
    /^COPY ret0\.owned_files([ (])/ {
      headers++
      if ($0 !~ /^COPY ret0\.owned_files \([^)]*\) FROM stdin;$/ || in_copy || blocks > 0) {
        failed=1
        next
      }
      columns=$0
      sub(/^COPY ret0\.owned_files \(/, "", columns)
      sub(/\) FROM stdin;$/, "", columns)
      column_count=split(columns, names, /,[[:space:]]*/)
      for (column_index=1; column_index<=column_count; column_index++) {
        if (names[column_index] == "owned_file_uuid") uuid_column=column_index
        if (names[column_index] == "state") state_column=column_index
      }
      if (uuid_column == 0 || state_column == 0) { failed=1; next }
      blocks++
      in_copy=1
      next
    }
    in_copy && $0 == "\\." { in_copy=0; next }
    in_copy {
      value_count=split($0, values, "\t")
      if (value_count < uuid_column || value_count < state_column ||
          values[uuid_column] == "" || values[uuid_column] == "\\N" ||
          values[state_column] == "" || values[state_column] == "\\N") {
        failed=1
        next
      }
      output[++count]=values[uuid_column] "\t" values[state_column]
    }
    END {
      if (failed || headers != 1 || blocks != 1 || in_copy || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print output[item_index]
    }
  ' "$sql_path"
}

recovery_extract_migration_versions() {
  local sql_path="$1"
  awk '
    BEGIN { in_copy=0; headers=0; blocks=0; version_column=0; count=0; failed=0 }
    /^COPY ret0\.schema_migrations([ (])/ {
      headers++
      if ($0 !~ /^COPY ret0\.schema_migrations \([^)]*\) FROM stdin;$/ || in_copy || blocks > 0) {
        failed=1
        next
      }
      columns=$0
      sub(/^COPY ret0\.schema_migrations \(/, "", columns)
      sub(/\) FROM stdin;$/, "", columns)
      column_count=split(columns, names, /,[[:space:]]*/)
      for (column_index=1; column_index<=column_count; column_index++) {
        if (names[column_index] == "version") version_column=column_index
      }
      if (version_column == 0) { failed=1; next }
      blocks++
      in_copy=1
      next
    }
    in_copy && $0 == "\\." { in_copy=0; next }
    in_copy {
      value_count=split($0, values, "\t")
      if (value_count < version_column || values[version_column] !~ /^[0-9]+$/) {
        failed=1
        next
      }
      versions[++count]=values[version_column]
    }
    END {
      if (failed || headers != 1 || blocks != 1 || in_copy || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print versions[item_index]
    }
  ' "$sql_path"
}

recovery_extract_dump_relations() {
  local sql_path="$1"
  awk '
    function add_relation(definition, relation_type, cleaned, pieces, piece_count, key) {
      cleaned=definition
      sub(/^CREATE (FOREIGN )?(TABLE|VIEW) /, "", cleaned)
      if (relation_type == "VIEW") sub(/ AS$/, "", cleaned)
      else sub(/ \($/, "", cleaned)
      piece_count=split(cleaned, pieces, ".")
      if (piece_count != 2 ||
          pieces[1] !~ /^(coturn|ret0|ret0_admin)$/ ||
          pieces[2] !~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
        failed=1
        return
      }
      key=pieces[1] "/" pieces[2]
      if (seen[key]++) { failed=1; return }
      rows[++count]=pieces[1] "\t" pieces[2] "\t" relation_type
    }
    BEGIN { count=0; failed=0 }
    /^CREATE TABLE (coturn|ret0|ret0_admin)\.[A-Za-z_][A-Za-z0-9_]* \($/ {
      add_relation($0, "BASE TABLE")
      next
    }
    /^CREATE FOREIGN TABLE (coturn|ret0|ret0_admin)\.[A-Za-z_][A-Za-z0-9_]* \($/ {
      add_relation($0, "FOREIGN")
      next
    }
    /^CREATE VIEW (coturn|ret0|ret0_admin)\.[A-Za-z_][A-Za-z0-9_]* AS$/ {
      add_relation($0, "VIEW")
      next
    }
    /^CREATE (FOREIGN )?(TABLE|VIEW) (coturn|ret0|ret0_admin)\./ { failed=1 }
    END {
      if (failed || count == 0) exit 2
      for (item_index=1; item_index<=count; item_index++) print rows[item_index]
    }
  ' "$sql_path"
}

recovery_sql_dump_has_complete_marker() {
  awk '
    BEGIN {
      marker_count=0
      marker_line=0
      terminal_separator_count=0
      terminal_separator_line=0
      terminal_other=0
      restrict_count=0
      restrict_line=0
      restrict_token=""
      unrestrict_count=0
      unrestrict_line=0
      unrestrict_token=""
      last_nonempty=""
    }
    $0 == "-- PostgreSQL database dump complete" {
      marker_count++
      marker_line=NR
      last_nonempty=$0
      next
    }
    $1 == "\\restrict" {
      restrict_count++
      if (NF != 2 || $2 !~ /^[A-Za-z0-9]+$/ ||
          length($2) < 32 || length($2) > 128) invalid=1
      restrict_token=$2
      restrict_line=NR
      last_nonempty=$0
      next
    }
    $1 == "\\unrestrict" {
      unrestrict_count++
      if (NF != 2 || $2 !~ /^[A-Za-z0-9]+$/ ||
          length($2) < 32 || length($2) > 128) invalid=1
      unrestrict_token=$2
      unrestrict_line=NR
      last_nonempty=$0
      next
    }
    marker_count > 0 && NF {
      if ($0 == "--") {
        terminal_separator_count++
        terminal_separator_line=NR
      } else {
        terminal_other=1
      }
    }
    NF { last_nonempty=$0 }
    END {
      if (invalid || marker_count != 1 || terminal_other ||
          terminal_separator_count > 1) exit 2
      if (restrict_count == 0 && unrestrict_count == 0 &&
          (last_nonempty == "-- PostgreSQL database dump complete" ||
           (terminal_separator_count == 1 &&
            terminal_separator_line > marker_line &&
            last_nonempty == "--"))) exit 0
      if (restrict_count == 1 && unrestrict_count == 1 &&
          restrict_token == unrestrict_token &&
          restrict_line < marker_line && marker_line < unrestrict_line &&
          (terminal_separator_count == 0 ||
           (terminal_separator_count == 1 &&
            marker_line < terminal_separator_line &&
            terminal_separator_line < unrestrict_line)) &&
          last_nonempty == "\\unrestrict " unrestrict_token) exit 0
      exit 2
    }
  ' "$1"
}

recovery_validate_sql_dump_contract() {
  local sql_path="$1"
  local migrations_count hubs_count owned_files_count
  if ! migrations_count="$(recovery_dump_copy_row_count "$sql_path" schema_migrations)" ||
     ! hubs_count="$(recovery_dump_copy_row_count "$sql_path" hubs)" ||
     ! owned_files_count="$(recovery_dump_copy_row_count "$sql_path" owned_files)" ||
     ! recovery_sql_dump_has_complete_marker "$sql_path"; then
    return 1
  fi
  [[ "$migrations_count" =~ ^[0-9]+$ && "$migrations_count" -gt 0 &&
     "$hubs_count" =~ ^[0-9]+$ && "$hubs_count" -gt 0 &&
     "$owned_files_count" =~ ^[0-9]+$ && "$owned_files_count" -gt 0 ]]
}

recovery_validate_database_contract_against_dump() {
  local contract_path="$1"
  local sql_path="$2"
  local expected_sql_digest actual_sql_digest
  local migrations_count hubs_count owned_files_count active_count
  local expected_migrations expected_hubs expected_owned expected_active
  local dump_versions contract_versions dump_relations contract_relations
  local dump_hub_sids contract_hub_sids dump_owned_inventory contract_owned_inventory
  local dump_active_uuids contract_active_uuids
  recovery_database_contract_is_acceptable "$contract_path" || return 1
  recovery_validate_sql_dump_contract "$sql_path" || return 1
  expected_sql_digest="$(jq -er \
    '.sql_dump_sha256 | select(type == "string" and test("^[a-fA-F0-9]{64}$"))' \
    "$contract_path")" || return 1
  actual_sql_digest="$(recovery_sha256_digest "$sql_path")" || return 1
  [[ "$actual_sql_digest" == "$expected_sql_digest" ]] || return 1
  [[ "$(grep -Ec '^CREATE SCHEMA ret0;$' "$sql_path")" == "1" &&
     "$(grep -Ec '^CREATE SCHEMA ret0_admin;$' "$sql_path")" == "1" &&
     "$(grep -Ec '^CREATE SCHEMA coturn;$' "$sql_path")" == "1" ]] || return 1
  migrations_count="$(recovery_dump_copy_row_count "$sql_path" schema_migrations)" || return 1
  hubs_count="$(recovery_dump_copy_row_count "$sql_path" hubs)" || return 1
  owned_files_count="$(recovery_dump_copy_row_count "$sql_path" owned_files)" || return 1
  active_count="$(recovery_extract_active_owned_file_uuids "$sql_path" | sed '/^$/d' | wc -l | tr -d ' ')" || return 1
  expected_migrations="$(jq -r '.critical_counts.migrations' "$contract_path")" || return 1
  expected_hubs="$(jq -r '.critical_counts.hubs' "$contract_path")" || return 1
  expected_owned="$(jq -r '.critical_counts.owned_files' "$contract_path")" || return 1
  expected_active="$(jq -r '.critical_counts.active_owned_files' "$contract_path")" || return 1
  dump_versions="$(recovery_extract_migration_versions "$sql_path" | LC_ALL=C sort)" || return 1
  contract_versions="$(jq -r '.migration_versions[]' "$contract_path" | LC_ALL=C sort)" || return 1
  dump_relations="$(recovery_extract_dump_relations "$sql_path" | LC_ALL=C sort)" || return 1
  contract_relations="$(jq -r '.relations[] | [.schema, .name, .type] | @tsv' "$contract_path" | LC_ALL=C sort)" || return 1
  dump_hub_sids="$(recovery_extract_copy_column_values "$sql_path" hubs hub_sid | LC_ALL=C sort)" || return 1
  contract_hub_sids="$(jq -r '.critical_inventory.hub_sids[]' "$contract_path" | LC_ALL=C sort)" || return 1
  dump_owned_inventory="$(recovery_extract_owned_file_inventory "$sql_path" | LC_ALL=C sort)" || return 1
  contract_owned_inventory="$(jq -r '.critical_inventory.owned_files[] | [.uuid, .state] | @tsv' "$contract_path" | LC_ALL=C sort)" || return 1
  dump_active_uuids="$(recovery_extract_active_owned_file_uuids "$sql_path" | LC_ALL=C sort)" || return 1
  contract_active_uuids="$(jq -r '.critical_inventory.active_owned_file_uuids[]' "$contract_path" | LC_ALL=C sort)" || return 1
  [[ "$migrations_count" == "$expected_migrations" &&
     "$hubs_count" == "$expected_hubs" &&
     "$owned_files_count" == "$expected_owned" &&
     "$active_count" == "$expected_active" &&
     "$dump_versions" == "$contract_versions" &&
     "$dump_relations" == "$contract_relations" &&
     "$dump_hub_sids" == "$contract_hub_sids" &&
     "$dump_owned_inventory" == "$contract_owned_inventory" &&
     "$dump_active_uuids" == "$contract_active_uuids" ]]
}

# Reticulum stores each owned-file pair below two UUID-derived shard
# directories: owned/<uuid[0:2]>/<uuid[2:4]>/<uuid>.(blob|meta.json).
# Accept directory entries only at those exact depths and reject every other
# path before tar extraction or after a live PVC enumeration.
recovery_storage_path_stream_is_exact() {
  awk '
    BEGIN { failed=0; files=0 }
    /^owned\/?$/ { next }
    {
      path=$0
      if (path ~ /^owned\/[A-Za-z0-9._-]{2}\/$/) next
      if (path ~ /^owned\/[A-Za-z0-9._-]{2}\/[A-Za-z0-9._-]{2}\/$/) next
      if (path !~ /^owned\/[A-Za-z0-9._-]{2}\/[A-Za-z0-9._-]{2}\/[A-Za-z0-9._-]{4,}\.(blob|meta\.json)$/) {
        failed=1
        next
      }
      count=split(path, pieces, "/")
      if (count != 4) { failed=1; next }
      filename=pieces[4]
      uuid=filename
      sub(/\.meta\.json$/, "", uuid)
      sub(/\.blob$/, "", uuid)
      if (substr(uuid, 1, 2) != pieces[2] || substr(uuid, 3, 2) != pieces[3]) {
        failed=1
        next
      }
      files++
    }
    END { exit (failed || files == 0) ? 1 : 0 }
  '
}

recovery_storage_paths_file_is_exact() {
  local paths_file="$1"
  [[ -f "$paths_file" && ! -L "$paths_file" && -s "$paths_file" ]] || return 1
  recovery_storage_path_stream_is_exact <"$paths_file"
}

recovery_extract_storage_uuids() {
  local paths_file="$1"
  local suffix="$2"
  [[ "$suffix" == blob || "$suffix" == meta.json ]] || return 2
  recovery_storage_paths_file_is_exact "$paths_file" || return 1
  if [[ "$suffix" == blob ]]; then
    sed -n 's#^owned/[A-Za-z0-9._-][A-Za-z0-9._-]/[A-Za-z0-9._-][A-Za-z0-9._-]/\([A-Za-z0-9._-]*\)\.blob$#\1#p' \
      "$paths_file"
  else
    sed -n 's#^owned/[A-Za-z0-9._-][A-Za-z0-9._-]/[A-Za-z0-9._-][A-Za-z0-9._-]/\([A-Za-z0-9._-]*\)\.meta\.json$#\1#p' \
      "$paths_file"
  fi
}

recovery_require_cluster_identity() {
  local current_context live_namespace_uid

  if [[ -z "${EXPECTED_KUBE_CONTEXT:-}" ]]; then
    printf 'EXPECTED_KUBE_CONTEXT is required; refusing an implicit kubectl context.\n' >&2
    return 1
  fi
  if [[ -z "${EXPECTED_NAMESPACE_UID:-}" ]]; then
    printf 'EXPECTED_NAMESPACE_UID is required; pin the target namespace identity.\n' >&2
    return 1
  fi

  current_context="$(command kubectl --request-timeout=45s config current-context 2>/dev/null)" || {
    printf 'Could not read the current kubectl context.\n' >&2
    return 1
  }
  if [[ "$current_context" != "$EXPECTED_KUBE_CONTEXT" ]]; then
    printf 'kubectl context mismatch: expected=%s current=%s.\n' \
      "$EXPECTED_KUBE_CONTEXT" "$current_context" >&2
    return 1
  fi

  live_namespace_uid="$(
    recovery_kubectl get namespace "$NAMESPACE" -o jsonpath='{.metadata.uid}'
  )" || {
    printf 'Could not read namespace %s in context %s.\n' \
      "$NAMESPACE" "$EXPECTED_KUBE_CONTEXT" >&2
    return 1
  }
  if [[ -z "$live_namespace_uid" || "$live_namespace_uid" != "$EXPECTED_NAMESPACE_UID" ]]; then
    printf 'Namespace UID mismatch: namespace=%s expected=%s current=%s.\n' \
      "$NAMESPACE" "$EXPECTED_NAMESPACE_UID" "${live_namespace_uid:-missing}" >&2
    return 1
  fi

  RECOVERY_NAMESPACE_UID="$live_namespace_uid"
  export RECOVERY_NAMESPACE_UID
}

recovery_require_pvc_identity() {
  local pvc_name="$1"
  local current_pvc_uid
  if [[ -z "${EXPECTED_RET_PVC_UID:-}" ]]; then
    printf 'EXPECTED_RET_PVC_UID is required; pin the ret-pvc identity.\n' >&2
    return 1
  fi
  if ! current_pvc_uid="$(
    recovery_kubectl get pvc "$pvc_name" -n "$NAMESPACE" -o jsonpath='{.metadata.uid}'
  )"; then
    printf 'Could not read PVC %s in the verified target.\n' "$pvc_name" >&2
    return 1
  fi
  if [[ -z "$current_pvc_uid" || "$current_pvc_uid" != "$EXPECTED_RET_PVC_UID" ]]; then
    printf 'PVC UID mismatch: pvc=%s expected=%s current=%s.\n' \
      "$pvc_name" "$EXPECTED_RET_PVC_UID" "${current_pvc_uid:-missing}" >&2
    return 1
  fi
  RECOVERY_PVC_UID="$current_pvc_uid"
  export RECOVERY_PVC_UID
}

recovery_require_local_fixture_attestation() {
  [[ "${YENHUBS_RECOVERY_TEST_MODE:-}" == local-fixture &&
     "${EXPECTED_KUBE_CONTEXT:-}" == fixture-context &&
     "${EXPECTED_NAMESPACE_UID:-}" == fixture-uid &&
     "${EXPECTED_RET_PVC_UID:-}" == fixture-pvc-uid &&
     "${NAMESPACE:-}" == hcce ]] || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  [[ "$RECOVERY_NAMESPACE_UID" == fixture-uid &&
     "$RECOVERY_PVC_UID" == fixture-pvc-uid ]]
}

recovery_stable_absence_seconds() {
  local test_mode="${YENHUBS_RECOVERY_TEST_MODE:-}"
  local requested="${RECOVERY_TEST_STABLE_ABSENCE_SECONDS:-}"
  if [[ -z "$test_mode" && -z "$requested" ]]; then
    printf '61\n'
    return 0
  fi
  recovery_require_local_fixture_attestation || {
    printf 'Recovery timing overrides require the exact isolated fixture identity.\n' >&2
    return 1
  }
  requested="${requested:-0}"
  [[ "$requested" =~ ^[0-2]$ ]] || return 2
  printf '%s\n' "$requested"
}

recovery_require_pod_identity() {
  local pod_name="$1"
  local expected_uid="$2"
  local current_uid
  [[ -n "$pod_name" && -n "$expected_uid" ]] || return 2
  if ! current_uid="$(
    recovery_kubectl get pod "$pod_name" -n "$NAMESPACE" -o jsonpath='{.metadata.uid}'
  )"; then
    printf 'Could not read pod identity for %s.\n' "$pod_name" >&2
    return 1
  fi
  if [[ "$current_uid" != "$expected_uid" ]]; then
    printf 'Pod UID mismatch for %s.\n' "$pod_name" >&2
    return 1
  fi
}

recovery_exact_ready_pod_info() {
  local pods_json="$1"
  local app_label="$2"
  [[ -n "$pods_json" && "$app_label" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  jq -er --arg app "$app_label" '
    select((.items | type) == "array" and (.items | length) == 1) |
    .items[0] |
    select(.metadata.name | type == "string" and length > 0) |
    select(.metadata.uid | type == "string" and length > 0) |
    select((.metadata.deletionTimestamp // null) == null) |
    select(.metadata.labels.app == $app) |
    select(.status.phase == "Running") |
    select([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length == 1) |
    select([.metadata.ownerReferences[]? |
      select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and
             .controller == true and (.uid | type == "string" and length > 0))] | length == 1) |
    [.metadata.name, .metadata.uid] | @tsv
  ' <<<"$pods_json"
}

recovery_require_pod_deployment_ownership() {
  local pod_json="$1"
  local deployment_name="$2"
  local expected_deployment_uid="${3:-}"
  local replica_set_name replica_set_uid deployment_uid replica_set_json deployment_json
  [[ "$deployment_name" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  replica_set_name="$(jq -er '
    [.metadata.ownerReferences[]? |
      select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and .controller == true)] |
    select(length == 1) | .[0].name
  ' <<<"$pod_json")" || return 1
  replica_set_uid="$(jq -er '
    [.metadata.ownerReferences[]? |
      select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and .controller == true)] |
    select(length == 1) | .[0].uid
  ' <<<"$pod_json")" || return 1
  replica_set_json="$(recovery_kubectl get replicaset "$replica_set_name" \
    -n "$NAMESPACE" -o json)" || return 1
  deployment_json="$(recovery_kubectl get deployment "$deployment_name" \
    -n "$NAMESPACE" -o json)" || return 1
  deployment_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$deployment_json")" || return 1
  [[ -z "$expected_deployment_uid" || "$deployment_uid" == "$expected_deployment_uid" ]] || return 1
  jq -e --arg rs_name "$replica_set_name" --arg rs_uid "$replica_set_uid" \
    --arg deployment "$deployment_name" --arg deployment_uid "$deployment_uid" '
    .apiVersion == "apps/v1" and .kind == "ReplicaSet" and
    .metadata.name == $rs_name and .metadata.uid == $rs_uid and
    ([.metadata.ownerReferences[]? |
      select(.apiVersion == "apps/v1" and .kind == "Deployment" and
             .controller == true and .name == $deployment and .uid == $deployment_uid)] |
      length) == 1
  ' >/dev/null <<<"$replica_set_json"
}

recovery_exact_ready_deployment_pod_info() {
  local pods_json="$1"
  local app_label="$2"
  local deployment_name="$3"
  local pod_info pod_name pod_uid pod_json deployment_json deployment_uid
  [[ "$deployment_name" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  pod_info="$(recovery_exact_ready_pod_info "$pods_json" "$app_label")" || return 1
  IFS=$'\t' read -r pod_name pod_uid <<<"$pod_info"
  pod_json="$(jq -cer --arg uid "$pod_uid" '
    [.items[] | select(.metadata.uid == $uid)] | select(length == 1) | .[0]
  ' <<<"$pods_json")" || return 1
  deployment_json="$(recovery_kubectl get deployment "$deployment_name" \
    -n "$NAMESPACE" -o json)" || return 1
  deployment_uid="$(jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    .metadata.uid | select(type == "string" and length > 0)
  ' <<<"$deployment_json")" || return 1
  recovery_require_pod_deployment_ownership \
    "$pod_json" "$deployment_name" "$deployment_uid" || return 1
  printf '%s\t%s\n' "$pod_info" "$deployment_uid"
}

recovery_capture_deployment_contract() {
  local deployment_name="$1"
  local deployment_json
  [[ "$deployment_name" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  deployment_json="$(
    recovery_kubectl get deployment "$deployment_name" -n "$NAMESPACE" -o json
  )" || return 1
  jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name) |
    select(.metadata.namespace == $namespace) |
    select(.metadata.uid | type == "string" and length > 0) |
    select(.metadata.resourceVersion | type == "string" and length > 0) |
    select(.spec.replicas | type == "number" and floor == . and . >= 0) |
    select((.spec.selector.matchLabels | keys) == ["app"]) |
    select((.spec.selector.matchExpressions // []) == []) |
    select(.spec.selector.matchLabels.app | type == "string" and length > 0) |
    select(.spec.template.metadata.labels.app == .spec.selector.matchLabels.app) |
    [
      .metadata.uid,
      .metadata.resourceVersion,
      (.spec.replicas | tostring),
      .spec.selector.matchLabels.app,
      ({selector:.spec.selector, strategy:(.spec.strategy // {}), template:.spec.template} | @base64)
    ] | @tsv
  ' <<<"$deployment_json"
}

recovery_require_deployment_contract() {
  local deployment_name="$1"
  local expected_uid="$2"
  local expected_replicas="$3"
  local expected_selector="$4"
  local expected_fingerprint="$5"
  local contract uid resource_version replicas selector fingerprint
  contract="$(recovery_capture_deployment_contract "$deployment_name")" || return 1
  IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
  [[ "$uid" == "$expected_uid" && "$replicas" == "$expected_replicas" &&
     "$selector" == "$expected_selector" && "$fingerprint" == "$expected_fingerprint" ]]
}

# Bind the complete mutable Deployment control surface used by a process-local
# freeze before any lock acquisition. A later call with the expected contract
# requires byte-for-byte equality of UID, resourceVersion, generation and full
# spec, so strategy selection cannot race across the lock window.
recovery_capture_process_local_freeze_parent_contract_exact() {
  local expected_contract="${1:-}" deployment_json contract_json
  deployment_json="$(recovery_kubectl get deployment bot-orchestrator \
    -n "$NAMESPACE" -o json)" || return 1
  contract_json="$(jq -cer '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == "bot-orchestrator") |
    select(.metadata.namespace | type == "string" and length > 0) |
    select(.metadata.uid | type == "string" and length > 0) |
    select(.metadata.resourceVersion | type == "string" and length > 0) |
    select((.metadata.deletionTimestamp // null) == null) |
    select(.metadata.generation | type == "number" and floor == . and . >= 1) |
    select((.spec | type) == "object" and .spec.replicas == 1) |
    select(.spec.strategy.type == "Recreate" or
      .spec.strategy.type == "RollingUpdate") |
    select(.status.observedGeneration == .metadata.generation) |
    select((.status.replicas // 0) == 1 and
      (.status.updatedReplicas // 0) == 1 and
      (.status.readyReplicas // 0) == 1 and
      (.status.availableReplicas // 0) == 1 and
      (.status.unavailableReplicas // 0) == 0) |
    {schema_version:1,name:.metadata.name,uid:.metadata.uid,
     resource_version:.metadata.resourceVersion,
     generation:.metadata.generation,spec:.spec}
  ' <<<"$deployment_json")" || {
    printf 'The process-local freeze parent is not at one stable ready boundary.\n' >&2
    return 1
  }
  if [[ -n "$expected_contract" ]]; then
    jq -e --argjson expected "$expected_contract" '. == $expected' \
      >/dev/null <<<"$contract_json" || {
      printf 'The process-local freeze parent changed across lock acquisition.\n' >&2
      return 1
    }
  fi
  printf '%s\n' "$contract_json"
}

# Capture one stable process-local RollingUpdate parent boundary. This helper
# is intentionally specific to freeze checkpoint creation: it proves that one
# fully observed Deployment has exactly one current ReplicaSet and, at the
# running boundary, exactly one Ready Pod. Historical ReplicaSets owned by the
# same Deployment are accepted only when completely inert. The returned JSON
# retains the Deployment's
# UID, resourceVersion, generation and complete spec for later replica-only
# compare-and-set mutations.
recovery_capture_process_local_freeze_parent_boundary_exact() {
  local boundary="$1" baseline_json="${2:-}" expected_generation="${3:-}"
  local expected_replicas expected_ready deployment_before deployment_after
  local hpa_json replica_sets_json pods_json pods_path contract_json
  case "$boundary" in
    ready-one)
      expected_replicas=1
      expected_ready=1
      ;;
    zero)
      expected_replicas=0
      expected_ready=0
      ;;
    *) return 2 ;;
  esac
  [[ -z "$expected_generation" ||
     "$expected_generation" =~ ^[1-9][0-9]*$ ]] || return 2
  if [[ -n "$baseline_json" ]]; then
    jq -e '
      type == "object" and .schema_version == 1 and
      .name == "bot-orchestrator" and
      (.uid | type == "string" and length > 0) and
      (.resource_version | type == "string" and length > 0) and
      (.generation | type == "number" and floor == . and . >= 1) and
      (.spec | type == "object") and .spec.replicas == 1 and
      .spec.strategy.type == "RollingUpdate" and
      (.replica_set.name | type == "string" and length > 0) and
      (.replica_set.uid | type == "string" and length > 0)
    ' >/dev/null <<<"$baseline_json" || return 2
  fi

  deployment_before="$(recovery_kubectl get deployment bot-orchestrator \
    -n "$NAMESPACE" -o json)" || return 1
  hpa_json="$(recovery_kubectl_get_namespaced_list \
    horizontalpodautoscalers "$NAMESPACE")" || return 1
  replica_sets_json="$(recovery_kubectl_get_namespaced_list \
    replicasets "$NAMESPACE")" || return 1
  pods_path="/api/v1/namespaces/$NAMESPACE/pods?labelSelector=app%3Dbot-orchestrator"
  pods_json="$(recovery_kubectl get --raw "$pods_path")" || return 1
  deployment_after="$(recovery_kubectl get deployment bot-orchestrator \
    -n "$NAMESPACE" -o json)" || return 1

  jq -e '
    .apiVersion == "autoscaling/v2" and
    .kind == "HorizontalPodAutoscalerList" and
    (.items | type == "array") and
    ([.items[] | select(
      .spec.scaleTargetRef.apiVersion == "apps/v1" and
      .spec.scaleTargetRef.kind == "Deployment" and
      .spec.scaleTargetRef.name == "bot-orchestrator")] | length) == 0
  ' >/dev/null <<<"$hpa_json" || {
    printf 'A HorizontalPodAutoscaler targets bot-orchestrator; refusing checkpoint scaling.\n' >&2
    return 1
  }
  jq -e '
    .apiVersion == "apps/v1" and .kind == "ReplicaSetList" and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (.items | type == "array")
  ' >/dev/null <<<"$replica_sets_json" || return 1
  jq -e '
    .apiVersion == "v1" and .kind == "PodList" and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (.items | type == "array")
  ' >/dev/null <<<"$pods_json" || return 1

  contract_json="$(jq -cne \
    --arg boundary "$boundary" \
    --argjson expected_replicas "$expected_replicas" \
    --argjson expected_ready "$expected_ready" \
    --arg expected_generation "$expected_generation" \
    --argjson before "$deployment_before" \
    --argjson after "$deployment_after" \
    --argjson replica_sets "$replica_sets_json" \
    --argjson pods "$pods_json" \
    --argjson baseline "${baseline_json:-null}" '
    def count($value): ($value // 0);
    def listed_item_gvk($value; $api_version; $kind):
      ($value.apiVersion == null or $value.apiVersion == $api_version) and
      ($value.kind == null or $value.kind == $kind);
    def stable_deployment($value):
      $value.apiVersion == "apps/v1" and $value.kind == "Deployment" and
      $value.metadata.name == "bot-orchestrator" and
      ($value.metadata.namespace | type == "string" and length > 0) and
      ($value.metadata.uid | type == "string" and length > 0) and
      ($value.metadata.resourceVersion | type == "string" and length > 0) and
      (($value.metadata.deletionTimestamp // null) == null) and
      ($value.metadata.generation | type == "number" and floor == . and . >= 1) and
      $value.spec.replicas == $expected_replicas and
      $value.spec.strategy.type == "RollingUpdate" and
      $value.spec.selector == {matchLabels:{app:"bot-orchestrator"}} and
      $value.spec.template.metadata.labels.app == "bot-orchestrator" and
      $value.status.observedGeneration == $value.metadata.generation and
      count($value.status.replicas) == $expected_replicas and
      count($value.status.updatedReplicas) == $expected_replicas and
      count($value.status.readyReplicas) == $expected_ready and
      count($value.status.availableReplicas) == $expected_ready and
      count($value.status.unavailableReplicas) == 0;
    def current_rs_projection($rs; $deployment):
      ($rs.spec.selector.matchLabels["pod-template-hash"] // null) as $hash |
      ($deployment.metadata.annotations["deployment.kubernetes.io/revision"] // null)
        as $deployment_revision |
      ($rs.metadata.annotations["deployment.kubernetes.io/revision"] // null)
        as $rs_revision |
      ($hash | type == "string" and length > 0) and
      ($deployment_revision | type == "string" and length > 0) and
      $rs_revision == $deployment_revision and
      $rs.spec.selector == {matchLabels:
        ($deployment.spec.selector.matchLabels + {"pod-template-hash":$hash})} and
      $rs.spec.template.metadata.labels["pod-template-hash"] == $hash and
      ($rs.spec.template | del(.metadata.labels["pod-template-hash"])) ==
        $deployment.spec.template;
    ([ $replica_sets.items[] |
       select([.metadata.ownerReferences[]? |
         select(.apiVersion == "apps/v1" and .kind == "Deployment" and
           .controller == true and .name == "bot-orchestrator" and
           .uid == $after.metadata.uid)] | length == 1) ]) as $owned_rs |
    ([ $owned_rs[] |
       select(current_rs_projection(.; $after)) ]) as $current_rs |
    ($current_rs[0]) as $rs |
    ([ $owned_rs[] | select(.metadata.uid != $rs.metadata.uid) ]) as $historical_rs |
    (stable_deployment($before) and stable_deployment($after) and
    ({uid:$before.metadata.uid,resourceVersion:$before.metadata.resourceVersion,
      generation:$before.metadata.generation,spec:$before.spec,status:$before.status} ==
     {uid:$after.metadata.uid,resourceVersion:$after.metadata.resourceVersion,
      generation:$after.metadata.generation,spec:$after.spec,status:$after.status}) and
    (if $expected_generation == "" then true else
       $after.metadata.generation == ($expected_generation | tonumber)
     end) and
    ($current_rs | length) == 1 and
    all($historical_rs[];
      listed_item_gvk(.; "apps/v1"; "ReplicaSet") and
      ((.metadata.deletionTimestamp // null) == null) and
      (.metadata.name | type == "string" and length > 0) and
      (.metadata.uid | type == "string" and length > 0) and
      (.metadata.resourceVersion | type == "string" and length > 0) and
      (.metadata.generation | type == "number" and floor == . and . >= 1) and
      .spec.replicas == 0 and count(.status.replicas) == 0 and
      count(.status.readyReplicas) == 0 and
      count(.status.availableReplicas) == 0) and
    listed_item_gvk($rs; "apps/v1"; "ReplicaSet") and
    (($rs.metadata.deletionTimestamp // null) == null) and
    ($rs.metadata.name | type == "string" and length > 0) and
    ($rs.metadata.uid | type == "string" and length > 0) and
    ($rs.metadata.resourceVersion | type == "string" and length > 0) and
    ($rs.metadata.generation | type == "number" and floor == . and . >= 1) and
    $rs.metadata.labels.app == "bot-orchestrator" and
    $rs.spec.replicas == $expected_replicas and
    current_rs_projection($rs; $after) and
    count($rs.status.replicas) == $expected_replicas and
    count($rs.status.readyReplicas) == $expected_ready and
    count($rs.status.availableReplicas) == $expected_ready and
    ([ $pods.items[] | select(.metadata.labels.app == "bot-orchestrator") ] |
      length) == $expected_replicas and
    (if $expected_replicas == 0 then true else
       ([ $pods.items[] | select(.metadata.labels.app == "bot-orchestrator") ][0]) as $pod |
       listed_item_gvk($pod; "v1"; "Pod") and
       (($pod.metadata.deletionTimestamp // null) == null) and
       ($pod.metadata.name | type == "string" and length > 0) and
       ($pod.metadata.uid | type == "string" and length > 0) and
       ([ $pod.metadata.ownerReferences[]? |
          select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and
            .controller == true and .name == $rs.metadata.name and
            .uid == $rs.metadata.uid) ] | length) == 1 and
       $pod.status.phase == "Running" and
       ([ $pod.status.conditions[]? |
          select(.type == "Ready" and .status == "True") ] | length) == 1
     end) and
    (if $baseline == null then true else
       $after.metadata.uid == $baseline.uid and
       $after.spec == ($baseline.spec | .replicas = $expected_replicas) and
       $rs.metadata.name == $baseline.replica_set.name and
       $rs.metadata.uid == $baseline.replica_set.uid
     end)) |
    select(.) |
    {schema_version:1,boundary:$boundary,name:"bot-orchestrator",
     uid:$after.metadata.uid,resource_version:$after.metadata.resourceVersion,
     generation:$after.metadata.generation,spec:$after.spec,
     replica_set:{name:$rs.metadata.name,uid:$rs.metadata.uid,
       resource_version:$rs.metadata.resourceVersion,generation:$rs.metadata.generation,
       spec:$rs.spec},
     pod:(if $expected_replicas == 0 then null else
       ([ $pods.items[] | select(.metadata.labels.app == "bot-orchestrator") ][0] |
        {name:.metadata.name,uid:.metadata.uid}) end)}
  ')" || {
    printf 'The process-local RollingUpdate parent is not at the exact %s boundary.\n' \
      "$boundary" >&2
    return 1
  }
  printf '%s\n' "$contract_json"
}

# Mutate only spec.replicas for the captured RollingUpdate parent. The full
# Deployment spec, UID, resourceVersion and generation are server-side JSON
# Patch tests; no metadata receipt or template field is added by this lane.
recovery_process_local_freeze_parent_poststate_exact() {
  local deployment_json="$1" expected_uid="$2" old_resource_version="$3"
  local expected_generation="$4" desired_spec="$5"
  jq -er --arg uid "$expected_uid" --arg old_rv "$old_resource_version" \
    --argjson generation "$expected_generation" \
    --argjson desired_spec "$desired_spec" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == "bot-orchestrator" and .metadata.uid == $uid) |
    select(.metadata.resourceVersion | type == "string" and
      length > 0 and . != $old_rv) |
    select(.metadata.generation == $generation and
      (.metadata.deletionTimestamp // null) == null and .spec == $desired_spec) |
    [.metadata.resourceVersion, (.metadata.generation | tostring)] | @tsv
  ' <<<"$deployment_json"
}

recovery_scale_process_local_freeze_parent_replicas_exact() {
  local baseline_json="$1" expected_resource_version="$2"
  local expected_generation="$3" expected_replicas="$4" desired_replicas="$5"
  local expected_uid expected_spec desired_spec patch response live_json
  [[ "$expected_generation" =~ ^[1-9][0-9]*$ &&
     ( "$expected_replicas:$desired_replicas" == "1:0" ||
       "$expected_replicas:$desired_replicas" == "0:1" ) ]] || return 2
  expected_uid="$(jq -er '
    select(.schema_version == 1 and .name == "bot-orchestrator" and
      .spec.replicas == 1 and .spec.strategy.type == "RollingUpdate") |
    .uid
  ' <<<"$baseline_json")" || return 2
  expected_spec="$(jq -c --argjson replicas "$expected_replicas" \
    '.spec | .replicas = $replicas' <<<"$baseline_json")" || return 2
  desired_spec="$(jq -c --argjson replicas "$desired_replicas" \
    '.spec | .replicas = $replicas' <<<"$baseline_json")" || return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  live_json="$(recovery_kubectl get deployment bot-orchestrator \
    -n "$NAMESPACE" -o json)" || return 1
  jq -e --arg uid "$expected_uid" --arg rv "$expected_resource_version" \
    --argjson generation "$expected_generation" \
    --argjson expected_spec "$expected_spec" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "bot-orchestrator" and
    .metadata.uid == $uid and .metadata.resourceVersion == $rv and
    .metadata.generation == $generation and
    (.metadata.deletionTimestamp // null) == null and
    .spec == $expected_spec
  ' >/dev/null <<<"$live_json" || return 1
  patch="$(jq -cn --arg uid "$expected_uid" \
    --arg resource_version "$expected_resource_version" \
    --argjson generation "$expected_generation" \
    --argjson expected_spec "$expected_spec" \
    --argjson desired_replicas "$desired_replicas" '[
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$resource_version},
      {op:"test",path:"/metadata/generation",value:$generation},
      {op:"test",path:"/spec",value:$expected_spec},
      {op:"replace",path:"/spec/replicas",value:$desired_replicas}
    ]')" || return 1
  if ! response="$(recovery_kubectl_mutate patch deployment bot-orchestrator \
      -n "$NAMESPACE" --type=json --patch="$patch" -o json)"; then
    # A transport/nonzero result is ambiguous. Reconcile exactly once and
    # only against the unique committed post-state; never issue another PATCH.
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    live_json="$(recovery_kubectl get deployment bot-orchestrator \
      -n "$NAMESPACE" -o json)" || return 1
    recovery_process_local_freeze_parent_poststate_exact \
      "$live_json" "$expected_uid" "$expected_resource_version" \
      "$((expected_generation + 1))" "$desired_spec"
    return
  fi
  recovery_process_local_freeze_parent_poststate_exact \
    "$response" "$expected_uid" "$expected_resource_version" \
    "$((expected_generation + 1))" "$desired_spec" >/dev/null || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  live_json="$(recovery_kubectl get deployment bot-orchestrator \
    -n "$NAMESPACE" -o json)" || return 1
  recovery_process_local_freeze_parent_poststate_exact \
    "$live_json" "$expected_uid" "$expected_resource_version" \
    "$((expected_generation + 1))" "$desired_spec"
}

recovery_capture_checkpoint_resume_receipt_contract() {
  local deployment_name="$1" expected_uid="$2" expected_replicas="$3"
  local expected_selector="$4" expected_fingerprint="$5" operation_id="$6"
  local deployment_json
  [[ "$expected_replicas" =~ ^[0-9]+$ &&
     "$operation_id" =~ ^[a-f0-9]{32}$ ]] || return 2
  deployment_json="$(
    recovery_kubectl get deployment "$deployment_name" -n "$NAMESPACE" -o json
  )" || return 1
  jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --argjson replicas "$expected_replicas" \
    --arg selector "$expected_selector" --arg fingerprint "$expected_fingerprint" \
    --arg operation_id "$operation_id" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    select(.metadata.uid == $uid and
      (.metadata.deletionTimestamp // null) == null) |
    select(.metadata.resourceVersion | type == "string" and length > 0) |
    select(.spec.replicas == $replicas) |
    select(.spec.selector.matchLabels.app == $selector) |
    select(.spec.template.metadata.labels.app == $selector) |
    select(({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint) |
    select(.metadata.annotations["yenhubs.org/checkpoint-resume-operation"] ==
      $operation_id) |
    .metadata.resourceVersion
  ' <<<"$deployment_json"
}

recovery_capture_checkpoint_resume_receipt_absent_contract() {
  local deployment_name="$1" expected_uid="$2" expected_replicas="$3"
  local expected_selector="$4" expected_fingerprint="$5" deployment_json
  [[ "$expected_replicas" =~ ^[0-9]+$ ]] || return 2
  deployment_json="$(
    recovery_kubectl get deployment "$deployment_name" -n "$NAMESPACE" -o json
  )" || return 1
  jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --argjson replicas "$expected_replicas" \
    --arg selector "$expected_selector" --arg fingerprint "$expected_fingerprint" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    select(.metadata.uid == $uid and
      (.metadata.deletionTimestamp // null) == null) |
    select(.metadata.resourceVersion | type == "string" and length > 0) |
    select(.spec.replicas == $replicas) |
    select(.spec.selector.matchLabels.app == $selector) |
    select(.spec.template.metadata.labels.app == $selector) |
    select(({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint) |
    select(((.metadata.annotations // {}) |
      has("yenhubs.org/checkpoint-resume-operation") | not)) |
    .metadata.resourceVersion
  ' <<<"$deployment_json"
}

# Capture one exact legacy resume-receipt state from a single Deployment GET.
# The only accepted metadata states are absence or the current operation ID;
# an unknown value is not collapsed into "present" because stale-lock cleanup
# must fail without mutation when ownership cannot be proven exactly.
recovery_capture_checkpoint_resume_receipt_state_exact() {
  local deployment_name="$1" expected_uid="$2" expected_replicas="$3"
  local expected_selector="$4" expected_fingerprint="$5" operation_id="$6"
  local deployment_json
  [[ "$expected_replicas" =~ ^[01]$ &&
     "$operation_id" =~ ^[a-f0-9]{32}$ ]] || return 2
  deployment_json="$(
    recovery_kubectl get deployment "$deployment_name" -n "$NAMESPACE" -o json
  )" || return 1
  jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --argjson replicas "$expected_replicas" \
    --arg selector "$expected_selector" --arg fingerprint "$expected_fingerprint" \
    --arg operation_id "$operation_id" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    select(.metadata.uid == $uid and
      (.metadata.deletionTimestamp // null) == null) |
    select(.metadata.resourceVersion | type == "string" and length > 0) |
    select(.metadata.generation | type == "number" and floor == . and . >= 1) |
    select(.spec.replicas == $replicas) |
    select(.spec.selector.matchLabels.app == $selector) |
    select(.spec.template.metadata.labels.app == $selector) |
    select(({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint) |
    ((.metadata.annotations // {}) | select(type == "object")) as $annotations |
    if ($annotations | has("yenhubs.org/checkpoint-resume-operation") | not) then
      ["absent", .metadata.resourceVersion] | @tsv
    elif $annotations["yenhubs.org/checkpoint-resume-operation"] == $operation_id then
      ["exact", .metadata.resourceVersion] | @tsv
    else
      error("unknown_checkpoint_resume_receipt")
    end
  ' <<<"$deployment_json"
}

recovery_require_legacy_checkpoint_receipt_mutation_context() {
  local deployment_name="$1"
  [[ "$deployment_name" == reticulum &&
     "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-restore &&
     "${RECOVERY_OPERATION_STATE:-}" == legacy-in-place &&
     "${RECOVERY_CHECKPOINT_RUNNER_GENERATION:-}" == legacy-absent &&
     "${RECOVERY_RUNNER_RUNTIME_GENERATION:-}" == legacy-absent &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ ]]
}

# Publish the legacy restore authority-transfer receipt without changing the
# Deployment spec or generation. A failed/ambiguous PATCH response is never
# reconciled into success; the caller leaves all five writers at zero and the
# operation lock retained for explicit stale cleanup.
recovery_publish_checkpoint_resume_receipt_exact() {
  local deployment_name="$1" expected_uid="$2" expected_resource_version="$3"
  local expected_selector="$4" expected_fingerprint="$5" operation_id="$6"
  local live_json patch response annotations_json generation response_generation
  [[ -n "$expected_resource_version" &&
     "$operation_id" =~ ^[a-f0-9]{32}$ ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$deployment_name" || return 1
  [[ "$operation_id" == "$RECOVERY_OPERATION_ID" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  live_json="$(recovery_kubectl get deployment "$deployment_name" \
    -n "$NAMESPACE" -o json)" || return 1
  generation="$(jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --arg rv "$expected_resource_version" \
    --arg selector "$expected_selector" --arg fingerprint "$expected_fingerprint" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    select(.metadata.uid == $uid and .metadata.resourceVersion == $rv and
      (.metadata.deletionTimestamp // null) == null) |
    select(.metadata.generation | type == "number" and floor == . and . >= 1) |
    select(.spec.replicas == 0 and
      .spec.selector.matchLabels.app == $selector and
      .spec.template.metadata.labels.app == $selector) |
    select(({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint) |
    select(((.metadata.annotations // {}) |
      has("yenhubs.org/checkpoint-resume-operation") | not)) |
    .metadata.generation
  ' <<<"$live_json")" || return 1
  annotations_json="$(jq -c '.metadata.annotations // null' <<<"$live_json")" || return 1
  patch="$(jq -cn --arg uid "$expected_uid" \
    --arg resource_version "$expected_resource_version" \
    --arg operation_id "$operation_id" --argjson annotations "$annotations_json" '
    ([
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$resource_version},
      {op:"test",path:"/spec/replicas",value:0}
    ] + [if $annotations == null then
      {op:"add",path:"/metadata/annotations",
        value:{"yenhubs.org/checkpoint-resume-operation":$operation_id}}
    else
      {op:"add",path:"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation",
        value:$operation_id}
    end])
  ')" || return 1
  response="$(recovery_kubectl_mutate patch deployment "$deployment_name" \
    -n "$NAMESPACE" --type=json --patch="$patch" -o json)" || return 1
  response_generation="$(jq -er --arg name "$deployment_name" \
    --arg namespace "$NAMESPACE" --arg uid "$expected_uid" \
    --arg old_rv "$expected_resource_version" --arg selector "$expected_selector" \
    --arg fingerprint "$expected_fingerprint" --arg operation_id "$operation_id" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    select(.metadata.uid == $uid and (.metadata.deletionTimestamp // null) == null) |
    select(.metadata.resourceVersion | type == "string" and length > 0 and . != $old_rv) |
    select(.metadata.generation | type == "number" and floor == . and . >= 1) |
    select(.spec.replicas == 0 and
      .spec.selector.matchLabels.app == $selector and
      .spec.template.metadata.labels.app == $selector) |
    select(({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint) |
    select(.metadata.annotations["yenhubs.org/checkpoint-resume-operation"] ==
      $operation_id) |
    .metadata.generation
  ' <<<"$response")" || return 1
  [[ "$response_generation" == "$generation" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  jq -er '.metadata.resourceVersion' <<<"$response"
}

# The first post-ACK resume CAS must consume the exact receipt and terminal RV;
# it cannot use the generic scaler, which intentionally ignores metadata.
recovery_scale_deployment_with_checkpoint_receipt_exact() {
  local deployment_name="$1" expected_uid="$2" expected_resource_version="$3"
  local expected_selector="$4" expected_fingerprint="$5" operation_id="$6"
  local live_json patch response generation expected_generation
  [[ -n "$expected_resource_version" &&
     "$operation_id" =~ ^[a-f0-9]{32}$ ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$deployment_name" || return 1
  [[ "$operation_id" == "$RECOVERY_OPERATION_ID" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  live_json="$(recovery_kubectl get deployment "$deployment_name" \
    -n "$NAMESPACE" -o json)" || return 1
  generation="$(jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --arg rv "$expected_resource_version" \
    --arg selector "$expected_selector" --arg fingerprint "$expected_fingerprint" \
    --arg operation_id "$operation_id" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    select(.metadata.uid == $uid and .metadata.resourceVersion == $rv and
      (.metadata.deletionTimestamp // null) == null) |
    select(.metadata.generation | type == "number" and floor == . and . >= 1) |
    select(.spec.replicas == 0 and
      .spec.selector.matchLabels.app == $selector and
      .spec.template.metadata.labels.app == $selector) |
    select(({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint) |
    select(.metadata.annotations["yenhubs.org/checkpoint-resume-operation"] ==
      $operation_id) |
    .metadata.generation
  ' <<<"$live_json")" || return 1
  patch="$(jq -cn --arg uid "$expected_uid" \
    --arg resource_version "$expected_resource_version" \
    --arg operation_id "$operation_id" '
    [
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$resource_version},
      {op:"test",path:"/spec/replicas",value:0},
      {op:"test",path:"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation",
        value:$operation_id},
      {op:"replace",path:"/spec/replicas",value:1}
    ]
  ')" || return 1
  response="$(recovery_kubectl_mutate patch deployment "$deployment_name" \
    -n "$NAMESPACE" --type=json --patch="$patch" -o json)" || return 1
  expected_generation=$((generation + 1))
  jq -e --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --arg old_rv "$expected_resource_version" \
    --arg selector "$expected_selector" --arg fingerprint "$expected_fingerprint" \
    --arg operation_id "$operation_id" --argjson generation "$expected_generation" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    .metadata.uid == $uid and (.metadata.deletionTimestamp // null) == null and
    (.metadata.resourceVersion | type == "string" and length > 0 and . != $old_rv) and
    .metadata.generation == $generation and .spec.replicas == 1 and
    .spec.selector.matchLabels.app == $selector and
    .spec.template.metadata.labels.app == $selector and
    ({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint and
    .metadata.annotations["yenhubs.org/checkpoint-resume-operation"] ==
      $operation_id
  ' >/dev/null <<<"$response" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  jq -er '.metadata.resourceVersion' <<<"$response"
}

recovery_clear_checkpoint_resume_receipt_exact() {
  local deployment_name="$1" expected_uid="$2" expected_resource_version="$3"
  local expected_replicas="$4" expected_selector="$5" expected_fingerprint="$6"
  local operation_id="$7" live_json patch response generation
  [[ "$expected_replicas" =~ ^[01]$ && -n "$expected_resource_version" &&
     "$operation_id" =~ ^[a-f0-9]{32}$ ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$deployment_name" || return 1
  [[ "$operation_id" == "$RECOVERY_OPERATION_ID" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  live_json="$(recovery_kubectl get deployment "$deployment_name" \
    -n "$NAMESPACE" -o json)" || return 1
  generation="$(jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --arg rv "$expected_resource_version" \
    --argjson replicas "$expected_replicas" --arg selector "$expected_selector" \
    --arg fingerprint "$expected_fingerprint" --arg operation_id "$operation_id" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    select(.metadata.uid == $uid and .metadata.resourceVersion == $rv and
      (.metadata.deletionTimestamp // null) == null) |
    select(.metadata.generation | type == "number" and floor == . and . >= 1) |
    select(.spec.replicas == $replicas and
      .spec.selector.matchLabels.app == $selector and
      .spec.template.metadata.labels.app == $selector) |
    select(({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint) |
    select(.metadata.annotations["yenhubs.org/checkpoint-resume-operation"] ==
      $operation_id) |
    .metadata.generation
  ' <<<"$live_json")" || return 1
  patch="$(jq -cn --arg uid "$expected_uid" \
    --arg resource_version "$expected_resource_version" \
    --argjson replicas "$expected_replicas" --arg operation_id "$operation_id" '
    [
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$resource_version},
      {op:"test",path:"/spec/replicas",value:$replicas},
      {op:"test",path:"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation",
        value:$operation_id},
      {op:"remove",path:"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"}
    ]
  ')" || return 1
  response="$(recovery_kubectl_mutate patch deployment "$deployment_name" \
    -n "$NAMESPACE" --type=json --patch="$patch" -o json)" || return 1
  jq -e --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --arg old_rv "$expected_resource_version" \
    --argjson replicas "$expected_replicas" --arg selector "$expected_selector" \
    --arg fingerprint "$expected_fingerprint" --argjson generation "$generation" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    .metadata.uid == $uid and (.metadata.deletionTimestamp // null) == null and
    (.metadata.resourceVersion | type == "string" and length > 0 and . != $old_rv) and
    .metadata.generation == $generation and .spec.replicas == $replicas and
    .spec.selector.matchLabels.app == $selector and
    .spec.template.metadata.labels.app == $selector and
    ({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint and
    (((.metadata.annotations // {}) |
      has("yenhubs.org/checkpoint-resume-operation")) | not)
  ' >/dev/null <<<"$response" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  jq -er '.metadata.resourceVersion' <<<"$response"
}

recovery_clear_checkpoint_resume_receipt() {
  local deployment_name="$1" expected_uid="$2" expected_resource_version="$3"
  local expected_replicas="$4" expected_selector="$5" expected_fingerprint="$6"
  local operation_id="$7" deployment_json current_resource_version patch response
  [[ "$expected_replicas" =~ ^[0-9]+$ &&
     -n "$expected_resource_version" &&
     "$operation_id" =~ ^[a-f0-9]{32}$ ]] || return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  current_resource_version="$(recovery_capture_checkpoint_resume_receipt_contract \
    "$deployment_name" "$expected_uid" "$expected_replicas" \
    "$expected_selector" "$expected_fingerprint" "$operation_id")" || return 1
  [[ "$current_resource_version" == "$expected_resource_version" ]] || return 1
  patch="$(jq -cn --arg uid "$expected_uid" \
    --arg resource_version "$expected_resource_version" \
    --argjson replicas "$expected_replicas" --arg operation_id "$operation_id" '
    [
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$resource_version},
      {op:"test",path:"/spec/replicas",value:$replicas},
      {op:"test",path:"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation",
        value:$operation_id},
      {op:"remove",path:"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation"}
    ]
  ')" || return 1
  response="$(recovery_kubectl_mutate patch deployment "$deployment_name" \
    -n "$NAMESPACE" --type=json --patch="$patch" -o json)" || {
    # An interrupted response may follow a committed remove. Reconcile only
    # exact absence on the unchanged desired replica/template contract.
    deployment_json="$(recovery_kubectl get deployment "$deployment_name" \
      -n "$NAMESPACE" -o json)" || return 1
    jq -e --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
      --arg uid "$expected_uid" --argjson replicas "$expected_replicas" \
      --arg selector "$expected_selector" --arg fingerprint "$expected_fingerprint" '
      .apiVersion == "apps/v1" and .kind == "Deployment" and
      .metadata.name == $name and .metadata.namespace == $namespace and
      .metadata.uid == $uid and (.metadata.deletionTimestamp // null) == null and
      (.metadata.resourceVersion | type == "string" and length > 0) and
      .spec.replicas == $replicas and
      .spec.selector.matchLabels.app == $selector and
      .spec.template.metadata.labels.app == $selector and
      ({selector:.spec.selector,strategy:(.spec.strategy // {}),
        template:.spec.template} | @base64) == $fingerprint and
      ((.metadata.annotations // {}) |
        has("yenhubs.org/checkpoint-resume-operation") | not)
    ' >/dev/null <<<"$deployment_json" || return 1
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    jq -er '.metadata.resourceVersion' <<<"$deployment_json"
    return
  }
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  jq -er --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --argjson replicas "$expected_replicas" \
    --arg selector "$expected_selector" --arg fingerprint "$expected_fingerprint" '
    select(.apiVersion == "apps/v1" and .kind == "Deployment") |
    select(.metadata.name == $name and .metadata.namespace == $namespace) |
    select(.metadata.uid == $uid and
      (.metadata.deletionTimestamp // null) == null) |
    select(.metadata.resourceVersion | type == "string" and length > 0) |
    select(.spec.replicas == $replicas and
      .spec.selector.matchLabels.app == $selector and
      .spec.template.metadata.labels.app == $selector) |
    select(({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint) |
    select(((.metadata.annotations // {}) |
      has("yenhubs.org/checkpoint-resume-operation") | not)) |
    .metadata.resourceVersion
  ' <<<"$response"
}

# Change the replica count of one previously captured Deployment through the
# full Deployment endpoint with server-side compare-and-set guards.  Never use
# deployments/scale here: AUD078 permanently denies that subresource because
# it cannot carry the durable parent-fence contract.  The global operation lock
# and the immutable part of the Deployment are revalidated immediately before
# and after the mutation. The new resourceVersion is printed so callers can
# chain further exact mutations.
recovery_scale_deployment_exact() {
  local deployment_name="$1"
  local expected_uid="$2"
  local expected_resource_version="$3"
  local expected_replicas="$4"
  local desired_replicas="$5"
  local expected_selector="$6"
  local expected_fingerprint="$7"
  local resume_operation_id="${8:-}"
  local before_contract uid resource_version replicas selector fingerprint
  local after_contract after_uid after_resource_version after_replicas after_selector after_fingerprint
  local patch receipt_operation patched_json live_json annotations_json
  [[ "$expected_replicas" =~ ^[0-9]+$ && "$desired_replicas" =~ ^[0-9]+$ &&
     -n "$expected_resource_version" &&
     ( -z "$resume_operation_id" || "$resume_operation_id" =~ ^[a-f0-9]{32}$ ) ]] || return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  before_contract="$(recovery_capture_deployment_contract "$deployment_name")" || return 1
  IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$before_contract"
  [[ "$uid" == "$expected_uid" && "$resource_version" == "$expected_resource_version" &&
     "$replicas" == "$expected_replicas" && "$selector" == "$expected_selector" &&
     "$fingerprint" == "$expected_fingerprint" ]] || {
    printf 'Deployment contract changed before scaling %s.\n' "$deployment_name" >&2
    return 1
  }
  receipt_operation='null'
  if [[ -n "$resume_operation_id" ]]; then
    live_json="$(recovery_kubectl get deployment "$deployment_name" \
      -n "$NAMESPACE" -o json)" || return 1
    jq -e --arg uid "$expected_uid" --arg rv "$expected_resource_version" \
      --argjson replicas "$expected_replicas" '
      .metadata.uid == $uid and .metadata.resourceVersion == $rv and
      .spec.replicas == $replicas and
      (((.metadata.annotations // {}) |
        has("yenhubs.org/checkpoint-resume-operation")) | not)
    ' >/dev/null <<<"$live_json" || return 1
    annotations_json="$(jq -c '.metadata.annotations // null' <<<"$live_json")" || return 1
    receipt_operation="$(jq -cn --argjson annotations "$annotations_json" \
      --arg operation_id "$resume_operation_id" '
      if $annotations == null then
        {op:"add",path:"/metadata/annotations",
          value:{"yenhubs.org/checkpoint-resume-operation":$operation_id}}
      else
        {op:"add",path:"/metadata/annotations/yenhubs.org~1checkpoint-resume-operation",
          value:$operation_id}
      end
    ')" || return 1
  fi
  patch="$(jq -cn \
    --arg uid "$expected_uid" \
    --arg resource_version "$expected_resource_version" \
    --argjson expected_replicas "$expected_replicas" \
    --argjson desired_replicas "$desired_replicas" \
    --argjson receipt_operation "$receipt_operation" '
    ([
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$resource_version},
      {op:"test",path:"/spec/replicas",value:$expected_replicas}
    ] + (if $receipt_operation == null then [] else [$receipt_operation] end) + [
      {op:"replace",path:"/spec/replicas",value:$desired_replicas}
    ])
  ')" || return 1
  patched_json="$(recovery_kubectl_mutate patch deployment "$deployment_name" \
    -n "$NAMESPACE" --type=json --patch="$patch" -o json)" || return 1
  jq -e --arg name "$deployment_name" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --arg old_rv "$expected_resource_version" \
    --argjson replicas "$desired_replicas" --arg selector "$expected_selector" \
    --arg fingerprint "$expected_fingerprint" --arg receipt "$resume_operation_id" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    .metadata.uid == $uid and (.metadata.deletionTimestamp // null) == null and
    (.metadata.resourceVersion | type == "string" and length > 0 and . != $old_rv) and
    .spec.replicas == $replicas and
    .spec.selector.matchLabels.app == $selector and
    .spec.template.metadata.labels.app == $selector and
    ({selector:.spec.selector,strategy:(.spec.strategy // {}),
      template:.spec.template} | @base64) == $fingerprint and
    (if $receipt == "" then true else
      .metadata.annotations["yenhubs.org/checkpoint-resume-operation"] == $receipt
    end)
  ' >/dev/null <<<"$patched_json" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  after_contract="$(recovery_capture_deployment_contract "$deployment_name")" || return 1
  IFS=$'\t' read -r after_uid after_resource_version after_replicas after_selector after_fingerprint \
    <<<"$after_contract"
  [[ "$after_uid" == "$expected_uid" &&
     -n "$after_resource_version" &&
     "$after_resource_version" != "$expected_resource_version" &&
     "$after_replicas" == "$desired_replicas" &&
     "$after_selector" == "$expected_selector" &&
     "$after_fingerprint" == "$expected_fingerprint" ]] || {
    printf 'Deployment contract changed while scaling %s.\n' "$deployment_name" >&2
    return 1
  }
  if [[ -n "$resume_operation_id" ]]; then
    recovery_capture_checkpoint_resume_receipt_contract \
      "$deployment_name" "$expected_uid" "$desired_replicas" \
      "$expected_selector" "$expected_fingerprint" "$resume_operation_id" \
      >/dev/null || return 1
  fi
  printf '%s\n' "$after_resource_version"
}

recovery_consumer_contract_is_acceptable() {
  local contract_json="$1"
  jq -e '
    type == "object" and
    (keys | sort) == ["consumers", "operation_id", "schema_version"] and
    .schema_version == 1 and
    (.operation_id | type == "string" and test("^[a-f0-9]{32}$")) and
    (.consumers | type == "array" and length == 5) and
    ([.consumers[].name] | sort) ==
      ["bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"] and
    ([.consumers[].name] | unique | length) == 5 and
    all(.consumers[];
      (keys | sort) == ["fingerprint", "initial_resource_version", "name", "original_replicas", "selector", "uid"] and
      (.uid | type == "string" and length > 0) and
      (.initial_resource_version | type == "string" and length > 0) and
      (.original_replicas | type == "number" and floor == . and . > 0) and
      (.selector | type == "string" and test("^[A-Za-z0-9._-]+$")) and
      (.fingerprint | type == "string" and test("^[A-Za-z0-9+/]+={0,2}$")))
  ' >/dev/null 2>&1 <<<"$contract_json"
}

recovery_require_consumer_contract_entry() {
  local contract_json="$1"
  local deployment_name="$2"
  local expected_current_replicas="$3"
  local expected_operation_id="${4:-${RECOVERY_OPERATION_ID:-}}"
  local expected uid selector fingerprint current_contract current_uid _current_rv current_replicas current_selector current_fingerprint
  recovery_consumer_contract_is_acceptable "$contract_json" || return 1
  [[ "$(jq -r '.operation_id' <<<"$contract_json")" == "$expected_operation_id" ]] || return 1
  expected="$(jq -cer --arg name "$deployment_name" \
    '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0]' \
    <<<"$contract_json")" || return 1
  uid="$(jq -r '.uid' <<<"$expected")"
  selector="$(jq -r '.selector' <<<"$expected")"
  fingerprint="$(jq -r '.fingerprint' <<<"$expected")"
  current_contract="$(recovery_capture_deployment_contract "$deployment_name")" || return 1
  IFS=$'\t' read -r current_uid _current_rv current_replicas current_selector current_fingerprint \
    <<<"$current_contract"
  [[ "$current_uid" == "$uid" && "$current_replicas" == "$expected_current_replicas" &&
     "$current_selector" == "$selector" && "$current_fingerprint" == "$fingerprint" ]]
}

recovery_uuid_v4() {
  local raw
  raw="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" || return 1
  [[ "$raw" =~ ^[a-f0-9]{32}$ ]] || return 1
  printf '%s-%s-4%s-%x%s-%s\n' \
    "${raw:0:8}" "${raw:8:4}" "${raw:13:3}" \
    "$((16#${raw:16:1} % 4 + 8))" "${raw:17:3}" "${raw:20:12}"
}

recovery_rfc3339_now() {
  date -u '+%Y-%m-%dT%H:%M:%S.000000Z'
}

recovery_rfc3339_epoch() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$ ]] || return 1
  node -e '
    const value = process.argv[1];
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) process.exit(1);
    process.stdout.write(String(Math.floor(epoch / 1000)));
  ' "$value"
}

recovery_serialization_lease_json_is_valid() {
  local lease_json="$1"
  jq -e --arg namespace "$NAMESPACE" --arg name "$RECOVERY_SERIALIZATION_LEASE_NAME" '
    .apiVersion == "coordination.k8s.io/v1" and .kind == "Lease" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    (.metadata | has("deletionTimestamp") | not) and
    (((.metadata | has("ownerReferences") | not) or .metadata.ownerReferences == [])) and
    (((.metadata | has("finalizers") | not) or .metadata.finalizers == [])) and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (.metadata.labels // {}) == {
      "yenhubs.org/operation-serialization":"deployment-recovery"
    } and
    (((.metadata | has("annotations") | not) or .metadata.annotations == {})) and
    (.spec | type == "object") and
    (.spec.leaseDurationSeconds == 120) and
    (.spec.leaseTransitions | type == "number" and floor == . and . >= 0) and
    (if (.spec.holderIdentity // "") == "" then
      (.spec | keys | sort) == ["leaseDurationSeconds","leaseTransitions"]
    else
      (.spec | keys | sort) == ["acquireTime","holderIdentity",
        "leaseDurationSeconds","leaseTransitions","renewTime"] and
      (.spec.holderIdentity | type == "string" and
        test("^(root-recovery|cloud-apply):[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")) and
      (.spec.acquireTime | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$")) and
      (.spec.renewTime | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$"))
    end)
  ' >/dev/null <<<"$lease_json"
}

recovery_owned_serialization_lease_json_is_exact() {
  local lease_json="$1"
  local renew_epoch now_epoch
  recovery_serialization_lease_json_is_valid "$lease_json" || return 1
  jq -e --arg holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg uid "$RECOVERY_SERIALIZATION_LEASE_UID" '
    .metadata.uid == $uid and .spec.holderIdentity == $holder
  ' >/dev/null <<<"$lease_json" || return 1
  renew_epoch="$(recovery_rfc3339_epoch \
    "$(jq -er '.spec.renewTime' <<<"$lease_json")")" || return 1
  now_epoch="$(date -u '+%s')" || return 1
  ((renew_epoch <= now_epoch + 5 && now_epoch - renew_epoch <= 40))
}

recovery_replace_serialization_lease() {
  local lease_json="$1" holder="$2" now="$3" transitions="$4"
  jq -cn --argjson live "$lease_json" --arg holder "$holder" --arg now "$now" \
    --argjson transitions "$transitions" '
    {
      apiVersion:"coordination.k8s.io/v1",kind:"Lease",
      metadata:{name:$live.metadata.name,namespace:$live.metadata.namespace,
        uid:$live.metadata.uid,resourceVersion:$live.metadata.resourceVersion,
        labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
      spec:{holderIdentity:$holder,leaseDurationSeconds:120,
        acquireTime:$now,renewTime:$now,leaseTransitions:$transitions}
    }
  ' | recovery_kubectl replace -f - -o json
}

recovery_acquire_operation_serialization() {
  local prefix="${1:-root-recovery}" lease_json holder now transitions
  local renew_epoch now_epoch duration
  [[ "$prefix" == root-recovery ]] || return 2
  [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 0 ]] || return 2
  holder="$prefix:$(recovery_uuid_v4)" || return 1
  now="$(recovery_rfc3339_now)" || return 1
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" --ignore-not-found -o json)" || return 1
  if [[ -z "$lease_json" ]]; then
    lease_json="$(cat <<EOF | recovery_kubectl create -f - -o json
apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: $RECOVERY_SERIALIZATION_LEASE_NAME
  namespace: $NAMESPACE
  labels:
    yenhubs.org/operation-serialization: deployment-recovery
spec:
  holderIdentity: "$holder"
  leaseDurationSeconds: 120
  acquireTime: "$now"
  renewTime: "$now"
  leaseTransitions: 0
EOF
    )" || {
      printf 'Could not atomically create the deployment/recovery serialization Lease.\n' >&2
      return 1
    }
  else
    recovery_serialization_lease_json_is_valid "$lease_json" || {
      printf 'The deployment/recovery serialization Lease has an unsafe contract.\n' >&2
      return 1
    }
    if [[ -n "$(jq -r '.spec.holderIdentity // ""' <<<"$lease_json")" ]]; then
      renew_epoch="$(recovery_rfc3339_epoch \
        "$(jq -er '.spec.renewTime' <<<"$lease_json")")" || return 1
      now_epoch="$(date -u '+%s')" || return 1
      duration="$(jq -er '.spec.leaseDurationSeconds' <<<"$lease_json")" || return 1
      if (( now_epoch < renew_epoch + duration )); then
        printf 'Another deployment or recovery operation owns the serialization Lease.\n' >&2
        return 1
      fi
    fi
    transitions="$(jq -er '.spec.leaseTransitions + 1' <<<"$lease_json")" || return 1
    lease_json="$(recovery_replace_serialization_lease \
      "$lease_json" "$holder" "$now" "$transitions")" || {
      printf 'Serialization Lease takeover lost its resourceVersion CAS.\n' >&2
      return 1
    }
  fi
  recovery_serialization_lease_json_is_valid "$lease_json" || return 1
  RECOVERY_SERIALIZATION_LEASE_HOLDER="$holder"
  RECOVERY_SERIALIZATION_LEASE_UID="$(jq -er '.metadata.uid' <<<"$lease_json")" || return 1
  RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
  RECOVERY_SERIALIZATION_PARENT_PID="$$"
  if ! RECOVERY_SERIALIZATION_PARENT_START_IDENTITY="$(
    recovery_process_start_identity "$RECOVERY_SERIALIZATION_PARENT_PID"
  )"; then
    recovery_release_operation_serialization >/dev/null 2>&1 || :
    return 1
  fi
  export RECOVERY_SERIALIZATION_LEASE_HOLDER RECOVERY_SERIALIZATION_LEASE_UID \
    RECOVERY_SERIALIZATION_LEASE_REQUIRED RECOVERY_SERIALIZATION_PARENT_PID \
    RECOVERY_SERIALIZATION_PARENT_START_IDENTITY
  if ! recovery_start_operation_serialization_heartbeat; then
    # Ownership was acquired but no heartbeat capability exists. Clear the
    # holder immediately by CAS; never return with an invisible live owner.
    recovery_release_operation_serialization >/dev/null 2>&1 || :
    return 1
  fi
}

recovery_renew_operation_serialization() {
  local lease_json now transitions renewed
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$lease_json" || return 1
  now="$(recovery_rfc3339_now)" || return 1
  transitions="$(jq -er '.spec.leaseTransitions' <<<"$lease_json")" || return 1
  renewed="$(jq -cn --argjson live "$lease_json" \
    --arg holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" --arg now "$now" \
    --argjson transitions "$transitions" '
    {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
      metadata:{name:$live.metadata.name,namespace:$live.metadata.namespace,
        uid:$live.metadata.uid,resourceVersion:$live.metadata.resourceVersion,
        labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
      spec:{holderIdentity:$holder,leaseDurationSeconds:120,
        acquireTime:$live.spec.acquireTime,renewTime:$now,
        leaseTransitions:$transitions}}
  ' | recovery_kubectl replace -f - -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$renewed"
}

recovery_start_operation_serialization_heartbeat() {
  local interval="${RECOVERY_LEASE_HEARTBEAT_SECONDS:-20}" sleeper_pid=""
  local sleeper_start_identity="" heartbeat_start_identity=""
  [[ "$interval" =~ ^([1-9]|[12][0-9]|30)$ ]] || return 2
  RECOVERY_SERIALIZATION_HEARTBEAT_STOP="$(mktemp \
    "${TMPDIR:-/tmp}/yenhubs-lease-stop.XXXXXX")" || return 1
  RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE="$(mktemp \
    "${TMPDIR:-/tmp}/yenhubs-lease-failure.XXXXXX")" || {
    rm -f -- "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP"
    RECOVERY_SERIALIZATION_HEARTBEAT_STOP=""
    return 1
  }
  chmod 600 "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" \
    "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
  (
    # shellcheck disable=SC2317,SC2329 # Invoked indirectly by the TERM/INT trap.
    heartbeat_stop() {
      if [[ "$sleeper_pid" =~ ^[1-9][0-9]*$ &&
            -n "$sleeper_start_identity" ]] &&
         recovery_process_identity_is_live \
           "$sleeper_pid" "$sleeper_start_identity"; then
        kill -TERM "$sleeper_pid" 2>/dev/null || :
        wait "$sleeper_pid" 2>/dev/null || :
      fi
      exit 0
    }
    trap heartbeat_stop TERM INT
    while :; do
      recovery_process_identity_is_live "$RECOVERY_SERIALIZATION_PARENT_PID" \
        "$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" || exit 0
      sleep "$interval" &
      sleeper_pid=$!
      sleeper_start_identity="$(
        recovery_process_start_identity "$sleeper_pid"
      )" || {
        wait "$sleeper_pid" 2>/dev/null || :
        exit 1
      }
      wait "$sleeper_pid" || exit 1
      sleeper_pid=""
      sleeper_start_identity=""
      [[ ! -s "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" ]] || exit 0
      recovery_process_identity_is_live "$RECOVERY_SERIALIZATION_PARENT_PID" \
        "$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" || exit 0
      if ! recovery_renew_operation_serialization; then
        printf 'lease_lost\n' >"$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
        # Renewal may block long enough for the numeric parent PID to be
        # reused. Revalidate its start identity immediately next to TERM.
        if recovery_process_identity_is_live \
          "$RECOVERY_SERIALIZATION_PARENT_PID" \
          "$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY"; then
          kill -TERM "$RECOVERY_SERIALIZATION_PARENT_PID" 2>/dev/null || :
        fi
        exit 1
      fi
    done
  ) &
  RECOVERY_SERIALIZATION_HEARTBEAT_PID=$!
  if ! heartbeat_start_identity="$(recovery_process_start_identity \
      "$RECOVERY_SERIALIZATION_HEARTBEAT_PID")"; then
    # Without an identity capability the child may not be signalled safely.
    # Ask it to stop cooperatively and reap it before reporting failure.
    printf 'stop\n' >"$RECOVERY_SERIALIZATION_HEARTBEAT_STOP"
    wait "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null || :
    RECOVERY_SERIALIZATION_HEARTBEAT_PID=""
    return 1
  fi
  RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY="$heartbeat_start_identity"
  export RECOVERY_SERIALIZATION_HEARTBEAT_STOP \
    RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE \
    RECOVERY_SERIALIZATION_HEARTBEAT_PID \
    RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY
}

recovery_adopt_parent_operation_serialization() {
  local holder="$1" uid="$2" parent_pid="$3" parent_start_identity="$4" lease_json
  [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 0 &&
     "$holder" =~ ^root-recovery:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
     -n "$uid" && "$parent_pid" =~ ^[1-9][0-9]*$ &&
     -n "$parent_start_identity" ]] || return 2
  recovery_process_identity_is_live "$parent_pid" "$parent_start_identity" || return 1
  RECOVERY_SERIALIZATION_LEASE_HOLDER="$holder"
  RECOVERY_SERIALIZATION_LEASE_UID="$uid"
  RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
  RECOVERY_SERIALIZATION_ADOPTED=1
  RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID="$parent_pid"
  RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY="$parent_start_identity"
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  if ! recovery_owned_serialization_lease_json_is_exact "$lease_json"; then
    RECOVERY_SERIALIZATION_LEASE_HOLDER=""
    RECOVERY_SERIALIZATION_LEASE_UID=""
    RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
    RECOVERY_SERIALIZATION_ADOPTED=0
    RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID=""
    RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY=""
    return 1
  fi
}

recovery_require_operation_serialization_local_capability() {
  [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 1 ]] || return 1
  if [[ "$RECOVERY_SERIALIZATION_ADOPTED" == 0 ]]; then
    [[ "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" =~ ^[1-9][0-9]*$ &&
       -n "$RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY" &&
       -f "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE" &&
       ! -s "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE" ]] || return 1
    recovery_process_identity_is_live \
      "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" \
      "$RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY" || return 1
  else
    recovery_process_identity_is_live \
      "$RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID" \
      "$RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY" || return 1
  fi
}

recovery_require_operation_serialization() {
  local lease_json
  recovery_require_operation_serialization_local_capability || return 1
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$lease_json"
}

recovery_require_operation_serialization_stream() {
  local request_timeout_seconds="${1:-5}" lease_json
  [[ "$request_timeout_seconds" =~ ^[1-5]$ ]] || return 2
  recovery_require_operation_serialization_local_capability || return 1
  [[ -n "${EXPECTED_KUBE_CONTEXT:-}" ]] || return 1
  lease_json="$(command kubectl --context "$EXPECTED_KUBE_CONTEXT" \
    --request-timeout="${request_timeout_seconds}s" \
    get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$lease_json"
}

recovery_release_operation_serialization() {
  local lease_json released transitions release_status=0
  [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 1 ]] || return 0
  [[ "$RECOVERY_SERIALIZATION_ADOPTED" == 0 ]] || return 2
  if [[ "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" =~ ^[1-9][0-9]*$ ]]; then
    printf 'stop\n' >"$RECOVERY_SERIALIZATION_HEARTBEAT_STOP"
    if recovery_process_identity_is_live \
      "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" \
      "$RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY"; then
      kill -TERM "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null || :
      if ! wait "$RECOVERY_SERIALIZATION_HEARTBEAT_PID"; then release_status=1; fi
    elif kill -0 "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null; then
      # The PID belongs to another process. Never signal or wait on it.
      release_status=1
    elif ! wait "$RECOVERY_SERIALIZATION_HEARTBEAT_PID" 2>/dev/null; then
      release_status=1
    fi
  fi
  RECOVERY_SERIALIZATION_HEARTBEAT_PID=""
  RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY=""
  lease_json="$(recovery_kubectl get lease "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  recovery_owned_serialization_lease_json_is_exact "$lease_json" || return 1
  transitions="$(jq -er '.spec.leaseTransitions' <<<"$lease_json")" || return 1
  released="$(jq -cn --argjson live "$lease_json" --argjson transitions "$transitions" '
    {apiVersion:"coordination.k8s.io/v1",kind:"Lease",
      metadata:{name:$live.metadata.name,namespace:$live.metadata.namespace,
        uid:$live.metadata.uid,resourceVersion:$live.metadata.resourceVersion,
        labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
      spec:{leaseDurationSeconds:120,leaseTransitions:$transitions}}
  ' | recovery_kubectl replace -f - -o json)" || return 1
  recovery_serialization_lease_json_is_valid "$released" || return 1
  jq -e --arg uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --argjson transitions "$transitions" '
    .metadata.uid == $uid and
    .spec == {leaseDurationSeconds:120,leaseTransitions:$transitions}
  ' >/dev/null <<<"$released" || return 1
  rm -f -- "$RECOVERY_SERIALIZATION_HEARTBEAT_STOP" \
    "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
  RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
  RECOVERY_SERIALIZATION_LEASE_HOLDER=""
  RECOVERY_SERIALIZATION_LEASE_UID=""
  RECOVERY_SERIALIZATION_ADOPTED=0
  RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID=""
  RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY=""
  export RECOVERY_SERIALIZATION_LEASE_REQUIRED \
    RECOVERY_SERIALIZATION_LEASE_HOLDER RECOVERY_SERIALIZATION_LEASE_UID \
    RECOVERY_SERIALIZATION_HEARTBEAT_PID \
    RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY
  [[ "$release_status" == 0 ]]
}

recovery_materialized_legacy_runner_binding_is_valid() {
  local metadata_path="${RECOVERY_CHECKPOINT_METADATA_COPY:-}"
  local inventory_path="${RECOVERY_DEPLOYMENT_INVENTORY_COPY:-}"
  local inventory_digest
  recovery_require_regular_direct_file "$metadata_path" || return 1
  recovery_require_regular_direct_file "$inventory_path" || return 1
  [[ "$(recovery_checkpoint_metadata_schema "$(dirname "$metadata_path")")" == 2 ]] ||
    return 1
  recovery_checkpoint_metadata_is_acceptable \
    "$metadata_path" "$RECOVERY_CHECKPOINT_STAMP" || return 1
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  inventory_digest="$(recovery_sha256_digest "$inventory_path")" || return 1
  [[ "$inventory_digest" == "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" &&
     "$inventory_digest" == "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" ]] ||
    return 1
  jq -e --slurpfile inventory "$inventory_path" '
    .schema_version == 2 and
    ($inventory | length) == 1 and
    $inventory[0].schema_version == 3 and
    $inventory[0].bot_runner_runtime.mode == "process-local" and
    $inventory[0].bot_runner_runtime.control_plane == {state:"legacy-absent"} and
    $inventory[0].bot_runner_runtime.recovery_epoch == {state:"legacy-absent"} and
    .namespace == $inventory[0].namespace and
    .namespace_uid == $inventory[0].namespace_uid
  ' "$metadata_path" >/dev/null
}

recovery_materialized_schema3_runner_binding_is_valid() {
  local expected_generation="$1"
  local metadata_path="${RECOVERY_CHECKPOINT_METADATA_COPY:-}"
  local inventory_path="${RECOVERY_DEPLOYMENT_INVENTORY_COPY:-}"
  local evidence_path="${RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY:-}"
  local inventory_digest evidence_digest
  [[ "$expected_generation" == legacy-absent ||
     "$expected_generation" == durable-v2 ]] || return 2
  recovery_require_regular_direct_file "$metadata_path" || return 1
  recovery_require_regular_direct_file "$inventory_path" || return 1
  recovery_require_regular_direct_file "$evidence_path" || return 1
  recovery_checkpoint_metadata_is_acceptable \
    "$metadata_path" "$RECOVERY_CHECKPOINT_STAMP" || return 1
  recovery_checkpoint_deployment_inventory_is_acceptable \
    "$inventory_path" "$NAMESPACE" || return 1
  recovery_validate_runner_cutover_evidence_offline \
    "$evidence_path" "$inventory_path" >/dev/null || return 1
  inventory_digest="$(recovery_sha256_digest "$inventory_path")" || return 1
  evidence_digest="$(recovery_sha256_digest "$evidence_path")" || return 1
  [[ "$inventory_digest" == "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" &&
     "$evidence_digest" == "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" ]] ||
    return 1
  jq -e --arg generation "$expected_generation" \
    --arg evidence_sha "$evidence_digest" \
    --slurpfile inventory "$inventory_path" --slurpfile evidence "$evidence_path" '
    .schema_version == 3 and .runtime_generation == $generation and
    .runner_cutover_evidence_sha256 == $evidence_sha and
    ($inventory | length) == 1 and ($evidence | length) == 1 and
    $inventory[0].schema_version == 4 and
    $inventory[0].bot_runner_runtime.generation == $generation and
    $evidence[0].runtime_generation == $generation and
    .operation_id == $evidence[0].checkpoint_operation_id and
    .namespace == $inventory[0].namespace and
    .namespace_uid == $inventory[0].namespace_uid and
    .namespace_uid == $evidence[0].namespaces.parent.uid
  ' "$metadata_path" >/dev/null
}

recovery_operation_runner_contract_is_valid() {
  local owner="$1"
  case "$owner" in
    checkpoint-backup)
      [[ -z "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256:-}" &&
         -z "${RECOVERY_RUNNER_RUNTIME_GENERATION:-}" &&
         -z "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" &&
         -z "${RECOVERY_OPERATION_STATE:-}" &&
         -z "${RECOVERY_FENCE_PRE_EPOCH:-}" &&
         -z "${RECOVERY_FENCE_TARGET_EPOCH:-}" ]]
      ;;
    aud065-rotation)
      [[ "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256:-}" =~ ^[a-f0-9]{64}$ &&
         "${RECOVERY_RUNNER_RUNTIME_GENERATION:-}" == legacy-absent &&
         "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" =~ ^[a-f0-9]{64}$ &&
         -z "${RECOVERY_FENCE_PRE_EPOCH:-}" &&
         -z "${RECOVERY_FENCE_TARGET_EPOCH:-}" ]] || return 1
      if [[ -n "${RECOVERY_CHECKPOINT_METADATA_COPY:-}" ||
            -n "${RECOVERY_DEPLOYMENT_INVENTORY_COPY:-}" ||
            -n "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY:-}" ]]; then
        recovery_materialized_schema3_runner_binding_is_valid legacy-absent
      fi
      ;;
    checkpoint-restore)
      [[ "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256:-}" =~ ^[a-f0-9]{64}$ &&
         "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] ||
        return 1
      case "${RECOVERY_CHECKPOINT_METADATA_SCHEMA:-}" in
        2)
          [[ "${RECOVERY_RUNNER_RUNTIME_GENERATION:-}" == legacy-absent &&
             -z "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY:-}" &&
             "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" =~ ^[a-f0-9]{64}$ &&
             "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" == "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" ]] || return 1
          recovery_materialized_legacy_runner_binding_is_valid || return 1
          ;;
        3)
          recovery_materialized_schema3_runner_binding_is_valid \
            "$RECOVERY_RUNNER_RUNTIME_GENERATION" || return 1
          ;;
        freeze-bundle-v1)
          [[ "${RECOVERY_RUNNER_RUNTIME_GENERATION:-}" == legacy-absent &&
             -z "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY:-}" &&
             "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" == \
               "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" &&
             "${RECOVERY_FREEZE_ID:-}" =~ ^[a-f0-9]{32}$ &&
             "${RECOVERY_FREEZE_MANIFEST_SHA256:-}" =~ ^[a-f0-9]{64}$ &&
             -n "${RECOVERY_CHECKPOINT_METADATA_COPY:-}" ]] || return 1
          recovery_verify_freeze_bundle_directory \
            "$(dirname "$RECOVERY_CHECKPOINT_METADATA_COPY")" \
            "$RECOVERY_CHECKPOINT_STAMP" || return 1
          ;;
        *) return 1 ;;
      esac
      case "${RECOVERY_RUNNER_RUNTIME_GENERATION:-}" in
        legacy-absent)
          [[ ( "${RECOVERY_OPERATION_STATE:-}" == legacy-in-place ||
               "${RECOVERY_OPERATION_STATE:-}" == cold-rebind ) &&
             -z "${RECOVERY_FENCE_PRE_EPOCH:-}" &&
             -z "${RECOVERY_FENCE_TARGET_EPOCH:-}" ]]
          ;;
        durable-v2)
          [[ "${RECOVERY_OPERATION_STATE:-}" =~ ^(restore-fence-prepared|restore-complete-awaiting-reactivation)$ &&
             "${RECOVERY_FENCE_PRE_EPOCH:-}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
             "${RECOVERY_FENCE_TARGET_EPOCH:-}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
             "$RECOVERY_FENCE_PRE_EPOCH" != "$RECOVERY_FENCE_TARGET_EPOCH" &&
             "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" =~ ^[a-f0-9]{64}$ ]]
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

recovery_operation_lock_json_is_exact() {
  local lock_json="$1"
  [[ "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     -n "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" &&
     "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_OWNER:-}" =~ ^(checkpoint-backup|checkpoint-restore|aud065-rotation)$ &&
     -n "${RECOVERY_NAMESPACE_UID:-}" && -n "${RECOVERY_PVC_UID:-}" &&
     "${RECOVERY_CHECKPOINT_STAMP:-}" =~ ^[0-9]{8}-[0-9]{6}$ &&
     "${RECOVERY_DUMP_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ &&
     "${RECOVERY_STORAGE_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] || return 1
  if [[ "$RECOVERY_OPERATION_OWNER" == aud065-rotation ]]; then
    [[ "$RECOVERY_OPERATION_BINDING_SHA256" =~ ^[a-f0-9]{64}$ &&
       "$RECOVERY_OPERATION_STATE" =~ ^(preflight|quiesced|db-rotated|bundle-applied|verified|cleanup-authorized)$ ]] || return 1
  else
    [[ -z "$RECOVERY_OPERATION_BINDING_SHA256" ]] || return 1
  fi
  recovery_operation_runner_contract_is_valid \
    "$RECOVERY_OPERATION_OWNER" || return 1
  jq -e \
    --arg name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg namespace "$NAMESPACE" \
    --arg uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg resource_version "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg owner "$RECOVERY_OPERATION_OWNER" \
    --arg token "$RECOVERY_OPERATION_TOKEN" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg pvc_uid "$RECOVERY_PVC_UID" \
    --arg stamp "$RECOVERY_CHECKPOINT_STAMP" \
    --arg dump_sha "$RECOVERY_DUMP_SHA256" \
    --arg storage_sha "$RECOVERY_STORAGE_SHA256" \
    --arg inventory_sha "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" \
    --arg pre_epoch "${RECOVERY_FENCE_PRE_EPOCH:-}" \
    --arg target_epoch "${RECOVERY_FENCE_TARGET_EPOCH:-}" \
    --arg operation_state "${RECOVERY_OPERATION_STATE:-}" \
    --arg operation_binding_sha256 "${RECOVERY_OPERATION_BINDING_SHA256:-}" \
    --arg runner_evidence_sha256 "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256:-}" \
    --arg runner_generation "${RECOVERY_RUNNER_RUNTIME_GENERATION:-}" '
    .apiVersion == "v1" and
    .kind == "ConfigMap" and
    .metadata.name == $name and
    .metadata.namespace == $namespace and
    .metadata.uid == $uid and
    .metadata.resourceVersion == $resource_version and
    (.metadata | has("deletionTimestamp") | not) and
    (.metadata | has("deletionGracePeriodSeconds") | not) and
    (((.metadata | has("finalizers") | not) or .metadata.finalizers == [])) and
    (((.metadata | has("ownerReferences") | not) or .metadata.ownerReferences == [])) and
    (.metadata.labels // {}) == {"yenhubs.org/recovery-owner":$owner} and
    (.metadata.annotations // {}) == ({
      "yenhubs.org/operation-id": $operation_id,
      "yenhubs.org/recovery-token": $token,
      "yenhubs.org/namespace-uid": $namespace_uid,
      "yenhubs.org/pvc-uid": $pvc_uid,
      "yenhubs.org/checkpoint-stamp": $stamp,
      "yenhubs.org/dump-sha256": $dump_sha,
      "yenhubs.org/storage-sha256": $storage_sha
    } + if $inventory_sha == "" then {} else {
      "yenhubs.org/deployment-inventory-sha256":$inventory_sha
    } end + if $pre_epoch == "" and $target_epoch == "" then {} else {
      "yenhubs.org/pre-fence-epoch":$pre_epoch,
      "yenhubs.org/restore-fence-epoch":$target_epoch
    } end + if $operation_state == "" then {} else {
      "yenhubs.org/recovery-state":$operation_state
    } end + if $operation_binding_sha256 == "" then {} else {
      "yenhubs.org/operation-binding-sha256":$operation_binding_sha256
    } end + if $runner_evidence_sha256 == "" and $runner_generation == "" then {} else {
      "yenhubs.org/runner-cutover-evidence-sha256":$runner_evidence_sha256,
      "yenhubs.org/runner-runtime-generation":$runner_generation
    } end) and
    .immutable == true and
    (.data // {}) == {} and
    (.binaryData // {}) == {}
  ' >/dev/null 2>&1 <<<"$lock_json"
}

recovery_require_operation_lock() {
  local lock_json
  if [[ "${RECOVERY_SERIALIZATION_LEASE_REQUIRED:-0}" == 1 ]]; then
    recovery_require_operation_serialization || {
      printf 'The deployment/recovery serialization Lease was lost.\n' >&2
      return 1
    }
  fi
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || {
    printf 'The coordinated recovery lock is missing or unreadable.\n' >&2
    return 1
  }
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    printf 'The coordinated recovery lock identity or operation binding changed.\n' >&2
    return 1
  fi
}

# The recovery byte-stream fence is generated and validated by the Hubs CE
# control plane.  Keep the root transition code bound to those exact exported
# predicates instead of maintaining a second, subtly different CEL contract.
recovery_operation_fence_cloud_helper_path() {
  local repository_root helper
  repository_root="$(cd "$RECOVERY_SAFETY_DIR/../.." && pwd -P)" || return 1
  helper="$repository_root/hubs-cloud/community-edition/apply/runner-activation.js"
  recovery_require_regular_direct_file "$helper" || return 1
  printf '%s\n' "$helper"
}

recovery_operation_fence_pair_is_exact() {
  local state="$1" policy_json="$2" binding_json="$3" helper payload
  [[ "$state" == dormant || "$state" == active ]] || return 2
  [[ -n "${NAMESPACE:-}" && -n "$policy_json" && -n "$binding_json" ]] ||
    return 2
  helper="$(recovery_operation_fence_cloud_helper_path)" || return 1
  payload="$(jq -cn --argjson policy "$policy_json" \
    --argjson binding "$binding_json" '{policy:$policy,binding:$binding}')" ||
    return 1
  printf '%s' "$payload" | command node -e '
const fs = require("node:fs");
const helperPath = process.argv[1];
const namespace = process.argv[2];
const state = process.argv[3];
const {
  RECOVERY_OPERATION_FENCE_POLICY_NAME,
  admissionPolicyIsObserved,
  exactRecoveryOperationFenceBinding,
  exactRecoveryOperationFencePolicy
} = require(helperPath);
let pair;
try {
  pair = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(1);
}
const allowedMetadata = new Set([
  "annotations", "creationTimestamp", "generation", "managedFields",
  "name", "resourceVersion", "uid"
]);
function transitionableMetadata(resource) {
  const metadata = resource?.metadata;
  const annotations = metadata?.annotations || {};
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
    Object.keys(metadata).every(key => allowedMetadata.has(key)) &&
    Object.keys(annotations).every(key =>
      key === "kubectl.kubernetes.io/last-applied-configuration"
    ) &&
    (metadata.labels === undefined || Object.keys(metadata.labels).length === 0) &&
    metadata.deletionTimestamp === undefined &&
    metadata.deletionGracePeriodSeconds === undefined &&
    metadata.finalizers === undefined && metadata.ownerReferences === undefined &&
    metadata.name === RECOVERY_OPERATION_FENCE_POLICY_NAME &&
    typeof metadata.uid === "string" && metadata.uid.length > 0 &&
    typeof metadata.resourceVersion === "string" &&
      metadata.resourceVersion.length > 0;
}
if (
  !pair || typeof pair !== "object" || Array.isArray(pair) ||
  Object.keys(pair).sort().join("\n") !== "binding\npolicy" ||
  !transitionableMetadata(pair.policy) ||
  !transitionableMetadata(pair.binding) ||
  !admissionPolicyIsObserved(pair.policy) ||
  !exactRecoveryOperationFencePolicy(pair.policy, namespace) ||
  !exactRecoveryOperationFenceBinding(pair.binding, namespace, {
    active: state === "active"
  })
) {
  process.exit(1);
}
' "$helper" "$NAMESPACE" "$state"
}

recovery_operation_fence_identity_json() {
  local state="$1" policy_json="$2" binding_json="$3"
  [[ "$state" == dormant || "$state" == active ]] || return 2
  [[ -n "${RECOVERY_NAMESPACE_UID:-}" &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_OWNER:-}" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     -n "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" &&
     "${RECOVERY_SERIALIZATION_LEASE_NAME:-}" == "yenhubs-operation-serialization" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_UID:-}" &&
     "${RECOVERY_SERIALIZATION_LEASE_HOLDER:-}" =~ ^root-recovery: ]] ||
    return 1
  jq -cnS \
    --arg state "$state" \
    --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$RECOVERY_OPERATION_OWNER" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg policy_uid "$(jq -er '.metadata.uid' <<<"$policy_json")" \
    --arg policy_rv "$(jq -er '.metadata.resourceVersion' <<<"$policy_json")" \
    --arg binding_uid "$(jq -er '.metadata.uid' <<<"$binding_json")" \
    --arg binding_rv "$(jq -er '.metadata.resourceVersion' <<<"$binding_json")" '
    {schema_version:1,state:$state,namespace:$namespace,
     namespace_uid:$namespace_uid,operation_id:$operation_id,
     operation_owner:$operation_owner,
     operation_lock:{name:$lock_name,uid:$lock_uid,resource_version:$lock_rv},
     lease:{name:$lease_name,uid:$lease_uid,holder:$lease_holder},
     policy:{uid:$policy_uid,resource_version:$policy_rv},
     binding:{uid:$binding_uid,resource_version:$binding_rv}}
  '
}

recovery_operation_fence_identity_is_exact() {
  local identity_json="$1" expected_state="$2"
  [[ "$expected_state" == dormant || "$expected_state" == active ]] || return 2
  jq -e \
    --arg state "$expected_state" --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$RECOVERY_OPERATION_OWNER" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" '
    (keys | sort) == ["binding","lease","namespace","namespace_uid",
      "operation_id","operation_lock","operation_owner","policy",
      "schema_version","state"] and
    .schema_version == 1 and .state == $state and
    .namespace == $namespace and .namespace_uid == $namespace_uid and
    .operation_id == $operation_id and .operation_owner == $operation_owner and
    .operation_lock == {name:$lock_name,uid:$lock_uid,resource_version:$lock_rv} and
    .lease == {name:$lease_name,uid:$lease_uid,holder:$lease_holder} and
    (.policy | keys | sort) == ["resource_version","uid"] and
    (.binding | keys | sort) == ["resource_version","uid"] and
    all(.policy.uid,.policy.resource_version,.binding.uid,
      .binding.resource_version; type == "string" and length > 0)
  ' >/dev/null 2>&1 <<<"$identity_json"
}

# Reads the pair once and returns a canonical, process-authority-bound identity.
# Supplying an expected identity additionally pins both resourceVersions, so an
# active -> dormant -> active ABA excursion cannot be mistaken for continuity.
recovery_read_recovery_operation_fence_state() {
  local state="$1" expected_identity="${2:-}"
  local policy_json binding_json identity_json
  [[ "$state" == dormant || "$state" == active ]] || return 2
  policy_json="$(recovery_kubectl get validatingadmissionpolicy \
    "$RECOVERY_OPERATION_FENCE_POLICY_NAME" -o json)" || return 1
  binding_json="$(recovery_kubectl get validatingadmissionpolicybinding \
    "$RECOVERY_OPERATION_FENCE_POLICY_NAME" -o json)" || return 1
  recovery_operation_fence_pair_is_exact \
    "$state" "$policy_json" "$binding_json" || return 1
  identity_json="$(recovery_operation_fence_identity_json \
    "$state" "$policy_json" "$binding_json")" || return 1
  if [[ -n "$expected_identity" ]]; then
    recovery_operation_fence_identity_is_exact \
      "$expected_identity" "$state" || return 1
    [[ "$identity_json" == "$expected_identity" ]] || return 1
  fi
  printf '%s\n' "$identity_json"
}

recovery_require_recovery_operation_fence_state() {
  local state="$1" expected_identity="${2:-}"
  [[ "$state" == dormant || "$state" == active ]] || return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_read_recovery_operation_fence_state \
    "$state" "$expected_identity" >/dev/null || {
    printf 'The recovery operation admission fence is missing, deleting, drifted or changed identity.\n' >&2
    return 1
  }
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
}

recovery_operation_fence_probe_document() {
  local probe="$1" helper repository_root
  case "$probe" in
    parent-writer)
      jq -cn --arg namespace "$NAMESPACE" '
        {apiVersion:"v1",kind:"Pod",metadata:{
          generateName:"yenhubs-recovery-operation-writer-probe-",
          namespace:$namespace,labels:{app:"reticulum"}},spec:{
          automountServiceAccountToken:false,enableServiceLinks:false,
          restartPolicy:"Never",terminationGracePeriodSeconds:0,
          securityContext:{runAsNonRoot:true,runAsUser:10001,runAsGroup:10001,
            seccompProfile:{type:"RuntimeDefault"}},containers:[{
            name:"reticulum",image:"registry.k8s.io/pause:3.10",
            imagePullPolicy:"IfNotPresent",securityContext:{runAsNonRoot:true,
              runAsUser:10001,runAsGroup:10001,allowPrivilegeEscalation:false,
              readOnlyRootFilesystem:true,capabilities:{drop:["ALL"]},
              seccompProfile:{type:"RuntimeDefault"}},resources:{
              requests:{cpu:"1m",memory:"1Mi"},
              limits:{cpu:"1m",memory:"1Mi"}}}]}}
      '
      ;;
    runner)
      repository_root="$(cd "$RECOVERY_SAFETY_DIR/../.." && pwd -P)" || return 1
      helper="$repository_root/hubs-cloud/community-edition/services/bot-orchestrator/kubernetes-runner-manager.js"
      recovery_require_regular_direct_file "$helper" || return 1
      # shellcheck disable=SC2016 # The single-quoted source is evaluated by Node.
      command node -e '
const helper = require(process.argv[1]);
const identity = {
  roomKey: "55555555555555555555",
  processGeneration: "55555555-5555-4555-8555-555555555555"
};
identity.name = `bot-runner-${identity.roomKey.substring(0, 16)}-${identity.processGeneration.substring(0, 8)}`;
process.stdout.write(JSON.stringify(helper.guardPodDocumentForIdentity(
  identity, "fence", "hcce-bot-runners"
)));
' "$helper"
      ;;
    *) return 2 ;;
  esac
}

recovery_operation_fence_probe_one() {
  local state="$1" probe="$2" expected_message="$3"
  local document diagnostic status=0
  document="$(recovery_operation_fence_probe_document "$probe")" || return 1
  if diagnostic="$(printf '%s' "$document" | \
      recovery_kubectl create --dry-run=server -f - 2>&1)"; then
    status=0
  else
    status=$?
  fi
  if [[ "$state" == active ]]; then
    [[ "$status" != 0 &&
       "$diagnostic" == *"$RECOVERY_OPERATION_FENCE_POLICY_NAME"* &&
       "$diagnostic" == *"$expected_message"* &&
       "$diagnostic" != *'violates PodSecurity'* ]]
  elif [[ "$state" == dormant ]]; then
    [[ "$status" == 0 &&
       "$diagnostic" != *"$RECOVERY_OPERATION_FENCE_POLICY_NAME"* &&
       "$diagnostic" != *'recovery operation Pod fence denies'* ]]
  else
    return 2
  fi
}

recovery_operation_fence_probes_match_state() {
  local state="$1"
  recovery_operation_fence_probe_one "$state" parent-writer \
    'recovery operation Pod fence denies database-writer Pod creation while checkpoint or restore is fenced' &&
    recovery_operation_fence_probe_one "$state" runner \
      'recovery operation Pod fence denies runner Pod mutation while checkpoint or restore is fenced'
}

recovery_wait_recovery_operation_fence_propagation() {
  local state="$1" expected_identity="$2" attempt=0 attempts=60
  local retry_delay="${RECOVERY_WAIT_RETRY_DELAY_SECONDS:-1}"
  [[ "$state" == dormant || "$state" == active ]] || return 2
  [[ "$retry_delay" =~ ^[01]$ ]] || return 2
  if [[ "${YENHUBS_RECOVERY_TEST_MODE:-}" == local-fixture ]]; then
    recovery_require_local_fixture_attestation || return 1
    attempts=3
  fi
  while ((attempt < attempts)); do
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    recovery_read_recovery_operation_fence_state \
      "$state" "$expected_identity" >/dev/null || return 1
    if recovery_operation_fence_probes_match_state "$state"; then
      recovery_require_operation_serialization || return 1
      recovery_require_operation_lock || return 1
      recovery_read_recovery_operation_fence_state \
        "$state" "$expected_identity" >/dev/null || return 1
      return 0
    fi
    attempt=$((attempt + 1))
    ((attempt >= attempts || retry_delay == 0)) || sleep "$retry_delay"
  done
  printf 'Recovery operation fence %s propagation did not satisfy both exact server-side dry-run probes.\n' \
    "$state" >&2
  return 1
}

recovery_transition_recovery_operation_fence() {
  local source_state="$1" target_state="$2" expected_source_identity="$3"
  local output_variable="$4" before_identity before_policy before_binding
  local replacement replaced after_identity after_policy after_binding final_identity
  local before_policy_uid before_policy_rv before_binding_uid before_binding_rv
  local replaced_binding_uid replaced_binding_rv
  [[ "$source_state" == dormant || "$source_state" == active ]] || return 2
  [[ "$target_state" == dormant || "$target_state" == active ]] || return 2
  [[ "$source_state" != "$target_state" &&
     "$output_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 2
  if [[ "$source_state" == active ]]; then
    [[ -n "$expected_source_identity" ]] || return 2
    recovery_operation_fence_identity_is_exact \
      "$expected_source_identity" active || return 2
  elif [[ -n "$expected_source_identity" ]]; then
    return 2
  fi
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  before_policy="$(recovery_kubectl get validatingadmissionpolicy \
    "$RECOVERY_OPERATION_FENCE_POLICY_NAME" -o json)" || return 1
  before_binding="$(recovery_kubectl get validatingadmissionpolicybinding \
    "$RECOVERY_OPERATION_FENCE_POLICY_NAME" -o json)" || return 1
  recovery_operation_fence_pair_is_exact \
    "$source_state" "$before_policy" "$before_binding" || {
    printf 'Recovery operation fence source state is absent, deleting or drifted.\n' >&2
    return 1
  }
  before_identity="$(recovery_operation_fence_identity_json \
    "$source_state" "$before_policy" "$before_binding")" || return 1
  if [[ -n "$expected_source_identity" &&
        "$before_identity" != "$expected_source_identity" ]]; then
    printf 'Recovery operation fence source identity changed before compare-and-swap.\n' >&2
    return 1
  fi
  before_policy_uid="$(jq -er '.metadata.uid' <<<"$before_policy")" || return 1
  before_policy_rv="$(jq -er '.metadata.resourceVersion' <<<"$before_policy")" ||
    return 1
  before_binding_uid="$(jq -er '.metadata.uid' <<<"$before_binding")" || return 1
  before_binding_rv="$(jq -er '.metadata.resourceVersion' <<<"$before_binding")" ||
    return 1
  replacement="$(jq -cn \
    --arg name "$RECOVERY_OPERATION_FENCE_POLICY_NAME" \
    --arg uid "$before_binding_uid" --arg rv "$before_binding_rv" \
    --arg namespace "$NAMESPACE" --arg state "$target_state" '
    {apiVersion:"admissionregistration.k8s.io/v1",
     kind:"ValidatingAdmissionPolicyBinding",
     metadata:{name:$name,uid:$uid,resourceVersion:$rv},
     spec:{policyName:$name,validationActions:["Deny"],matchResources:{
       matchPolicy:"Equivalent",namespaceSelector:{matchExpressions:[
         if $state == "active" then
           {key:"kubernetes.io/metadata.name",operator:"In",
            values:[$namespace,"hcce-bot-runners"]}
         else
           {key:"kubernetes.io/metadata.name",operator:"DoesNotExist"}
         end]},objectSelector:{}}}}
  ')" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  replaced="$(printf '%s' "$replacement" | \
    recovery_kubectl replace -f - -o json)" || {
    printf 'Recovery operation fence binding compare-and-swap failed.\n' >&2
    return 1
  }
  recovery_operation_fence_pair_is_exact \
    "$target_state" "$before_policy" "$replaced" || return 1
  replaced_binding_uid="$(jq -er '.metadata.uid' <<<"$replaced")" || return 1
  replaced_binding_rv="$(jq -er '.metadata.resourceVersion' <<<"$replaced")" ||
    return 1
  [[ "$replaced_binding_uid" == "$before_binding_uid" &&
     "$replaced_binding_rv" != "$before_binding_rv" ]] || {
    printf 'Recovery operation fence compare-and-swap did not preserve UID and advance resourceVersion.\n' >&2
    return 1
  }
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  after_policy="$(recovery_kubectl get validatingadmissionpolicy \
    "$RECOVERY_OPERATION_FENCE_POLICY_NAME" -o json)" || return 1
  after_binding="$(recovery_kubectl get validatingadmissionpolicybinding \
    "$RECOVERY_OPERATION_FENCE_POLICY_NAME" -o json)" || return 1
  recovery_operation_fence_pair_is_exact \
    "$target_state" "$after_policy" "$after_binding" || return 1
  [[ "$(jq -er '.metadata.uid' <<<"$after_policy")" == "$before_policy_uid" &&
     "$(jq -er '.metadata.resourceVersion' <<<"$after_policy")" == "$before_policy_rv" &&
     "$(jq -er '.metadata.uid' <<<"$after_binding")" == "$replaced_binding_uid" &&
     "$(jq -er '.metadata.resourceVersion' <<<"$after_binding")" == "$replaced_binding_rv" ]] || {
    printf 'Recovery operation fence identity changed while confirming compare-and-swap.\n' >&2
    return 1
  }
  after_identity="$(recovery_operation_fence_identity_json \
    "$target_state" "$after_policy" "$after_binding")" || return 1
  recovery_wait_recovery_operation_fence_propagation \
    "$target_state" "$after_identity" || return 1
  final_identity="$(recovery_read_recovery_operation_fence_state \
    "$target_state" "$after_identity")" || return 1
  printf -v "$output_variable" '%s' "$final_identity"
}

recovery_activate_recovery_operation_fence() {
  local output_variable="$1"
  recovery_transition_recovery_operation_fence \
    dormant active '' "$output_variable"
}

recovery_deactivate_recovery_operation_fence() {
  local active_identity="$1" output_variable="$2"
  recovery_transition_recovery_operation_fence \
    active dormant "$active_identity" "$output_variable"
}

recovery_acquire_operation_lock() {
  local owner="$1"
  local lock_name="${2:-$RECOVERY_OPERATION_LOCK_GLOBAL_NAME}"
  local lock_json fence_annotations="" inventory_annotation=""
  local state_annotation="" binding_annotation=""
  local runner_checkpoint_annotations="" create_status=0
  local lock_uid="" lock_resource_version=""
  [[ "$owner" =~ ^(checkpoint-backup|checkpoint-restore|aud065-rotation)$ &&
     "$lock_name" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_NAMESPACE_UID:-}" && -n "${RECOVERY_PVC_UID:-}" &&
     "${RECOVERY_CHECKPOINT_STAMP:-}" =~ ^[0-9]{8}-[0-9]{6}$ &&
     "${RECOVERY_DUMP_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ &&
     "${RECOVERY_STORAGE_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] || return 2
  recovery_require_operation_serialization || {
    printf 'The deployment/recovery serialization Lease is required before creating an operation lock.\n' >&2
    return 1
  }
  RECOVERY_OPERATION_OWNER="$owner"
  RECOVERY_OPERATION_LOCK_NAME="$lock_name"
  RECOVERY_OPERATION_LOCK_UID=""
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=""
  recovery_operation_runner_contract_is_valid "$owner" || {
    printf 'Recovery locks require the exact runner-generation evidence contract.\n' >&2
    return 2
  }
  if [[ "$owner" == checkpoint-restore || "$owner" == aud065-rotation ]]; then
    [[ "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] ||
      return 2
    inventory_annotation="$(printf '    yenhubs.org/deployment-inventory-sha256: "%s"' \
      "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256")"
  fi
  if [[ -n "${RECOVERY_FENCE_PRE_EPOCH:-}" || -n "${RECOVERY_FENCE_TARGET_EPOCH:-}" ]]; then
    [[ "$owner" == checkpoint-restore &&
       ( "$RECOVERY_FENCE_PRE_EPOCH" == legacy-absent ||
         "$RECOVERY_FENCE_PRE_EPOCH" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ) &&
       "$RECOVERY_FENCE_TARGET_EPOCH" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || return 2
    fence_annotations="$(printf '    yenhubs.org/pre-fence-epoch: "%s"\n    yenhubs.org/restore-fence-epoch: "%s"' \
      "$RECOVERY_FENCE_PRE_EPOCH" "$RECOVERY_FENCE_TARGET_EPOCH")"
  fi
  if [[ -n "${RECOVERY_OPERATION_STATE:-}" ]]; then
    [[ ( "$owner" == checkpoint-restore || "$owner" == aud065-rotation ) &&
       "$RECOVERY_OPERATION_STATE" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || return 2
    if [[ "$owner" == aud065-rotation &&
          "$RECOVERY_OPERATION_STATE" != preflight ]]; then
      return 2
    fi
    state_annotation="$(printf '    yenhubs.org/recovery-state: "%s"' \
      "$RECOVERY_OPERATION_STATE")"
  fi
  if [[ -n "${RECOVERY_OPERATION_BINDING_SHA256:-}" ]]; then
    [[ "$owner" == aud065-rotation &&
       "$RECOVERY_OPERATION_BINDING_SHA256" =~ ^[a-f0-9]{64}$ &&
       "$RECOVERY_OPERATION_STATE" == preflight ]] || return 2
    binding_annotation="$(printf '    yenhubs.org/operation-binding-sha256: "%s"' \
      "$RECOVERY_OPERATION_BINDING_SHA256")"
  elif [[ "$owner" == aud065-rotation ]]; then
    printf 'AUD-065 rotation locks require an exact private-operation binding.\n' >&2
    return 2
  fi
  if [[ "$owner" == checkpoint-restore || "$owner" == aud065-rotation ]]; then
    runner_checkpoint_annotations="$(printf '    yenhubs.org/runner-cutover-evidence-sha256: "%s"\n    yenhubs.org/runner-runtime-generation: "%s"' \
      "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" \
      "$RECOVERY_RUNNER_RUNTIME_GENERATION")"
  fi
  if [[ "$owner" == aud065-rotation ||
        ( "$owner" == checkpoint-restore &&
          "${RECOVERY_OPERATION_STATE:-}" == cold-rebind ) ]]; then
    [[ "$RECOVERY_OPERATION_IDENTITY_PREBOUND" == 1 &&
       "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
       "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ ]] || {
      printf 'This recovery operation requires identifiers to be prebound before lock creation.\n' >&2
      return 2
    }
  else
    if ! RECOVERY_OPERATION_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" ||
       [[ ! "$RECOVERY_OPERATION_TOKEN" =~ ^[a-f0-9]{32}$ ]] ||
       ! RECOVERY_OPERATION_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" ||
       [[ ! "$RECOVERY_OPERATION_ID" =~ ^[a-f0-9]{32}$ ]]; then
      printf 'Could not create private recovery-operation identifiers.\n' >&2
      return 1
    fi
  fi
  if cat <<EOF | recovery_kubectl_mutate create -f - >/dev/null
apiVersion: v1
kind: ConfigMap
metadata:
  name: $RECOVERY_OPERATION_LOCK_NAME
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: $RECOVERY_OPERATION_OWNER
  annotations:
    yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
    yenhubs.org/recovery-token: "$RECOVERY_OPERATION_TOKEN"
    yenhubs.org/namespace-uid: "$RECOVERY_NAMESPACE_UID"
    yenhubs.org/pvc-uid: "$RECOVERY_PVC_UID"
    yenhubs.org/checkpoint-stamp: "$RECOVERY_CHECKPOINT_STAMP"
    yenhubs.org/dump-sha256: "$RECOVERY_DUMP_SHA256"
    yenhubs.org/storage-sha256: "$RECOVERY_STORAGE_SHA256"
$inventory_annotation
$fence_annotations
$state_annotation
$binding_annotation
$runner_checkpoint_annotations
immutable: true
EOF
  then
    create_status=0
  else
    create_status=$?
  fi
  # A transport failure can follow a committed create. Resolve that ambiguity
  # only by reading the named immutable object under the still-owned Lease and
  # proving its private token, operation ID and entire expected contract. A
  # competing or malformed lock therefore remains indistinguishable from
  # failure and is never adopted by name alone.
  recovery_require_operation_serialization || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || {
    printf 'Another recovery operation owns the target or the global lock could not be created.\n' >&2
    return 1
  }
  recovery_require_operation_serialization || return 1
  lock_uid="$(jq -er \
    '.metadata.uid | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  lock_resource_version="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  RECOVERY_OPERATION_LOCK_UID="$lock_uid"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$lock_resource_version"
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    RECOVERY_OPERATION_LOCK_UID=""
    RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=""
    if [[ "$create_status" == 0 ]]; then
      printf 'Created recovery lock does not match its exact operation contract.\n' >&2
    else
      printf 'Another recovery operation owns the target or the global lock could not be reconciled.\n' >&2
    fi
    return 1
  fi
  export RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID RECOVERY_OPERATION_STATE \
    RECOVERY_OPERATION_BINDING_SHA256
}

# Recover the exact AUD-065 lock after a crash in the remote-create to local
# UID/resourceVersion persistence window. The token and operation ID already
# live in the private operation state; no name-only lock may ever be adopted.
recovery_discover_aud065_operation_lock() {
  local lock_json live_uid live_resource_version live_state
  local previous_uid previous_resource_version previous_state
  [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation &&
     "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_BINDING_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  recovery_require_operation_serialization || {
    printf 'The deployment/recovery serialization Lease is required before discovering an AUD-065 lock.\n' >&2
    return 1
  }
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || {
    printf 'The persisted AUD-065 lock is missing or unreadable.\n' >&2
    return 1
  }
  live_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  live_resource_version="$(jq -er '
    .metadata.resourceVersion | select(type == "string" and length > 0)
  ' <<<"$lock_json")" || return 1
  live_state="$(jq -er '
    .metadata.annotations["yenhubs.org/recovery-state"] |
    select(type == "string" and
      test("^(preflight|quiesced|db-rotated|bundle-applied|verified|cleanup-authorized)$"))
  ' <<<"$lock_json")" || return 1
  previous_uid="${RECOVERY_OPERATION_LOCK_UID:-}"
  previous_resource_version="${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}"
  previous_state="${RECOVERY_OPERATION_STATE:-}"
  RECOVERY_OPERATION_LOCK_UID="$live_uid"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$live_resource_version"
  RECOVERY_OPERATION_STATE="$live_state"
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    RECOVERY_OPERATION_LOCK_UID="$previous_uid"
    RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$previous_resource_version"
    RECOVERY_OPERATION_STATE="$previous_state"
    printf 'The persisted AUD-065 lock does not match the durable private identity.\n' >&2
    return 1
  fi
  export RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_STATE
}

recovery_adopt_aud065_operation_lock() {
  local lock_json live_state live_resource_version previous_state
  local previous_resource_version
  [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation &&
     "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_BINDING_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  recovery_require_operation_serialization || {
    printf 'The deployment/recovery serialization Lease is required before adopting an AUD-065 lock.\n' >&2
    return 1
  }
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || {
    printf 'The persisted AUD-065 lock is missing or unreadable.\n' >&2
    return 1
  }
  live_state="$(jq -er '
    .metadata.annotations["yenhubs.org/recovery-state"] |
    select(type == "string" and
      test("^(preflight|quiesced|db-rotated|bundle-applied|verified|cleanup-authorized)$"))
  ' <<<"$lock_json")" || return 1
  live_resource_version="$(jq -er '
    .metadata.resourceVersion | select(type == "string" and length > 0)
  ' <<<"$lock_json")" || return 1
  previous_state="${RECOVERY_OPERATION_STATE:-}"
  previous_resource_version="${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}"
  RECOVERY_OPERATION_STATE="$live_state"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$live_resource_version"
  if ! recovery_operation_lock_json_is_exact "$lock_json"; then
    RECOVERY_OPERATION_STATE="$previous_state"
    RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$previous_resource_version"
    printf 'The persisted AUD-065 lock does not match the private operation identity.\n' >&2
    return 1
  fi
  export RECOVERY_OPERATION_STATE RECOVERY_OPERATION_LOCK_RESOURCE_VERSION
}

recovery_transition_aud065_operation_lock() {
  local next_state="${1:-}" lock_json replacement replaced_json
  local previous_state previous_resource_version next_resource_version live_uid
  [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation &&
     "${RECOVERY_OPERATION_BINDING_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  previous_state="${RECOVERY_OPERATION_STATE:-}"
  case "$previous_state:$next_state" in
    preflight:quiesced|quiesced:db-rotated|db-rotated:bundle-applied|bundle-applied:verified|verified:cleanup-authorized) ;;
    *)
      printf 'AUD-065 lock transitions must advance exactly one state.\n' >&2
      return 2
      ;;
  esac
  recovery_require_operation_serialization || {
    printf 'The deployment/recovery serialization Lease is required before changing an AUD-065 lock.\n' >&2
    return 1
  }
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  lock_json="$(
    recovery_kubectl get configmap "$RECOVERY_OPERATION_LOCK_NAME" \
      -n "$NAMESPACE" -o json
  )" || return 1
  recovery_operation_lock_json_is_exact "$lock_json" || {
    printf 'The AUD-065 lock changed before its state transition.\n' >&2
    return 1
  }
  previous_resource_version="$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION"
  replacement="$(jq -c --arg next_state "$next_state" '
    .metadata.annotations["yenhubs.org/recovery-state"] = $next_state |
    del(.metadata.managedFields)
  ' <<<"$lock_json")" || return 1
  replaced_json="$(printf '%s\n' "$replacement" |
    recovery_kubectl_mutate replace -f - -o json)" || {
    printf 'The AUD-065 lock state transition failed its resourceVersion precondition.\n' >&2
    return 1
  }
  live_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$replaced_json")" || return 1
  next_resource_version="$(jq -er '
    .metadata.resourceVersion | select(type == "string" and length > 0)
  ' <<<"$replaced_json")" || return 1
  [[ "$live_uid" == "$RECOVERY_OPERATION_LOCK_UID" &&
     "$next_resource_version" != "$previous_resource_version" ]] || return 1
  RECOVERY_OPERATION_STATE="$next_state"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$next_resource_version"
  export RECOVERY_OPERATION_STATE RECOVERY_OPERATION_LOCK_RESOURCE_VERSION
  recovery_operation_lock_json_is_exact "$replaced_json" || {
    printf 'The transitioned AUD-065 lock does not match its exact contract.\n' >&2
    return 1
  }
}

recovery_release_operation_lock() {
  if [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation ]]; then
    [[ "${RECOVERY_OPERATION_STATE:-}" == cleanup-authorized ]] || {
      printf 'AUD-065 operation locks remain durable until cleanup is durably authorized.\n' >&2
      return 2
    }
    recovery_require_operation_serialization || return 1
    if ! declare -F aud065_require_pgsql_barrier_released >/dev/null 2>&1; then
      printf 'AUD-065 lock release requires the PostgreSQL barrier cleanup contract.\n' >&2
      return 1
    fi
    aud065_require_pgsql_barrier_released || {
      printf 'AUD-065 lock release requires a clean PostgreSQL ingress barrier and no probe.\n' >&2
      return 1
    }
  fi
  recovery_require_operation_lock || return 1
  recovery_delete_namespaced_with_uid_in_namespace \
    "$NAMESPACE" configmap "$RECOVERY_OPERATION_LOCK_NAME" \
    "$RECOVERY_OPERATION_LOCK_UID" 60 \
    "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION"
}

recovery_delete_namespaced_with_uid() {
  recovery_delete_namespaced_with_uid_in_namespace \
    "$NAMESPACE" "$1" "$2" "$3" "${4:-60}" "" "${5:-Foreground}"
}

recovery_delete_namespaced_with_uid_in_namespace() {
  local target_namespace="$1"
  local kind="$2"
  local name="$3"
  local uid="$4"
  local timeout_seconds="${5:-60}"
  local expected_resource_version="${6:-}"
  local propagation_policy="${7:-Foreground}"
  local api_path current_json current_uid delete_options delete_status=0 started
  [[ "$target_namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ &&
     "$name" =~ ^[A-Za-z0-9._-]+$ && -n "$uid" &&
     ( -z "$expected_resource_version" ||
       "$expected_resource_version" =~ ^[A-Za-z0-9._:-]+$ ) &&
     ( "$propagation_policy" == Foreground ||
       "$propagation_policy" == Background ) &&
     "$timeout_seconds" =~ ^[0-9]+$ && "$timeout_seconds" -gt 0 ]] || return 2
  case "$kind" in
    configmap)
      api_path="/api/v1/namespaces/$target_namespace/configmaps/$name"
      ;;
    pod)
      api_path="/api/v1/namespaces/$target_namespace/pods/$name"
      ;;
    networkpolicy)
      api_path="/apis/networking.k8s.io/v1/namespaces/$target_namespace/networkpolicies/$name"
      ;;
    *)
      return 2
      ;;
  esac
  delete_options="$(jq -cn --arg uid "$uid" --arg resource_version "$expected_resource_version" \
    --arg propagation_policy "$propagation_policy" '{
      apiVersion:"v1", kind:"DeleteOptions",
      propagationPolicy:$propagation_policy,
      preconditions:({uid:$uid} +
        (if $resource_version == "" then {} else {resourceVersion:$resource_version} end))
    }')" || return 1
  if recovery_kubectl_mutate delete --raw="$api_path" -f - \
      <<<"$delete_options" >/dev/null; then
    delete_status=0
  else
    delete_status=$?
  fi
  if [[ "$delete_status" != 0 ]]; then
    printf 'UID/resourceVersion-preconditioned deletion failed for %s/%s.\n' \
      "$kind" "$name" >&2
    return 1
  fi
  started="$SECONDS"
  while ((SECONDS - started < timeout_seconds)); do
    # --ignore-not-found makes only a confirmed 404 an empty success. Network,
    # authorization and API failures remain nonzero and must never be treated
    # as proof that the exact UID disappeared.
    current_json="$(recovery_kubectl get "$kind" "$name" \
      -n "$target_namespace" --ignore-not-found -o json)" || return 1
    [[ -n "$current_json" ]] || return 0
    current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
      <<<"$current_json")" || return 1
    # A same-name replacement is not ours and must never be deleted or waited
    # on. The UID-preconditioned target is already gone in this case.
    [[ "$current_uid" == "$uid" ]] || return 0
    sleep "${RECOVERY_DELETE_POLL_SECONDS:-1}"
  done
  printf 'Timed out waiting for UID-preconditioned deletion of %s/%s.\n' \
    "$kind" "$name" >&2
  return 1
}

recovery_pod_pvc_mount_is_exact() {
  local pods_json="$1"
  local pod_name="$2"
  local container_name="$3"
  local claim_name="$4"
  local mount_path="$5"
  [[ -n "$pods_json" && -n "$pod_name" && -n "$container_name" &&
     -n "$claim_name" && "$mount_path" == /* ]] || return 2
  jq -e \
    --arg pod "$pod_name" \
    --arg container "$container_name" \
    --arg claim "$claim_name" \
    --arg mount_path "$mount_path" '
    [.items[] | select(.metadata.name == $pod)] as $pods |
    ($pods | length) == 1 and
    $pods[0].spec as $spec |
    [$spec.volumes[]? | select(.persistentVolumeClaim.claimName == $claim)] as $claim_volumes |
    ($claim_volumes | length) == 1 and
    $claim_volumes[0] as $claim_volume |
    (($claim_volume | keys | sort) == ["name", "persistentVolumeClaim"]) and
    (($claim_volume.persistentVolumeClaim | keys - ["claimName", "readOnly"]) | length) == 0 and
    ($claim_volume.name | type == "string" and length > 0) and
    ([($spec.containers // [])[] | select(.name == $container)] | length) == 1 and
    [
      (($spec.initContainers // []) + ($spec.containers // []) +
       ($spec.ephemeralContainers // []))[] as $candidate |
      ($candidate.volumeMounts // [])[] |
      select(.name == $claim_volume.name) |
      {container: $candidate.name, mount: .}
    ] as $claim_mounts |
    ($claim_mounts | length) == 1 and
    $claim_mounts[0].container == $container and
    $claim_mounts[0].mount.mountPath == $mount_path and
    (($claim_mounts[0].mount.subPath // "") == "") and
    (($claim_mounts[0].mount.subPathExpr // "") == "") and
    ([($spec.containers // [])[] | select(.name == $container) |
      (.volumeMounts // [])[] | select(.mountPath == $mount_path)] | length) == 1 and
    ([($spec.containers // [])[] | select(.name == $container) |
      (.volumeMounts // [])[] | select(.mountPath == $mount_path) | .name] ==
      [$claim_volume.name])
  ' >/dev/null 2>&1 <<<"$pods_json"
}

recovery_storage_helper_pod_is_exact() {
  local pod_json="$1"
  local pod_name="$2"
  local pod_uid="$3"
  local role="$4"
  local image="$5"
  local read_only="$6"
  local metadata_mode="${7:-legacy}"
  local wrapped_json
  [[ "$read_only" == true || "$read_only" == false ]] || return 2
  [[ "$metadata_mode" == legacy || "$metadata_mode" == freeze-fence ]] || return 2
  wrapped_json="$(jq -ce '{items:[.]}' <<<"$pod_json")" || return 1
  recovery_pod_pvc_mount_is_exact \
    "$wrapped_json" "$pod_name" helper ret-pvc /storage || return 1
  jq -e \
    --arg pod "$pod_name" --arg uid "$pod_uid" --arg namespace "$NAMESPACE" \
    --arg role "$role" --arg image "$image" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg operation_token "$RECOVERY_OPERATION_TOKEN" \
    --arg metadata_mode "$metadata_mode" \
    --argjson read_only "$read_only" '
    .apiVersion == "v1" and .kind == "Pod" and
    .metadata.name == $pod and .metadata.uid == $uid and
    .metadata.namespace == $namespace and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    ((.metadata.deletionTimestamp // null) == null) and
    ((.metadata.ownerReferences // []) == []) and
    ((.metadata.finalizers // []) == []) and
    (.metadata.labels // {}) == {
      "yenhubs.org/recovery-owner":$role,
      "yenhubs.org/operation-id":$operation_id
    } and
    (.metadata.annotations // {}) ==
      (if $metadata_mode == "freeze-fence" then {
        "yenhubs.org/operation-lock-uid":$lock_uid,
        "yenhubs.org/operation-id":$operation_id
      } else {
        "yenhubs.org/operation-lock-uid":$lock_uid,
        "yenhubs.org/operation-token":$operation_token
      } end) and
    .spec.automountServiceAccountToken == false and
    .spec.enableServiceLinks == false and .spec.restartPolicy == "Never" and
    .spec.terminationGracePeriodSeconds == 1 and
    .spec.activeDeadlineSeconds == 3600 and
    (.spec.hostNetwork // false) == false and (.spec.hostPID // false) == false and
    (.spec.hostIPC // false) == false and (.spec.shareProcessNamespace // false) == false and
    ((.spec.initContainers // []) | length) == 0 and
    ((.spec.ephemeralContainers // []) | length) == 0 and
    ([.spec.volumes[].name] == ["storage"]) and
    ((.spec.volumes[0].persistentVolumeClaim |
      keys - ["claimName", "readOnly"]) | length) == 0 and
    (.spec.volumes[0].persistentVolumeClaim | has("claimName")) and
    .spec.volumes[0].persistentVolumeClaim.claimName == "ret-pvc" and
    (if (.spec.volumes[0].persistentVolumeClaim | has("readOnly"))
     then .spec.volumes[0].persistentVolumeClaim.readOnly == $read_only
     else $read_only == false end) and
    ([.spec.containers[].name] == ["helper"]) and
    .spec.containers[0].image == $image and
    .spec.containers[0].command == ["sh", "-c", "sleep 3600"] and
    ((.spec.containers[0].args // []) | length) == 0 and
    ((.spec.containers[0].env // []) | length) == 0 and
    ((.spec.containers[0].envFrom // []) | length) == 0 and
    ((.spec.containers[0].ports // []) | length) == 0 and
    ((.spec.containers[0].volumeDevices // []) | length) == 0 and
    ((.spec.containers[0].volumeMounts // []) | length) == 1 and
    .spec.containers[0].volumeMounts[0].name == "storage" and
    .spec.containers[0].volumeMounts[0].mountPath == "/storage" and
    (if (.spec.containers[0].volumeMounts[0] | has("readOnly"))
     then .spec.containers[0].volumeMounts[0].readOnly == $read_only
     else $read_only == false end) and
    ((.spec.containers[0].lifecycle // {}) | length) == 0 and
    (.spec.containers[0].stdin // false) == false and
    (.spec.containers[0].stdinOnce // false) == false and
    (.spec.containers[0].tty // false) == false and
    (.spec.securityContext | keys | sort) ==
      ["fsGroup", "fsGroupChangePolicy", "runAsGroup", "runAsNonRoot", "runAsUser", "seccompProfile"] and
    .spec.securityContext.runAsNonRoot == true and
    .spec.securityContext.runAsUser == 1000 and .spec.securityContext.runAsGroup == 1000 and
    .spec.securityContext.fsGroup == 1000 and
    .spec.securityContext.fsGroupChangePolicy == "OnRootMismatch" and
    .spec.securityContext.seccompProfile == {type:"RuntimeDefault"} and
    ((.spec.containers[0].securityContext | keys) - [
      "allowPrivilegeEscalation", "capabilities", "privileged", "procMount",
      "readOnlyRootFilesystem", "runAsGroup", "runAsNonRoot", "runAsUser",
      "seccompProfile"
    ] | length) == 0 and
    (.spec.containers[0].securityContext.privileged // false) == false and
    .spec.containers[0].securityContext.allowPrivilegeEscalation == false and
    .spec.containers[0].securityContext.readOnlyRootFilesystem == true and
    (if (.spec.containers[0].securityContext | has("runAsNonRoot"))
     then .spec.containers[0].securityContext.runAsNonRoot == true else true end) and
    (if (.spec.containers[0].securityContext | has("runAsUser"))
     then .spec.containers[0].securityContext.runAsUser == 1000 else true end) and
    (if (.spec.containers[0].securityContext | has("runAsGroup"))
     then .spec.containers[0].securityContext.runAsGroup == 1000 else true end) and
    (if (.spec.containers[0].securityContext | has("seccompProfile"))
     then .spec.containers[0].securityContext.seccompProfile == {type:"RuntimeDefault"}
     else true end) and
    ((.spec.containers[0].securityContext.capabilities | keys) - ["add", "drop"] | length) == 0 and
    ((.spec.containers[0].securityContext.capabilities.drop // []) | sort) == ["ALL"] and
    ((.spec.containers[0].securityContext.capabilities.add // []) | length) == 0 and
    ((.spec.containers[0].securityContext.procMount // "Default") == "Default")
  ' >/dev/null 2>&1 <<<"$pod_json"
}

recovery_storage_helper_network_policy_is_exact() {
  local policy_json="$1"
  local policy_name="$2"
  local policy_uid="$3"
  local role="$4"
  jq -e \
    --arg name "$policy_name" --arg uid "$policy_uid" --arg namespace "$NAMESPACE" \
    --arg role "$role" --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg operation_token "$RECOVERY_OPERATION_TOKEN" '
    .apiVersion == "networking.k8s.io/v1" and .kind == "NetworkPolicy" and
    .metadata.name == $name and .metadata.uid == $uid and
    .metadata.namespace == $namespace and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    ((.metadata.deletionTimestamp // null) == null) and
    ((.metadata.ownerReferences // []) == []) and
    ((.metadata.finalizers // []) == []) and
    (.metadata.labels // {}) == {
      "yenhubs.org/recovery-owner":$role,
      "yenhubs.org/operation-id":$operation_id
    } and
    (.metadata.annotations // {}) == {
      "yenhubs.org/operation-lock-uid":$lock_uid,
      "yenhubs.org/operation-token":$operation_token
    } and
    (((.spec | keys | sort) == ["podSelector", "policyTypes"]) or
     ((.spec | keys | sort) == ["egress", "ingress", "podSelector", "policyTypes"] and
      .spec.ingress == [] and .spec.egress == [])) and
    .spec.podSelector == {matchLabels:{"yenhubs.org/operation-id":$operation_id}} and
    (.spec.policyTypes | sort) == ["Egress", "Ingress"] and
    ((.spec | has("ingress")) == (.spec | has("egress")))
  ' >/dev/null 2>&1 <<<"$policy_json"
}

recovery_confirmation_value() {
  local resource="$1"
  local resource_uid="${2:-}"
  if [[ -z "${RECOVERY_CHECKPOINT_STAMP:-}" ||
        -z "${RECOVERY_DUMP_SHA256:-}" || -z "${RECOVERY_STORAGE_SHA256:-}" ]]; then
    return 2
  fi
  printf '%s:%s:%s:%s:%s:%s:%s' \
    "$resource" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" \
    "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" "$RECOVERY_STORAGE_SHA256"
  if [[ -n "$resource_uid" ]]; then
    printf ':%s' "$resource_uid"
  fi
  if [[ -n "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256:-}" ]]; then
    [[ "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" =~ ^[a-f0-9]{64}$ &&
       ( "$RECOVERY_RUNNER_RUNTIME_GENERATION" == legacy-absent ||
         "$RECOVERY_RUNNER_RUNTIME_GENERATION" == durable-v2 ) ]] || return 2
    printf ':%s:%s' "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" \
      "$RECOVERY_RUNNER_RUNTIME_GENERATION"
  fi
}

recovery_require_confirmation() {
  local variable_name="$1"
  local resource="$2"
  local resource_uid="${3:-}"
  local expected_value actual_value

  expected_value="$(recovery_confirmation_value "$resource" "$resource_uid")" || {
    printf 'Checkpoint identity was not materialized before confirmation.\n' >&2
    return 1
  }
  actual_value="${!variable_name:-}"
  if [[ "$actual_value" != "$expected_value" ]]; then
    printf 'Refusing destructive restore. Set %s=%q for this exact target.\n' \
      "$variable_name" "$expected_value" >&2
    return 1
  fi
}

recovery_restore_rebind_confirmation_value() {
  [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind &&
     "${RECOVERY_CHECKPOINT_METADATA_SCHEMA:-}" == freeze-bundle-v1 &&
     "${RECOVERY_FREEZE_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_FREEZE_MANIFEST_SHA256:-}" =~ ^[a-f0-9]{64}$ &&
     -n "${RECOVERY_FREEZE_SOURCE_CLUSTER_UID:-}" &&
     -n "${RECOVERY_CHECKPOINT_NAMESPACE_UID:-}" &&
     -n "${RECOVERY_CHECKPOINT_PVC_UID:-}" &&
     -n "${RECOVERY_TARGET_CLUSTER_UID:-}" &&
     -n "${RECOVERY_NAMESPACE_UID:-}" && -n "${RECOVERY_PVC_UID:-}" &&
     "${RECOVERY_COLD_REBIND_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_DEPLOYMENT_INVENTORY_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  printf 'cold-rebind:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s' \
    "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_FREEZE_ID" \
    "$RECOVERY_FREEZE_MANIFEST_SHA256" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" \
    "$RECOVERY_FREEZE_SOURCE_CLUSTER_UID" \
    "$RECOVERY_CHECKPOINT_NAMESPACE_UID" "$RECOVERY_CHECKPOINT_PVC_UID" \
    "$RECOVERY_TARGET_CLUSTER_UID" "$RECOVERY_NAMESPACE_UID" \
    "$RECOVERY_PVC_UID" "$RECOVERY_COLD_REBIND_OPERATION_ID" \
    "$RECOVERY_FREEZE_CLIENT_INSTANCE_ID"
}

recovery_require_in_place_restore_target_mode() {
  local mode="${RESTORE_TARGET_MODE:-in-place}"
  case "$mode" in
    in-place | cold-rebind)
      return 0
      ;;
    *)
      printf 'RESTORE_TARGET_MODE must be exactly in-place or cold-rebind.\n' >&2
      return 2
      ;;
  esac
}

recovery_current_cluster_anchor_uid() {
  local cluster_namespace_json
  cluster_namespace_json="$(
    recovery_kubectl get namespace kube-system -o json
  )" || return 1
  jq -er '
    select(.apiVersion == "v1" and .kind == "Namespace") |
    select(.metadata.name == "kube-system" and
      (.metadata.deletionTimestamp // null) == null) |
    .metadata.uid | select(type == "string" and length > 0)
  ' <<<"$cluster_namespace_json"
}

recovery_require_restore_target_binding() {
  local inventory_namespace_uid mode target_cluster_uid
  recovery_require_in_place_restore_target_mode || return
  mode="${RESTORE_TARGET_MODE:-in-place}"
  inventory_namespace_uid="$(jq -er \
    '.namespace_uid | select(type == "string" and length > 0)' \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY")" || return 1
  [[ "$inventory_namespace_uid" == "$RECOVERY_CHECKPOINT_NAMESPACE_UID" ]] || {
    printf 'Checkpoint metadata and deployment inventory disagree on the origin namespace UID.\n' >&2
    return 1
  }
  case "$mode" in
    in-place)
      [[ "$RECOVERY_NAMESPACE_UID" == "$RECOVERY_CHECKPOINT_NAMESPACE_UID" &&
         "$RECOVERY_PVC_UID" == "$RECOVERY_CHECKPOINT_PVC_UID" ]] || {
        printf 'In-place restore requires the exact checkpoint namespace and PVC UIDs.\n' >&2
        return 1
      }
      ;;
    cold-rebind)
      [[ "$RECOVERY_CHECKPOINT_METADATA_SCHEMA" == freeze-bundle-v1 &&
         "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent &&
         "$RECOVERY_NAMESPACE_UID" != "$RECOVERY_CHECKPOINT_NAMESPACE_UID" &&
         "$RECOVERY_PVC_UID" != "$RECOVERY_CHECKPOINT_PVC_UID" ]] || {
        printf 'Cold rebind requires a freeze-bundle-v1 and new Namespace/PVC UIDs.\n' >&2
        return 1
      }
      target_cluster_uid="$(recovery_current_cluster_anchor_uid)" || {
        printf 'Cold rebind could not capture the target cluster identity.\n' >&2
        return 1
      }
      [[ -n "$RECOVERY_FREEZE_SOURCE_CLUSTER_UID" &&
         "$target_cluster_uid" != "$RECOVERY_FREEZE_SOURCE_CLUSTER_UID" ]] || {
        printf 'Cold rebind requires a target cluster UID different from the source.\n' >&2
        return 1
      }
      RECOVERY_TARGET_CLUSTER_UID="$target_cluster_uid"
      ;;
  esac
}

recovery_require_cold_rebind_target_bootstrap() {
  local values_path="$1" deployments_json pvcs_json workload_json
  local resource
  [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind ]] || return 2
  recovery_require_restore_target_binding || return 1
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$values_path" || return 1
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" || return 1
  deployments_json="$(
    recovery_kubectl_get_namespaced_list deployments "$NAMESPACE"
  )" || return 1
  jq -e '
    .apiVersion == "apps/v1" and .kind == "DeploymentList" and
    (.items | type) == "array" and
    ([.items[].metadata.name] | sort) == [
      "bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
      "pgbouncer", "pgbouncer-t", "pgsql", "photomnemonic", "reticulum", "spoke"
    ] and
    ([.items[] | select(.metadata.name == "reticulum" or
      .metadata.name == "pgbouncer" or .metadata.name == "pgbouncer-t" or
      .metadata.name == "bot-orchestrator" or .metadata.name == "coturn") |
      select(.spec.replicas == 0 and (.status.replicas // 0) == 0 and
        (.status.readyReplicas // 0) == 0 and
        (.status.availableReplicas // 0) == 0)] | length) == 5 and
    ([.items[] | select(.metadata.name == "pgsql" and .spec.replicas == 1)] |
      length) == 1 and
    all(.items[];
      (.metadata.uid | type == "string" and length > 0) and
      (.metadata.resourceVersion | type == "string" and length > 0) and
      (.metadata.deletionTimestamp // null) == null)
  ' >/dev/null <<<"$deployments_json" || {
    printf 'Cold rebind target Deployments are not the exact bootstrap set.\n' >&2
    jq -r '
      "Cold rebind deployment diagnostic: api=" + (.apiVersion // "missing") +
      " kind=" + (.kind // "missing") +
      " names=" + ([.items[]?.metadata.name] | sort | join(",")) +
      " zero=" + ([.items[]? | select((.spec.replicas // -1) == 0)] |
        length | tostring) +
      " pgsql=" + ([.items[]? | select(.metadata.name == "pgsql") |
        (.spec.replicas // -1)] | join(","))
    ' <<<"$deployments_json" >&2 || :
    return 1
  }
  pvcs_json="$(
    recovery_kubectl_get_namespaced_list persistentvolumeclaims "$NAMESPACE"
  )" || return 1
  jq -e --arg namespace "$NAMESPACE" --arg ret_uid "$RECOVERY_PVC_UID" \
    --arg source_ret_uid "$RECOVERY_CHECKPOINT_PVC_UID" '
    .apiVersion == "v1" and .kind == "PersistentVolumeClaimList" and
    ([.items[].metadata.name] | sort) == ["pgsql-pvc", "ret-pvc"] and
    ([.items[] | select(.metadata.name == "ret-pvc" and
      .metadata.namespace == $namespace and .metadata.uid == $ret_uid and
      .metadata.uid != $source_ret_uid and
      (.metadata.deletionTimestamp // null) == null)] | length) == 1 and
    all(.items[]; (.metadata.uid | type == "string" and length > 0) and
      (.metadata.deletionTimestamp // null) == null)
  ' >/dev/null <<<"$pvcs_json" || {
    printf 'Cold rebind target PVC inventory is not the exact empty target pair.\n' >&2
    return 1
  }
  for resource in jobs cronjobs daemonsets statefulsets; do
    workload_json="$(
      recovery_kubectl_get_namespaced_list "$resource" "$NAMESPACE"
    )" || return 1
    jq -e '(.apiVersion | type) == "string" and
      (.kind | type) == "string" and (.kind | endswith("List")) and
      (.items | type) == "array" and (.items | length) == 0' \
      >/dev/null <<<"$workload_json" || {
      printf 'Cold rebind target contains an undeclared workload type: %s.\n' \
        "$resource" >&2
      return 1
    }
  done
  recovery_require_exact_pvc_consumers ret-pvc || return 1
  recovery_require_no_managed_bot_runner_pods || return 1
  [[ "$(recovery_runner_isolation_residual_state)" == absent ]] || {
    printf 'Cold rebind target contains runner control-plane residue.\n' >&2
    return 1
  }
}

recovery_pvc_consumer_names() {
  local claim_name="$1"
  local pods_json
  if ! pods_json="$(
    recovery_kubectl_get_namespaced_list pods "$NAMESPACE"
  )"; then
    return 1
  fi
  printf '%s' "$pods_json" | jq -r --arg claim "$claim_name" '
    [.items[]
      | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim))
      | .metadata.name]
    | sort
    | .[]
  '
}

recovery_require_exact_pvc_consumers() {
  local claim_name="$1"
  local allowed_name="${2:-}"
  local consumers
  if ! consumers="$(recovery_pvc_consumer_names "$claim_name")"; then
    printf 'Could not inspect pods consuming PVC %s.\n' "$claim_name" >&2
    return 1
  fi
  if [[ -z "$allowed_name" && -z "$consumers" ]]; then
    return 0
  fi
  if [[ -n "$allowed_name" && "$consumers" == "$allowed_name" ]]; then
    return 0
  fi
  printf 'Unexpected pods consume PVC %s; refusing storage mutation.\n' "$claim_name" >&2
  return 1
}

# Per-room bot runners are created directly by bot-orchestrator and therefore
# are not members of the fixed Deployment consumer inventory. Recovery windows
# conservatively fence the union of both workload markers. Requiring their
# intersection would let a drifted or malicious Pod evade the destructive gate
# simply by dropping one label.
recovery_bot_orchestrator_runner_mode() {
  local deployment_json
  if ! deployment_json="$(
    recovery_kubectl get deployment bot-orchestrator -n "$NAMESPACE" -o json
  )"; then
    return 1
  fi
  printf '%s' "$deployment_json" | jq -er --arg namespace "$NAMESPACE" '
    if .apiVersion != "apps/v1" or .kind != "Deployment" or
       .metadata.name != "bot-orchestrator" or .metadata.namespace != $namespace or
       (.spec.template.spec | type) != "object" or
       (.spec.template.spec.containers | type) != "array" or
       ([.spec.template.spec.containers[] | select(.name == "bot-orchestrator")] | length) != 1
    then error("invalid_bot_orchestrator_deployment")
    else
      (.spec.template.spec.containers[] | select(.name == "bot-orchestrator")) as $container |
      ([($container.env // [])[].name] |
        any(. == "BOT_RUNNER_IMAGE" or . == "POD_NAMESPACE" or
            . == "ORCHESTRATOR_POD_NAME" or . == "ORCHESTRATOR_POD_UID" or
            . == "RUNNER_NAMESPACE" or . == "RUNNER_POD_NAMESPACE" or
            . == "RUNNER_CONTROL_URL")) as $environment_binding |
      if .spec.template.spec.serviceAccountName == "bot-orchestrator" or
         .spec.template.spec.automountServiceAccountToken == true or
         $environment_binding
      then "kubernetes-pod" else "process-local" end
    end
  '
}

recovery_runner_checkpoint_helper_path() {
  local helper_root helper
  helper_root="$(cd "$RECOVERY_SAFETY_DIR/.." && pwd -P)" || return 1
  helper="$helper_root/runner-cutover-checkpoint-evidence.mjs"
  if [[ -n "${YENHUBS_RECOVERY_RUNNER_CHECKPOINT_HELPER:-}" ]]; then
    recovery_require_local_fixture_attestation || return 1
    helper="$YENHUBS_RECOVERY_RUNNER_CHECKPOINT_HELPER"
  fi
  recovery_require_regular_direct_file "$helper" || return 1
  printf '%s\n' "$helper"
}

recovery_canonical_private_tmp_root() {
  local candidate="${TMPDIR:-/tmp}" canonical private_root current_uid
  canonical="$(cd "$candidate" 2>/dev/null && pwd -P)" || return 1
  [[ "$canonical" == /* && -d "$canonical" && ! -L "$canonical" ]] || return 1
  recovery_path_has_symlink_component "$canonical" && return 1
  if recovery_capture_private_directory_token "$canonical" >/dev/null 2>&1; then
    printf '%s\n' "$canonical"
    return 0
  fi

  current_uid="$(id -u 2>/dev/null)" || return 1
  [[ "$current_uid" =~ ^[0-9]+$ ]] || return 1
  private_root="$canonical/.yenhubs-recovery-private-$current_uid"
  # A shared system temporary directory is acceptable only as the parent of a
  # private per-user root. Never chmod or replace an existing pathname: mkdir
  # may lose a benign concurrent creation race, after which the capability
  # check below must still prove exact owner, mode, type and canonical binding.
  if ! (umask 077 && mkdir -- "$private_root") 2>/dev/null; then
    :
  fi
  recovery_capture_private_directory_token "$private_root" >/dev/null || return 1
  printf '%s\n' "$private_root"
}

recovery_validate_runner_cutover_evidence_offline() {
  local evidence_path="$1" inventory_path="$2" helper
  helper="$(recovery_runner_checkpoint_helper_path)" || return 1
  recovery_require_regular_direct_file "$evidence_path" || return 1
  recovery_require_regular_direct_file "$inventory_path" || return 1
  command node "$helper" validate \
    --evidence "$evidence_path" --inventory "$inventory_path"
}

recovery_capture_runner_cutover_evidence() {
  local values_path="$1" evidence_path="$2" inventory_path="$3"
  local recovery_operation_fence_state="$4" manifest_path="${5:-}" helper
  local -a arguments=(capture --values "$values_path" --output "$evidence_path"
    --inventory "$inventory_path" --recovery-operation-fence-state
    "$recovery_operation_fence_state")
  [[ "$recovery_operation_fence_state" == dormant ||
     "$recovery_operation_fence_state" == active ]] || return 2
  helper="$(recovery_runner_checkpoint_helper_path)" || {
    printf 'The AUD078 checkpoint-evidence helper is unavailable or unsafe.\n' >&2
    return 1
  }
  if [[ -n "$manifest_path" ]]; then
    recovery_require_regular_direct_file "$manifest_path" || return 1
    arguments+=(--manifest "$manifest_path")
  fi
  EXPECTED_KUBE_CONTEXT="$EXPECTED_KUBE_CONTEXT" NAMESPACE="$NAMESPACE" \
    EXPECTED_NAMESPACE_UID="$RECOVERY_NAMESPACE_UID" \
    RECOVERY_OPERATION_ID="$RECOVERY_OPERATION_ID" \
    command node "$helper" "${arguments[@]}" || return 1
  recovery_runner_cutover_evidence_is_acceptable "$evidence_path"
}

recovery_verify_runner_cutover_evidence_live() {
  local values_path="$1" evidence_path="$2" inventory_path="$3"
  local recovery_operation_fence_state="$4" manifest_path="${5:-}"
  local live_mode="${6:-checkpoint}"
  local helper checkpoint_operation_id
  local -a arguments=(verify --values "$values_path" --evidence "$evidence_path"
    --inventory "$inventory_path" --live-mode "$live_mode"
    --recovery-operation-fence-state "$recovery_operation_fence_state")
  [[ "$recovery_operation_fence_state" == dormant ||
     "$recovery_operation_fence_state" == active ]] || return 2
  [[ "$live_mode" == checkpoint || "$live_mode" == active-source ||
     "$live_mode" == quiesced-source || "$live_mode" == quiesced-target ||
     "$live_mode" == active-target ||
     "$live_mode" == quiesced-active-target ]] || return 2
  helper="$(recovery_runner_checkpoint_helper_path)" || return 1
  checkpoint_operation_id="$(jq -er '
    .checkpoint_operation_id | select(type == "string" and test("^[a-f0-9]{32}$"))
  ' "$evidence_path")" || return 1
  if [[ "$live_mode" != checkpoint ]]; then
    [[ "${RECOVERY_CHECKPOINT_OPERATION_ID:-}" == "$checkpoint_operation_id" ]] || return 1
    arguments+=(--checkpoint-operation-id "$RECOVERY_CHECKPOINT_OPERATION_ID")
  fi
  case "$live_mode" in
    checkpoint)
      if [[ -n "$manifest_path" ]]; then
        recovery_require_regular_direct_file "$manifest_path" || return 1
        arguments+=(--manifest "$manifest_path")
      fi
      ;;
    active-source|quiesced-source)
      [[ -z "$manifest_path" ]] || return 2
      ;;
    quiesced-target|active-target|quiesced-active-target)
      recovery_require_regular_direct_file "$manifest_path" || return 1
      arguments+=(--manifest "$manifest_path")
      ;;
  esac
  if [[ "$live_mode" == checkpoint ]]; then
    EXPECTED_KUBE_CONTEXT="$EXPECTED_KUBE_CONTEXT" NAMESPACE="$NAMESPACE" \
      EXPECTED_NAMESPACE_UID="$RECOVERY_NAMESPACE_UID" \
      RECOVERY_OPERATION_ID="$checkpoint_operation_id" \
      command node "$helper" "${arguments[@]}"
  else
    EXPECTED_KUBE_CONTEXT="$EXPECTED_KUBE_CONTEXT" NAMESPACE="$NAMESPACE" \
      EXPECTED_NAMESPACE_UID="$RECOVERY_NAMESPACE_UID" \
      command node "$helper" "${arguments[@]}"
  fi
}

recovery_classify_runner_pod_list() {
  local pods_path="$1" output_path="$2" helper
  helper="$(recovery_runner_checkpoint_helper_path)" || return 1
  recovery_require_regular_direct_file "$pods_path" || return 1
  command node "$helper" classify-pods --pods "$pods_path" --output "$output_path" || return 1
  recovery_require_regular_direct_file "$output_path" || return 1
  jq -e '
    type == "object" and
    (keys | sort) == ["fences", "intents", "list_resource_version", "runners", "schema_version"] and
    .schema_version == 1 and
    (.list_resource_version | type == "string" and length > 0) and
    all(.runners, .intents, .fences; type == "array")
  ' "$output_path" >/dev/null
}

recovery_runner_next_action() {
  local pods_path="$1" output_path="$2" helper
  helper="$(recovery_runner_checkpoint_helper_path)" || return 1
  recovery_require_regular_direct_file "$pods_path" || return 1
  command node "$helper" next-action --pods "$pods_path" --output "$output_path" || return 1
  recovery_require_regular_direct_file "$output_path" || return 1
  jq -e '
    type == "object" and .schema_version == 1 and
    (.action == "noop" or .action == "delete-pod" or .action == "create-fence")
  ' "$output_path" >/dev/null
}

recovery_capture_runner_namespace_pod_list() {
  local output_path="$1"
  [[ "$output_path" == /* && -f "$output_path" && ! -L "$output_path" ]] || return 2
  recovery_kubectl_get_namespaced_list pods hcce-bot-runners \
    >"$output_path" || return 1
  chmod 600 "$output_path"
  recovery_require_regular_direct_file "$output_path"
}

recovery_delete_runner_pod_exact_once() {
  local name="$1" uid="$2" resource_version="$3" delete_options mutation_status=0
  [[ "$name" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ && -n "$uid" &&
     "$resource_version" =~ ^[A-Za-z0-9._:-]+$ ]] || return 2
  delete_options="$(jq -cn --arg uid "$uid" --arg resource_version "$resource_version" '
    {
      apiVersion:"v1",kind:"DeleteOptions",gracePeriodSeconds:0,
      propagationPolicy:"Background",
      preconditions:{uid:$uid,resourceVersion:$resource_version}
    }
  ')" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  if printf '%s\n' "$delete_options" |
     recovery_kubectl_mutate delete \
       --raw="/api/v1/namespaces/hcce-bot-runners/pods/$name" -f - >/dev/null; then
    mutation_status=0
  else
    mutation_status=$?
  fi
  recovery_require_operation_lock || return 1
  recovery_require_operation_serialization || return 1
  [[ "$mutation_status" == 0 ]]
}

recovery_create_runner_fence_once() {
  local action_path="$1" document_path tmp_root mutation_status=0
  recovery_require_regular_direct_file "$action_path" || return 1
  tmp_root="$(recovery_canonical_private_tmp_root)" || return 1
  document_path="$(mktemp "$tmp_root/yenhubs-runner-fence.XXXXXX")" || return 1
  chmod 600 "$document_path"
  if ! jq -e '
      select(.schema_version == 1 and .action == "create-fence" and
        (.identity | type == "object") and
        (.document | type == "object" and .apiVersion == "v1" and
         .kind == "Pod" and .metadata.namespace == "hcce-bot-runners")) |
      .document
    ' "$action_path" >"$document_path"; then
    rm -f -- "$document_path"
    return 1
  fi
  recovery_require_operation_serialization || {
    rm -f -- "$document_path"
    return 1
  }
  recovery_require_operation_lock || {
    rm -f -- "$document_path"
    return 1
  }
  # A timeout or 409 is ambiguous, not proof of failure.  The next complete
  # LIST resolves whether the exact permanent fence owns the target name.
  if recovery_kubectl_mutate create -f "$document_path" >/dev/null; then
    mutation_status=0
  else
    mutation_status=$?
  fi
  rm -f -- "$document_path"
  recovery_require_operation_lock || return 1
  recovery_require_operation_serialization || return 1
  [[ "$mutation_status" == 0 ]]
}

recovery_runner_action_advanced_after_ambiguous_failure() {
  local previous_action="$1" pods_path action_path current_action tmp_root
  tmp_root="$(recovery_canonical_private_tmp_root)" || return 1
  pods_path="$(mktemp "$tmp_root/yenhubs-runner-pods.XXXXXX")" || return 1
  action_path="$(mktemp "$tmp_root/yenhubs-runner-action.XXXXXX")" || {
    rm -f -- "$pods_path"
    return 1
  }
  chmod 600 "$pods_path"
  rm -f -- "$action_path"
  if ! recovery_capture_runner_namespace_pod_list "$pods_path" ||
     ! recovery_runner_next_action "$pods_path" "$action_path"; then
    rm -f -- "$pods_path" "$action_path"
    return 1
  fi
  current_action="$(<"$action_path")"
  rm -f -- "$pods_path" "$action_path"
  [[ "$current_action" != "$previous_action" ]]
}

recovery_reconcile_durable_runner_namespace() {
  local attempt pods_path action_path action _reason name uid resource_version expected_action tmp_root
  tmp_root="$(recovery_canonical_private_tmp_root)" || return 1
  for attempt in {1..240}; do
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    pods_path="$(mktemp "$tmp_root/yenhubs-runner-pods.XXXXXX")" || return 1
    action_path="$(mktemp "$tmp_root/yenhubs-runner-action.XXXXXX")" || {
      rm -f -- "$pods_path"
      return 1
    }
    chmod 600 "$pods_path"
    rm -f -- "$action_path"
    if ! recovery_capture_runner_namespace_pod_list "$pods_path" ||
       ! recovery_runner_next_action "$pods_path" "$action_path"; then
      rm -f -- "$pods_path" "$action_path"
      return 1
    fi
    action="$(jq -er '.action' "$action_path")" || {
      rm -f -- "$pods_path" "$action_path"
      return 1
    }
    expected_action="$(<"$action_path")"
    case "$action" in
      noop)
        rm -f -- "$pods_path" "$action_path"
        return 0
        ;;
      delete-pod)
        IFS=$'\t' read -r _reason name uid resource_version < <(jq -er '
          select((keys | sort) == ["action", "pod", "reason", "schema_version"]) |
          select(.schema_version == 1 and .action == "delete-pod") |
          select(.reason == "unarmed-intent" or
                 .reason == "armed-intent-after-fence" or
                 .reason == "runner-before-fence" or
                 .reason == "orphan-runner") |
          select((.pod | keys | sort) == ["name", "resource_version", "uid"]) |
          [.reason,.pod.name,.pod.uid,.pod.resource_version] | @tsv
        ' "$action_path") || {
          rm -f -- "$pods_path" "$action_path"
          return 1
        }
        rm -f -- "$pods_path" "$action_path"
        # A conflict means the causal state advanced. Relist rather than
        # inferring success; any malformed replacement fails in next-action.
        if ! recovery_delete_runner_pod_exact_once \
          "$name" "$uid" "$resource_version"; then
          recovery_runner_action_advanced_after_ambiguous_failure \
            "$expected_action" || return 1
        fi
        ;;
      create-fence)
        rm -f -- "$pods_path"
        if ! recovery_create_runner_fence_once "$action_path"; then
          rm -f -- "$action_path"
          recovery_runner_action_advanced_after_ambiguous_failure \
            "$expected_action" || return 1
        else
          rm -f -- "$action_path"
        fi
        ;;
      *)
        rm -f -- "$pods_path" "$action_path"
        return 1
        ;;
    esac
    recovery_require_operation_lock || return 1
    recovery_require_operation_serialization || return 1
  done
  printf 'Durable runner reconciliation did not converge to permanent fences.\n' >&2
  return 1
}

recovery_capture_durable_quiescence_into() {
  local __yenhubs_output_variable="$1"
  local __yenhubs_pods_path __yenhubs_classification_path
  local __yenhubs_tmp_root __yenhubs_inventory
  [[ "$__yenhubs_output_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$__yenhubs_output_variable" != __yenhubs_* ]] || return 2
  __yenhubs_tmp_root="$(recovery_canonical_private_tmp_root)" || return 1
  __yenhubs_pods_path="$(mktemp "$__yenhubs_tmp_root/yenhubs-runner-pods.XXXXXX")" || return 1
  __yenhubs_classification_path="$(mktemp "$__yenhubs_tmp_root/yenhubs-runner-classification.XXXXXX")" || {
    rm -f -- "$__yenhubs_pods_path"
    return 1
  }
  chmod 600 "$__yenhubs_pods_path"
  rm -f -- "$__yenhubs_classification_path"
  if ! recovery_capture_runner_namespace_pod_list "$__yenhubs_pods_path" ||
     ! recovery_classify_runner_pod_list \
       "$__yenhubs_pods_path" "$__yenhubs_classification_path" ||
     ! jq -e '.runners == [] and .intents == []' \
       "$__yenhubs_classification_path" >/dev/null; then
    rm -f -- "$__yenhubs_pods_path" "$__yenhubs_classification_path"
    return 1
  fi
  # resourceVersion is deliberately excluded from the causal window identity:
  # status-only Pod updates may advance it without replacing the fence. UID and
  # the complete durable room/process identity must remain byte-for-byte stable.
  __yenhubs_inventory="$(jq -ce '[.fences[] | {
    name,uid,room_key,process_generation,state
  }] | sort_by(.name)' "$__yenhubs_classification_path")" || {
    rm -f -- "$__yenhubs_pods_path" "$__yenhubs_classification_path"
    return 1
  }
  rm -f -- "$__yenhubs_pods_path" "$__yenhubs_classification_path"
  recovery_durable_fence_inventory_json_is_canonical \
    "$__yenhubs_inventory" || return 1
  printf -v "$__yenhubs_output_variable" '%s' "$__yenhubs_inventory"
}

recovery_capture_durable_quiescence() {
  local inventory
  recovery_capture_durable_quiescence_into inventory || return 1
  printf '%s\n' "$inventory"
}

recovery_durable_fence_inventory_json_is_canonical() {
  local inventory_json="$1" canonical
  canonical="$(jq -cer '
    select(type == "array" and length <= 10000) |
    select(all(.[];
      (keys | sort) == [
        "name", "process_generation", "room_key", "state", "uid"
      ] and
      (.name | type == "string" and
        test("^bot-runner-[a-f0-9]{16}-[a-f0-9]{8}$")) and
      (.uid | type == "string" and length > 0) and
      (.room_key | type == "string" and test("^[a-f0-9]{20}$")) and
      (.process_generation | type == "string" and
        test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")) and
      .state == "fenced")) |
    select(([.[].name] | unique | length) == length) |
    select(([.[].uid] | unique | length) == length) |
    sort_by(.name) | map({name,uid,room_key,process_generation,state})
  ' <<<"$inventory_json")" || return 1
  [[ "$inventory_json" == "$canonical" ]]
}

recovery_require_checkpoint_runner_quiescence_exact() {
  local generation="$1" durable_baseline_path="${2:-}"
  local expected_baseline_sha256="${3:-}"
  local durable_baseline current size digest_before digest_after
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  case "$generation" in
    legacy-absent)
      [[ -z "$durable_baseline_path" && -z "$expected_baseline_sha256" ]] ||
        return 1
      recovery_require_no_managed_bot_runner_pods &&
        recovery_require_no_legacy_parent_runner_pods
      ;;
    durable-v2)
      [[ "$expected_baseline_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
      recovery_private_values_file_is_acceptable "$durable_baseline_path" ||
        return 1
      size="$(recovery_file_size_bytes "$durable_baseline_path")" || return 1
      [[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 && "$size" -le 1048576 ]] ||
        return 1
      digest_before="$(recovery_sha256_digest "$durable_baseline_path")" ||
        return 1
      [[ "$digest_before" == "$expected_baseline_sha256" ]] || return 1
      durable_baseline="$(<"$durable_baseline_path")"
      digest_after="$(recovery_sha256_digest "$durable_baseline_path")" ||
        return 1
      [[ "$digest_after" == "$expected_baseline_sha256" ]] || return 1
      recovery_durable_fence_inventory_json_is_canonical \
        "$durable_baseline" || return 1
      recovery_capture_durable_quiescence_into current || return 1
      recovery_durable_fence_inventory_json_is_canonical "$current" || return 1
      recovery_require_no_legacy_parent_runner_pods || return 1
      [[ "$current" == "$durable_baseline" ]] || {
        printf 'Permanent runner-fence inventory changed during checkpoint backup.\n' >&2
        return 1
      }
      ;;
    *) return 2 ;;
  esac
}

recovery_require_durable_runner_quiescence_stable() {
  local stable_seconds started baseline current
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  recovery_reconcile_durable_runner_namespace || return 1
  recovery_capture_durable_quiescence_into baseline || return 1
  started="$SECONDS"
  while :; do
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    recovery_capture_durable_quiescence_into current || return 1
    recovery_require_no_legacy_parent_runner_pods || return 1
    [[ "$current" == "$baseline" ]] || {
      printf 'Permanent runner-fence inventory changed during quiescence.\n' >&2
      return 1
    }
    ((SECONDS - started >= stable_seconds)) && return 0
    sleep 1
  done
}

recovery_require_no_legacy_parent_runner_pods() {
  local pods_json
  pods_json="$(
    recovery_kubectl_get_namespaced_list pods "$NAMESPACE"
  )" || return 1
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "v1" and .kind == "PodList" and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (.items | type == "array") and
    all(.items[];
      .metadata.namespace == $namespace and
      ((.metadata.labels // {}) | type == "object") and
      (.spec | type == "object")) and
    ([.items[] | select(
      (.metadata.labels.app // "") == "bot-runner" or
      (.metadata.labels.component // "") == "bot-runner" or
      (.metadata.labels["yenhubs.org/managed-by"] // "") == "bot-orchestrator" or
      (.spec.serviceAccountName // "") == "bot-orchestrator"
    )] | length) == 0
  ' >/dev/null <<<"$pods_json"
}

recovery_runner_namespaces() {
  local runner_namespace="hcce-bot-runners" namespace_json runner_mode
  [[ "${RUNNER_POD_NAMESPACE:-$runner_namespace}" == "$runner_namespace" ]] || return 1
  if ! namespace_json="$(
    recovery_kubectl get namespace "$runner_namespace" --ignore-not-found -o json
  )"; then
    return 1
  fi
  printf '%s\n' "$NAMESPACE"
  [[ "$NAMESPACE" == "$runner_namespace" ]] && return 0
  if [[ -n "$namespace_json" ]]; then
    printf '%s' "$namespace_json" | jq -e --arg namespace "$runner_namespace" '
      .apiVersion == "v1" and .kind == "Namespace" and
      .metadata.name == $namespace and
      (.metadata.uid | type == "string" and length > 0)
    ' >/dev/null || return 1
    printf '%s\n' "$runner_namespace"
    return 0
  fi
  if ! runner_mode="$(recovery_bot_orchestrator_runner_mode)"; then
    return 1
  fi
  [[ "$runner_mode" == "process-local" ]]
}

recovery_managed_bot_runner_pod_names() {
  recovery_managed_bot_runner_pod_identities | cut -f1,2
}

recovery_managed_bot_runner_pod_identities() {
  local pods_json runner_namespace runner_namespaces
  if ! runner_namespaces="$(recovery_runner_namespaces)"; then
    return 1
  fi
  while IFS= read -r runner_namespace; do
    [[ -n "$runner_namespace" ]] || return 1
    if ! pods_json="$(
      recovery_kubectl_get_namespaced_list pods "$runner_namespace"
    )"; then
      return 1
    fi
    printf '%s' "$pods_json" | jq -r --arg namespace "$runner_namespace" \
      --arg parent_namespace "$NAMESPACE" '
      if .apiVersion != "v1" or .kind != "PodList" or
         (.metadata.resourceVersion | type) != "string" or .metadata.resourceVersion == "" or
         (.items | type) != "array" or
         any(.items[];
           (.metadata | type) != "object" or
           .metadata.namespace != $namespace or
           (.metadata.name | type) != "string" or .metadata.name == "" or
           (.metadata.uid | type) != "string" or .metadata.uid == "" or
           ((.metadata.labels // {}) | type) != "object" or
           (.spec | type) != "object" or
           ((.spec.serviceAccountName // "") | type) != "string")
      then error("invalid_pod_inventory")
      else
        [.items[]
          | select(
              $namespace != $parent_namespace or
              (.metadata.labels.app // "") == "bot-runner" or
              (.metadata.labels.component // "") == "bot-runner" or
              (.metadata.labels["yenhubs.org/managed-by"] // "") == "bot-orchestrator" or
              ($namespace == $parent_namespace and
                (.spec.serviceAccountName // "") == "bot-orchestrator")
            )
          | [$namespace, "pod/" + .metadata.name, .metadata.uid]
          | @tsv]
        | unique
        | .[]
      end
    ' || return 1
  done <<<"$runner_namespaces"
}

recovery_delete_all_managed_bot_runner_pods_exact() {
  local identities pod_namespace pod_resource pod_name pod_uid delete_status=0
  recovery_require_operation_serialization || return 1
  identities="$(recovery_managed_bot_runner_pod_identities)" || return 1
  [[ -n "$identities" ]] || return 0
  while IFS=$'\t' read -r pod_namespace pod_resource pod_uid; do
    pod_name="${pod_resource#pod/}"
    if [[ "$pod_resource" != "pod/$pod_name" || -z "$pod_name" || -z "$pod_uid" ]]; then
      delete_status=1
      continue
    fi
    if ! recovery_delete_namespaced_with_uid_in_namespace \
      "$pod_namespace" pod "$pod_name" "$pod_uid" 60; then
      delete_status=1
    fi
  done <<<"$identities"
  [[ "$delete_status" == 0 ]]
}

recovery_require_no_managed_bot_runner_pods() {
  local remaining
  if ! remaining="$(recovery_managed_bot_runner_pod_names)"; then
    printf 'Could not inspect managed bot-runner Pods; refusing further mutation.\n' >&2
    return 1
  fi
  if [[ -n "$remaining" ]]; then
    printf 'Managed bot-runner Pods remain during a recovery quiescence window; refusing further mutation.\n' >&2
    return 1
  fi
}

# Every API request is capped at 45 seconds, below the 120-second operation
# Lease. Long readiness/deletion waits are composed from <=40-second requests
# and revalidate Lease ownership between attempts.
recovery_kubectl_wait_bounded() {
  local total_seconds="$1"
  shift
  local remaining="$total_seconds" slice
  local retry_delay="${RECOVERY_WAIT_RETRY_DELAY_SECONDS:-1}"
  [[ "$total_seconds" =~ ^[1-9][0-9]*$ && "$retry_delay" =~ ^[01]$ &&
     "$#" -gt 0 ]] || return 2
  while ((remaining > 0)); do
    slice=40
    ((remaining >= slice)) || slice="$remaining"
    if recovery_kubectl "$@" --timeout="${slice}s" >/dev/null; then
      return 0
    fi
    if [[ "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 1 ]]; then
      recovery_require_operation_serialization || return 1
    fi
    remaining=$((remaining - slice))
    ((retry_delay == 0)) || sleep "$retry_delay"
  done
  return 1
}

recovery_wait_for_deployment_rollout() {
  local deployment_name="$1" timeout_seconds="${2:-300}"
  [[ "$deployment_name" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 2
  recovery_kubectl_wait_bounded "$timeout_seconds" \
    rollout status "deployment/$deployment_name" -n "$NAMESPACE"
}

recovery_wait_for_pod_ready() {
  local pod_name="$1" timeout_seconds="${2:-180}"
  [[ "$pod_name" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 2
  recovery_kubectl_wait_bounded "$timeout_seconds" \
    wait --for=condition=Ready "pod/$pod_name" -n "$NAMESPACE"
}

recovery_wait_for_no_managed_bot_runner_pods() {
  local timeout="${1:-180s}"
  local remaining pod_namespace pod_name
  if [[ ! "$timeout" =~ ^[1-9][0-9]*s$ ]]; then
    printf 'Invalid managed bot-runner wait timeout.\n' >&2
    return 2
  fi
  if ! remaining="$(recovery_managed_bot_runner_pod_names)"; then
    printf 'Could not inspect managed bot-runner Pods before waiting; refusing further mutation.\n' >&2
    return 1
  fi
  [[ -n "$remaining" ]] || return 0
  while IFS=$'\t' read -r pod_namespace pod_name; do
    if [[ ! "$pod_namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
      printf 'Managed bot-runner Pod inventory contains an invalid namespace.\n' >&2
      return 1
    fi
    if [[ ! "$pod_name" =~ ^pod/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]]; then
      printf 'Managed bot-runner Pod inventory contains an invalid name.\n' >&2
      return 1
    fi
    if ! recovery_kubectl_wait_bounded "${timeout%s}" \
      wait --for=delete "$pod_name" -n "$pod_namespace"; then
      printf 'Timed out waiting for managed bot-runner pods to terminate.\n' >&2
      return 1
    fi
  done <<<"$remaining"
  if ! recovery_require_no_managed_bot_runner_pods; then
    printf 'Pods still remain for managed bot-runner after the delete wait.\n' >&2
    return 1
  fi
}

# A destructive window must not rely on polling: a runner can be ADDED and
# DELETED between two LIST calls. The Node watcher performs one complete LIST,
# starts a watch from that List resourceVersion, and records any matching event
# from the union of the two runner labels without writing Kubernetes payloads.
recovery_runner_watch_marker_is_exact() {
  local marker_path="$1" mode
  [[ "$marker_path" == /* && -f "$marker_path" && ! -L "$marker_path" ]] || return 1
  # macOS intentionally exposes /var through the stable /private/var alias,
  # which is also where mktemp creates these process-local capabilities. The
  # watcher itself opens the leaf with O_NOFOLLOW and revalidates its type,
  # mode and bounded size on every access; rejecting the system alias would
  # make every recovery watcher fail before its ready handshake.
  if mode="$(stat -f '%Lp' "$marker_path" 2>/dev/null)"; then
    :
  elif mode="$(stat -c '%a' "$marker_path" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  [[ "$mode" == 600 || "$mode" == 0600 ]]
}

recovery_signal_no_managed_bot_runner_watch_stop() {
  local stop_path="$1"
  local value="${2:-discard}"
  recovery_runner_watch_marker_is_exact "$stop_path" || return 1
  if [[ "$value" == discard ]]; then
    printf 'discard\n' >"$stop_path"
  elif [[ "$value" == \{* && ${#value} -le 2047 ]]; then
    printf '%s\n' "$value" >"$stop_path"
  else
    return 2
  fi
}

# Publish one private handoff marker as an atomic, durable local capability.
# Normal watcher stop markers retain their existing byte-for-byte protocol;
# only the legacy restore receipt handoff uses this replacement path.
recovery_publish_checkpoint_writer_handoff_marker() {
  local marker_path="$1" marker_json="$2"
  [[ "$marker_path" == /* && "$marker_json" == \{* &&
     ${#marker_json} -le 2047 ]] || return 2
  recovery_runner_watch_marker_is_exact "$marker_path" || return 1
  command -v python3 >/dev/null 2>&1 || return 127
  python3 -I - "$marker_path" "$marker_json" <<'PY'
import os
import stat
import sys
import tempfile

path, value = sys.argv[1:]
payload = (value + "\n").encode("utf-8")
if not os.path.isabs(path) or len(payload) > 2048:
    raise SystemExit(2)
parent = os.path.dirname(path)
descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
try:
    current = os.fstat(descriptor)
    if not stat.S_ISREG(current.st_mode) or stat.S_IMODE(current.st_mode) != 0o600:
        raise OSError("marker contract")
finally:
    os.close(descriptor)
temporary = None
try:
    descriptor, temporary = tempfile.mkstemp(
        prefix=".checkpoint-writer-handoff.", dir=parent
    )
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "wb", closefd=True) as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    temporary = None
    directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    if temporary is not None:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
PY
  recovery_runner_watch_marker_is_exact "$marker_path" || return 1
  [[ "$(<"$marker_path")" == "$marker_json" ]]
}

recovery_runner_watch_boundary_json() {
  local runner_namespaces runner_namespace pods_json resource_version
  local boundaries='[]'
  runner_namespaces="$(recovery_runner_namespaces)" || return 1
  while IFS= read -r runner_namespace; do
    [[ -n "$runner_namespace" ]] || return 1
    pods_json="$(
      recovery_kubectl_get_namespaced_list pods "$runner_namespace"
    )" || return 1
    resource_version="$(printf '%s' "$pods_json" | jq -er \
      --arg namespace "$runner_namespace" --arg parent_namespace "$NAMESPACE" '
      if .apiVersion != "v1" or .kind != "PodList" or
         (.metadata.resourceVersion | type) != "string" or
         .metadata.resourceVersion == "" or (.items | type) != "array" or
         any(.items[];
           (.metadata | type) != "object" or
           .metadata.namespace != $namespace or
           (.metadata.name | type) != "string" or .metadata.name == "" or
           (.metadata.uid | type) != "string" or .metadata.uid == "" or
           ((.metadata.labels // {}) | type) != "object" or
           (.spec | type) != "object" or
           ((.spec.serviceAccountName // "") | type) != "string" or
           $namespace != $parent_namespace or
           (.metadata.labels.app // "") == "bot-runner" or
           (.metadata.labels.component // "") == "bot-runner" or
           (.metadata.labels["yenhubs.org/managed-by"] // "") == "bot-orchestrator" or
           (.spec.serviceAccountName // "") == "bot-orchestrator")
      then error("unsafe_boundary_pod_inventory")
      else .metadata.resourceVersion end
    ')" || return 1
    boundaries="$(jq -cn --argjson current "$boundaries" \
      --arg namespace "$runner_namespace" --arg resource_version "$resource_version" \
      '$current + [{namespace:$namespace,resourceVersion:$resource_version}]')" || return 1
  done <<<"$runner_namespaces"
  jq -cn --argjson boundaries "$boundaries" \
    '{stop:true,boundaries:$boundaries}'
}

recovery_start_no_managed_bot_runner_watch() {
  local stop_path="$1" failure_path="$2" ready_path="$3" pid_variable="$4"
  local identity_variable="$5" progress_path="${6:-}"
  local watcher_path="$RECOVERY_SAFETY_DIR/../watch-bot-runner-pods.mjs"
  local started_pid="" started_identity="" ready_value="" marker_path
  local runner_namespace="" runner_namespaces="" attempt=0
  local watcher_stable_seconds="" watcher_test_mode=""
  local -a watcher_args=() marker_paths=("$stop_path" "$failure_path" "$ready_path")
  [[ "$pid_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$identity_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$pid_variable" != "$identity_variable" ]] || return 2
  [[ "$stop_path" != "$failure_path" && "$stop_path" != "$ready_path" &&
     "$failure_path" != "$ready_path" ]] || return 2
  if [[ -n "$progress_path" ]]; then
    [[ "$progress_path" != "$stop_path" && "$progress_path" != "$failure_path" &&
       "$progress_path" != "$ready_path" ]] || return 2
    marker_paths+=("$progress_path")
  fi
  for marker_path in "${marker_paths[@]}"; do
    recovery_runner_watch_marker_is_exact "$marker_path" || return 1
    [[ ! -s "$marker_path" ]] || return 1
  done
  [[ -f "$watcher_path" && ! -L "$watcher_path" ]] || return 1
  command -v python3 >/dev/null 2>&1 || return 127
  [[ -n "${EXPECTED_KUBE_CONTEXT:-}" && -n "${NAMESPACE:-}" ]] || return 1
  if ! runner_namespaces="$(recovery_runner_namespaces)"; then
    return 1
  fi
  runner_namespace="$(printf '%s\n' "$runner_namespaces" | tail -n 1)"
  [[ -n "$runner_namespace" ]] || return 1
  watcher_stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  if [[ "$watcher_stable_seconds" != 61 ]]; then
    watcher_test_mode=local-fixture
  fi
  watcher_args=(
    "$watcher_path"
    --context "$EXPECTED_KUBE_CONTEXT"
    --namespace "$NAMESPACE"
    --runner-namespace "$runner_namespace"
    --stop "$stop_path"
    --failure "$failure_path"
    --ready "$ready_path"
  )
  if [[ -n "$progress_path" ]]; then
    watcher_args+=(--progress "$progress_path")
  fi
  (
    # Never let ambient fixture variables reach the Node watcher. Re-export
    # them only after the shell has attested the exact local context,
    # namespace UID and PVC UID above.
    unset YENHUBS_RECOVERY_TEST_MODE RECOVERY_TEST_STABLE_ABSENCE_SECONDS
    if [[ "$watcher_test_mode" == local-fixture ]]; then
      # shellcheck disable=SC2030 # This export is intentionally child-local.
      export YENHUBS_RECOVERY_TEST_MODE=local-fixture
      export RECOVERY_TEST_STABLE_ABSENCE_SECONDS="$watcher_stable_seconds"
    fi
    exec python3 -I -c '
import os
import sys
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
' node "${watcher_args[@]}"
  ) &
  started_pid=$!
  started_identity="$(recovery_process_start_identity "$started_pid")" || {
    # Without the spawn-time identity there is no authority to signal this
    # numeric PID: a fast exit may already have made it reusable.
    return 1
  }
  printf -v "$pid_variable" '%s' "$started_pid"
  printf -v "$identity_variable" '%s' "$started_identity"
  while [[ "$attempt" -lt 200 ]]; do
    if [[ -s "$failure_path" ]]; then
      recovery_discard_no_managed_bot_runner_watch \
        "$stop_path" "$started_pid" "$started_identity"
      printf -v "$pid_variable" '%s' ""
      printf -v "$identity_variable" '%s' ""
      printf 'Managed bot-runner event watcher failed before its ready handshake.\n' >&2
      return 1
    fi
    if [[ -s "$ready_path" ]]; then
      ready_value="$(<"$ready_path")"
      if [[ "$ready_value" == ready ]] &&
         recovery_process_identity_is_live "$started_pid" "$started_identity" &&
         { [[ -z "$progress_path" ]] ||
           recovery_stream_guard_progress_value "$progress_path" >/dev/null; }; then
        return 0
      fi
      break
    fi
    if ! recovery_process_identity_is_live \
        "$started_pid" "$started_identity"; then
      printf -v "$pid_variable" '%s' ""
      printf -v "$identity_variable" '%s' ""
      printf 'Managed bot-runner event watcher exited before its ready handshake.\n' >&2
      return 1
    fi
    sleep 0.05
    attempt=$((attempt + 1))
  done
  recovery_discard_no_managed_bot_runner_watch \
    "$stop_path" "$started_pid" "$started_identity"
  printf -v "$pid_variable" '%s' ""
  printf -v "$identity_variable" '%s' ""
  printf 'Managed bot-runner event watcher did not complete an exact ready handshake.\n' >&2
  return 1
}

recovery_require_no_managed_bot_runner_watch_healthy() {
  local failure_path="$1" ready_path="$2" watcher_pid="$3"
  local watcher_identity="$4"
  local ready_value=""
  recovery_runner_watch_marker_is_exact "$failure_path" || return 1
  recovery_runner_watch_marker_is_exact "$ready_path" || return 1
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && ! -s "$failure_path" ]] || return 1
  ready_value="$(<"$ready_path")"
  [[ "$ready_value" == ready ]] || return 1
  recovery_process_identity_is_live "$watcher_pid" "$watcher_identity"
}

recovery_stop_no_managed_bot_runner_watch() {
  local stop_path="$1" failure_path="$2" ready_path="$3" watcher_pid="$4"
  local watcher_identity="$5"
  local watcher_status=0 ready_value="" boundary_json="" stop_written=0
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" ]] || return 2
  recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" || return 1
  if boundary_json="$(recovery_runner_watch_boundary_json)"; then
    if recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" &&
       recovery_signal_no_managed_bot_runner_watch_stop \
        "$stop_path" "$boundary_json"; then
      stop_written=1
    else
      watcher_status=1
    fi
  else
    watcher_status=1
    if recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" &&
       recovery_signal_no_managed_bot_runner_watch_stop \
        "$stop_path" discard; then
      stop_written=1
    fi
  fi
  if [[ "$stop_written" == 1 ]]; then
    recovery_wait_isolated_process_bounded \
      "$watcher_pid" "$watcher_identity" "$stop_path" || watcher_status=1
  else
    # A broken marker path must not leave the isolated watcher running forever.
    recovery_stop_process_group "$watcher_pid" "$watcher_identity" || :
    watcher_status=1
  fi
  recovery_runner_watch_marker_is_exact "$failure_path" || watcher_status=1
  recovery_runner_watch_marker_is_exact "$ready_path" || watcher_status=1
  [[ ! -s "$failure_path" ]] || watcher_status=1
  if [[ -f "$ready_path" ]]; then ready_value="$(<"$ready_path")"; fi
  [[ "$ready_value" == ready ]] || watcher_status=1
  recovery_require_no_managed_bot_runner_pods || watcher_status=1
  [[ "$watcher_status" == 0 ]]
}

recovery_discard_no_managed_bot_runner_watch() {
  local stop_path="$1" watcher_pid="$2" watcher_identity="$3"
  if [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" ]] &&
     recovery_process_identity_is_live "$watcher_pid" "$watcher_identity"; then
    if recovery_signal_no_managed_bot_runner_watch_stop \
        "$stop_path" 2>/dev/null; then
      recovery_wait_isolated_process_bounded \
        "$watcher_pid" "$watcher_identity" "$stop_path" 2>/dev/null || :
    else
      recovery_stop_process_group "$watcher_pid" "$watcher_identity" || :
    fi
  fi
}

# The coordinated checkpoint has a wider invariant than the isolated-runner
# watcher above: all five fixed DB consumers must remain at zero, their exact
# Deployment/ReplicaSet contracts must not advance, and no matching Pod may
# appear while pg_dump and ret-pvc are captured. The Node watcher binds its
# initial LIST resourceVersions to continuous watch streams, while these shell
# wrappers retain the full Lease/operation-lock authorization contract.
recovery_checkpoint_writer_monitor_file_is_exact() {
  local file_path="$1" expected_sha256="$2" maximum_bytes="$3"
  local size digest_before digest_after
  [[ "$expected_sha256" =~ ^[a-f0-9]{64}$ &&
     "$maximum_bytes" =~ ^[1-9][0-9]*$ ]] || return 2
  recovery_private_values_file_is_acceptable "$file_path" || return 1
  size="$(recovery_file_size_bytes "$file_path")" || return 1
  [[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 &&
     "$size" -le "$maximum_bytes" ]] || return 1
  digest_before="$(recovery_sha256_digest "$file_path")" || return 1
  [[ "$digest_before" == "$expected_sha256" ]] || return 1
  # A second descriptor-level digest closes local same-size replacement while
  # the caller moves from validation into a watcher/boundary invocation.
  digest_after="$(recovery_sha256_digest "$file_path")" || return 1
  [[ "$digest_after" == "$expected_sha256" ]]
}

recovery_checkpoint_writer_monitor_authority_json() {
  local contract_path="$1" contract_sha256="$2" baseline_path="$3"
  local stop_path="$4" failure_path="$5" ready_path="$6" progress_path="$7"
  local final_path="$8" watcher_pid="$9" watcher_identity="${10}"
  local runtime_generation="${11}" operation_owner="${12}" authority_path
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  [[ "$contract_sha256" =~ ^[a-f0-9]{64}$ &&
     "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" &&
     "$runtime_generation" =~ ^(durable-v2|legacy-absent)$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" ]] || return 2
  jq -cnS \
    --arg kind checkpoint-writer-monitor --argjson pid "$watcher_pid" \
    --arg start_identity "$watcher_identity" \
    --arg context "$EXPECTED_KUBE_CONTEXT" --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$operation_owner" \
    --arg runtime_generation "$runtime_generation" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg authority "$authority_path" --arg contract "$contract_path" \
    --arg baseline "$baseline_path" --arg stop "$stop_path" \
    --arg failure "$failure_path" --arg ready "$ready_path" \
    --arg progress "$progress_path" --arg final "$final_path" \
    --arg contract_sha256 "$contract_sha256" '
    {schema_version:1,kind:$kind,pid:$pid,start_identity:$start_identity,
     context:$context,namespace:$namespace,namespace_uid:$namespace_uid,
     operation_id:$operation_id,operation_owner:$operation_owner,
     runtime_generation:$runtime_generation,
     operation_lock:{name:$lock_name,uid:$lock_uid,resource_version:$lock_rv},
     lease:{name:$lease_name,uid:$lease_uid,holder:$lease_holder},
     paths:{authority:$authority,contract:$contract,baseline:$baseline,
       stop:$stop,failure:$failure,ready:$ready,progress:$progress,final:$final},
     hashes:{contract_sha256:$contract_sha256}}
  '
}

recovery_checkpoint_writer_monitor_authority_is_exact() {
  local authority_path="$1" authority_sha256="$2" contract_path="$3"
  local contract_sha256="$4" baseline_path="$5" stop_path="$6"
  local failure_path="$7" ready_path="$8" progress_path="$9"
  local final_path="${10}" watcher_pid="${11}" watcher_identity="${12}"
  local runtime_generation="${13}" operation_owner="${14}" expected_json
  local require_live="${15:-1}"
  [[ "$require_live" == 0 || "$require_live" == 1 ]] || return 2
  if [[ "$require_live" == 1 ]]; then
    recovery_monitor_authority_common_is_exact \
      "$authority_path" "$authority_sha256" checkpoint-writer-monitor \
      "$watcher_pid" "$watcher_identity" "$failure_path" "$ready_path" \
      "$progress_path" || return 1
  else
    recovery_checkpoint_writer_monitor_file_is_exact \
      "$authority_path" "$authority_sha256" 65536 || return 1
  fi
  expected_json="$(recovery_checkpoint_writer_monitor_authority_json \
    "$contract_path" "$contract_sha256" "$baseline_path" "$stop_path" \
    "$failure_path" "$ready_path" "$progress_path" "$final_path" \
    "$watcher_pid" "$watcher_identity" "$runtime_generation" \
    "$operation_owner")" || return 1
  [[ "$(<"$authority_path")" == "$expected_json" ]]
}

recovery_monitor_authority_sha256_for_ready() {
  local ready_path="$1" authority_path authority_sha256
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  recovery_require_regular_direct_file "$authority_path" || return 1
  authority_sha256="$(recovery_sha256_digest "$authority_path")" || return 1
  [[ "$authority_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$authority_path" "$authority_sha256" 65536 || return 1
  printf '%s\n' "$authority_sha256"
}

recovery_checkpoint_writer_monitor_final_json_is_acceptable() {
  local final_json="$1" contract_path="$2" authority_sha256="${3:-}"
  [[ -n "$final_json" ]] || return 1
  if [[ -z "$authority_sha256" ]]; then
    authority_sha256="$(jq -er '.monitor_authority_sha256' \
      <<<"$final_json")" || return 1
  fi
  [[ "$authority_sha256" =~ ^[a-f0-9]{64}$ ]] || return 2
  recovery_require_regular_direct_file "$contract_path" || return 1
  jq -e --slurpfile contract "$contract_path" \
    --arg authority_sha256 "$authority_sha256" '
    (keys | sort) == ["complete", "deployments", "monitor_authority_sha256"] and
    .complete == true and .monitor_authority_sha256 == $authority_sha256 and
    (.deployments | type == "array" and length == 5) and
    ([.deployments[].name] | sort) ==
      ([ $contract[0].consumers[].name ] | sort) and
    ([.deployments[].name] | unique | length) == 5 and
    ([.deployments[].uid] | unique | length) == 5 and
    all(.deployments[];
      (keys | sort) == ["name", "resource_version", "uid"] and
      (.name | type == "string" and length > 0) and
      (.uid | type == "string" and length > 0) and
      (.resource_version | type == "string" and length > 0)) and
    all(.deployments[];
      . as $live |
      any($contract[0].consumers[];
        .name == $live.name and .uid == $live.uid)) and
    (.deployments | map(.name)) == ([.deployments[].name] | sort)
  ' >/dev/null 2>&1 <<<"$final_json"
}

recovery_checkpoint_writer_receipt_arm_json() {
  local boundary_json="$1" authority_sha256="$2" token="$3"
  local target_name="$4" target_uid="$5"
  [[ "$authority_sha256" =~ ^[a-f0-9]{64}$ &&
     "$token" =~ ^[a-f0-9]{32}$ && "$target_name" == reticulum &&
     -n "$target_uid" &&
     "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-restore &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     -n "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_NAME:-}" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_UID:-}" &&
     "${RECOVERY_SERIALIZATION_LEASE_HOLDER:-}" =~ ^root-recovery: ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$target_name" || return 1
  jq -e '
    (keys | sort) == ["boundaries", "stop"] and .stop == true and
    (.boundaries | keys | sort) == ["deployments", "pods", "replicasets"] and
    all(.boundaries[]; type == "string" and length > 0)
  ' >/dev/null 2>&1 <<<"$boundary_json" || return 1
  jq -cnS --argjson boundary "$boundary_json" \
    --arg authority_sha256 "$authority_sha256" --arg token "$token" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$RECOVERY_OPERATION_OWNER" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg target_name "$target_name" --arg target_uid "$target_uid" '
    {handoff:"receipt-arm",boundaries:$boundary.boundaries,
     monitor_authority_sha256:$authority_sha256,token:$token,
     operation:{id:$operation_id,owner:$operation_owner},
     operation_lock:{name:$lock_name,uid:$lock_uid,resource_version:$lock_rv},
     lease:{name:$lease_name,uid:$lease_uid,holder:$lease_holder},
     target:{name:$target_name,uid:$target_uid},
     receipt:{annotation:"yenhubs.org/checkpoint-resume-operation",
       value:$operation_id,mode:"create",patch_response_resource_version:null}}
  '
}

recovery_checkpoint_writer_receipt_commit_json() {
  local authority_sha256="$1" token="$2" target_name="$3" target_uid="$4"
  local patch_resource_version="$5"
  [[ "$authority_sha256" =~ ^[a-f0-9]{64}$ &&
     "$token" =~ ^[a-f0-9]{32}$ && "$target_name" == reticulum &&
     -n "$target_uid" && -n "$patch_resource_version" &&
     "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-restore &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     -n "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_NAME:-}" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_UID:-}" &&
     "${RECOVERY_SERIALIZATION_LEASE_HOLDER:-}" =~ ^root-recovery: ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$target_name" || return 1
  jq -cnS --arg authority_sha256 "$authority_sha256" --arg token "$token" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$RECOVERY_OPERATION_OWNER" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg target_name "$target_name" --arg target_uid "$target_uid" \
    --arg patch_rv "$patch_resource_version" '
    {handoff:"receipt-commit",monitor_authority_sha256:$authority_sha256,
     token:$token,operation:{id:$operation_id,owner:$operation_owner},
     operation_lock:{name:$lock_name,uid:$lock_uid,resource_version:$lock_rv},
     lease:{name:$lease_name,uid:$lease_uid,holder:$lease_holder},
     target:{name:$target_name,uid:$target_uid},
     receipt:{annotation:"yenhubs.org/checkpoint-resume-operation",
       value:$operation_id,mode:"create",
       patch_response_resource_version:$patch_rv}}
  '
}

recovery_checkpoint_writer_receipt_armed_json_is_acceptable() {
  local armed_json="$1" contract_path="$2" authority_sha256="$3"
  local token_sha256="$4" target_name="$5" target_uid="$6"
  local target_generation="$7"
  [[ -n "$armed_json" && "$authority_sha256" =~ ^[a-f0-9]{64}$ &&
     "$token_sha256" =~ ^[a-f0-9]{64}$ && "$target_name" == reticulum &&
     -n "$target_uid" && "$target_generation" =~ ^[1-9][0-9]*$ &&
     "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-restore &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$target_name" || return 1
  recovery_require_regular_direct_file "$contract_path" || return 1
  jq -e --slurpfile contract "$contract_path" \
    --arg authority_sha256 "$authority_sha256" \
    --arg token_sha256 "$token_sha256" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$RECOVERY_OPERATION_OWNER" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg target_name "$target_name" --arg target_uid "$target_uid" \
    --argjson target_generation "$target_generation" '
    . as $root |
    ($contract | length) == 1 and
    $contract[0].operation_id == $operation_id and
    (keys | sort) == ["deployments", "handoff", "lease",
      "monitor_authority_sha256", "operation", "operation_lock", "receipt",
      "target", "token_sha256"] and
    .handoff == "receipt-armed" and
    .monitor_authority_sha256 == $authority_sha256 and
    .token_sha256 == $token_sha256 and
    (.operation | keys | sort) == ["id", "owner"] and
    .operation.id == $operation_id and .operation.owner == $operation_owner and
    (.operation_lock | keys | sort) == ["name", "resource_version", "uid"] and
    .operation_lock.name == $lock_name and .operation_lock.uid == $lock_uid and
    .operation_lock.resource_version == $lock_rv and
    (.lease | keys | sort) == ["holder", "name", "uid"] and
    .lease.name == $lease_name and .lease.uid == $lease_uid and
    .lease.holder == $lease_holder and
    (.target | keys | sort) == ["generation", "name", "uid"] and
    .target.name == $target_name and .target.uid == $target_uid and
    .target.generation == $target_generation and
    (.receipt | keys | sort) == ["annotation", "armed_resource_version",
      "mode", "value"] and
    .receipt.annotation == "yenhubs.org/checkpoint-resume-operation" and
    .receipt.value == $operation_id and .receipt.mode == "create" and
    (.receipt.armed_resource_version | type == "string" and length > 0) and
    (.deployments | type == "array" and length == 5) and
    ([.deployments[].name] | sort) ==
      ([$contract[0].consumers[].name] | sort) and
    ([.deployments[].name] | unique | length) == 5 and
    ([.deployments[].uid] | unique | length) == 5 and
    all(.deployments[];
      (keys | sort) == ["name", "resource_version", "uid"] and
      (.name | type == "string" and length > 0) and
      (.uid | type == "string" and length > 0) and
      (.resource_version | type == "string" and length > 0)) and
    all(.deployments[]; . as $live |
      any($contract[0].consumers[];
        .name == $live.name and .uid == $live.uid)) and
    (.deployments | map(.name)) == ([.deployments[].name] | sort) and
    ([$root.deployments[] |
      select(.name == $target_name and .uid == $target_uid)] | length) == 1 and
    ([$root.deployments[] |
      select(.name == $target_name and .uid == $target_uid)][0].resource_version ==
      $root.receipt.armed_resource_version)
  ' >/dev/null 2>&1 <<<"$armed_json"
}

recovery_checkpoint_writer_receipt_ack_json_is_acceptable() {
  local ack_json="$1" contract_path="$2" authority_sha256="$3"
  local token_sha256="$4" target_name="$5" target_uid="$6"
  local target_generation="$7" patch_resource_version="$8"
  [[ -n "$ack_json" && "$authority_sha256" =~ ^[a-f0-9]{64}$ &&
     "$token_sha256" =~ ^[a-f0-9]{64}$ && "$target_name" == reticulum &&
     -n "$target_uid" && "$target_generation" =~ ^[1-9][0-9]*$ &&
     -n "$patch_resource_version" &&
     "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-restore &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$target_name" || return 1
  recovery_require_regular_direct_file "$contract_path" || return 1
  jq -e --slurpfile contract "$contract_path" \
    --arg authority_sha256 "$authority_sha256" \
    --arg token_sha256 "$token_sha256" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$RECOVERY_OPERATION_OWNER" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg target_name "$target_name" --arg target_uid "$target_uid" \
    --argjson target_generation "$target_generation" \
    --arg patch_rv "$patch_resource_version" '
    . as $root |
    ($contract | length) == 1 and
    $contract[0].operation_id == $operation_id and
    (keys | sort) == ["deployments", "handoff", "lease",
      "monitor_authority_sha256", "operation", "operation_lock", "receipt",
      "target", "token_sha256"] and
    .handoff == "receipt-ack" and
    .monitor_authority_sha256 == $authority_sha256 and
    .token_sha256 == $token_sha256 and
    (.operation | keys | sort) == ["id", "owner"] and
    .operation.id == $operation_id and .operation.owner == $operation_owner and
    (.operation_lock | keys | sort) == ["name", "resource_version", "uid"] and
    .operation_lock.name == $lock_name and .operation_lock.uid == $lock_uid and
    .operation_lock.resource_version == $lock_rv and
    (.lease | keys | sort) == ["holder", "name", "uid"] and
    .lease.name == $lease_name and .lease.uid == $lease_uid and
    .lease.holder == $lease_holder and
    (.target | keys | sort) == ["generation", "name", "uid"] and
    .target.name == $target_name and .target.uid == $target_uid and
    .target.generation == $target_generation and
    (.receipt | keys | sort) == ["annotation", "mode",
      "patch_response_resource_version", "terminal_resource_version", "value"] and
    .receipt.annotation == "yenhubs.org/checkpoint-resume-operation" and
    .receipt.value == $operation_id and .receipt.mode == "create" and
    .receipt.patch_response_resource_version == $patch_rv and
    (.receipt.terminal_resource_version | type == "string" and length > 0) and
    (.deployments | type == "array" and length == 5) and
    ([.deployments[].name] | sort) ==
      ([$contract[0].consumers[].name] | sort) and
    ([.deployments[].name] | unique | length) == 5 and
    ([.deployments[].uid] | unique | length) == 5 and
    all(.deployments[];
      (keys | sort) == ["name", "resource_version", "uid"] and
      (.name | type == "string" and length > 0) and
      (.uid | type == "string" and length > 0) and
      (.resource_version | type == "string" and length > 0)) and
    all(.deployments[]; . as $live |
      any($contract[0].consumers[];
        .name == $live.name and .uid == $live.uid)) and
    (.deployments | map(.name)) == ([.deployments[].name] | sort) and
    ([$root.deployments[] |
      select(.name == $target_name and .uid == $target_uid)] | length) == 1 and
    ([$root.deployments[] |
      select(.name == $target_name and .uid == $target_uid)][0].resource_version ==
      $root.receipt.terminal_resource_version)
  ' >/dev/null 2>&1 <<<"$ack_json"
}

# Arm the legacy metadata-receipt transfer and wait while the same local
# watcher identity remains live. The random token and initially empty FINAL
# marker prevent this process from adopting another process's ACK.
recovery_arm_checkpoint_writer_receipt_handoff() {
  local contract_path="$1" contract_sha256="$2" baseline_path="$3"
  local baseline_sha256="$4" stop_path="$5" failure_path="$6"
  local ready_path="$7" progress_path="$8" final_path="$9"
  local watcher_pid="${10}" watcher_identity="${11}"
  local authority_sha256="${12}" runtime_generation="${13}"
  local operation_owner="${14}" target_name="${15}" target_uid="${16}"
  local token_variable="${17}" armed_variable="${18}"
  local authority_path boundary_json arm_json token token_sha256
  local target_generation observed_armed_json="" timeout_seconds attempt=0
  local max_attempts
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" &&
     "$authority_sha256" =~ ^[a-f0-9]{64}$ &&
     "$runtime_generation" == legacy-absent &&
     "$operation_owner" == checkpoint-restore && "$target_name" == reticulum &&
     -n "$target_uid" &&
     "$token_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$armed_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$token_variable" != "$armed_variable" ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$target_name" || return 1
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$contract_path" "$contract_sha256" 131072 || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$baseline_path" "$baseline_sha256" 2097152 || return 1
  recovery_require_checkpoint_writer_monitor_healthy \
    "$contract_path" "$contract_sha256" "$baseline_path" \
    "$baseline_sha256" "$failure_path" "$ready_path" "$watcher_pid" \
    "$watcher_identity" "$runtime_generation" "$operation_owner" || return 1
  recovery_checkpoint_writer_monitor_authority_is_exact \
    "$authority_path" "$authority_sha256" "$contract_path" \
    "$contract_sha256" "$baseline_path" "$stop_path" "$failure_path" \
    "$ready_path" "$progress_path" "$final_path" "$watcher_pid" \
    "$watcher_identity" "$runtime_generation" "$operation_owner" || return 1
  recovery_runner_watch_marker_is_exact "$stop_path" || return 1
  recovery_runner_watch_marker_is_exact "$failure_path" || return 1
  recovery_runner_watch_marker_is_exact "$final_path" || return 1
  [[ ! -s "$stop_path" && ! -s "$failure_path" && ! -s "$final_path" ]] || return 1
  target_generation="$(jq -er --arg name "$target_name" --arg uid "$target_uid" '
    [.deployments[] | select(.name == $name and .uid == $uid)] |
    select(length == 1) | .[0].generation |
    select(type == "number" and floor == . and . >= 1)
  ' "$baseline_path")" || return 1
  token="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" || return 1
  [[ "$token" =~ ^[a-f0-9]{32}$ ]] || return 1
  token_sha256="$(printf '%s' "$token" | recovery_sha256_bytes)" || return 1
  boundary_json="$(recovery_checkpoint_writer_monitor_boundary_json \
    "$contract_path" "$contract_sha256" "$baseline_path" \
    "$baseline_sha256" "$runtime_generation" "$operation_owner")" || return 1
  recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" || return 1
  arm_json="$(recovery_checkpoint_writer_receipt_arm_json \
    "$boundary_json" "$authority_sha256" "$token" "$target_name" \
    "$target_uid")" || return 1
  recovery_publish_checkpoint_writer_handoff_marker \
    "$stop_path" "$arm_json" || return 1
  timeout_seconds="$(recovery_watcher_join_timeout_seconds)" || return 1
  max_attempts=$((timeout_seconds * 20))
  while ((attempt < max_attempts)); do
    recovery_runner_watch_marker_is_exact "$failure_path" || return 1
    recovery_runner_watch_marker_is_exact "$final_path" || return 1
    [[ ! -s "$failure_path" ]] || return 1
    if [[ -s "$final_path" ]]; then
      observed_armed_json="$(<"$final_path")"
      recovery_checkpoint_writer_receipt_armed_json_is_acceptable \
        "$observed_armed_json" "$contract_path" "$authority_sha256" \
        "$token_sha256" \
        "$target_name" "$target_uid" "$target_generation" || return 1
      recovery_process_identity_is_live \
        "$watcher_pid" "$watcher_identity" || return 1
      recovery_checkpoint_writer_monitor_authority_is_exact \
        "$authority_path" "$authority_sha256" "$contract_path" \
        "$contract_sha256" "$baseline_path" "$stop_path" "$failure_path" \
        "$ready_path" "$progress_path" "$final_path" "$watcher_pid" \
        "$watcher_identity" "$runtime_generation" "$operation_owner" || return 1
      recovery_checkpoint_writer_monitor_file_is_exact \
        "$baseline_path" "$baseline_sha256" 2097152 || return 1
      recovery_require_operation_serialization || return 1
      recovery_require_operation_lock || return 1
      printf -v "$token_variable" '%s' "$token"
      printf -v "$armed_variable" '%s' "$observed_armed_json"
      return 0
    fi
    recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" || return 1
    sleep 0.05
    attempt=$((attempt + 1))
  done
  return 1
}

recovery_commit_checkpoint_writer_receipt_handoff() {
  local contract_path="$1" contract_sha256="$2" baseline_path="$3"
  local baseline_sha256="$4" stop_path="$5" failure_path="$6"
  local ready_path="$7" progress_path="$8" final_path="$9"
  local watcher_pid="${10}" watcher_identity="${11}"
  local authority_sha256="${12}" runtime_generation="${13}"
  local operation_owner="${14}" target_name="${15}" target_uid="${16}"
  local token="${17}" armed_json="${18}" patch_resource_version="${19}"
  local joined_variable="${20}" ack_variable="${21}"
  local authority_path token_sha256 target_generation commit_json
  local observed_ack_json=""
  local joined_state
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" &&
     "$authority_sha256" =~ ^[a-f0-9]{64}$ &&
     "$runtime_generation" == legacy-absent &&
     "$operation_owner" == checkpoint-restore && "$target_name" == reticulum &&
     -n "$target_uid" && "$token" =~ ^[a-f0-9]{32}$ &&
     -n "$armed_json" && -n "$patch_resource_version" &&
     "$joined_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$ack_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$joined_variable" != "$ack_variable" ]] || return 2
  recovery_require_legacy_checkpoint_receipt_mutation_context \
    "$target_name" || return 1
  joined_state="${!joined_variable}"
  [[ "$joined_state" == 0 ]] || return 2
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  token_sha256="$(printf '%s' "$token" | recovery_sha256_bytes)" || return 1
  target_generation="$(jq -er --arg name "$target_name" --arg uid "$target_uid" '
    [.deployments[] | select(.name == $name and .uid == $uid)] |
    select(length == 1) | .[0].generation |
    select(type == "number" and floor == . and . >= 1)
  ' "$baseline_path")" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$contract_path" "$contract_sha256" 131072 || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$baseline_path" "$baseline_sha256" 2097152 || return 1
  recovery_checkpoint_writer_receipt_armed_json_is_acceptable \
    "$armed_json" "$contract_path" "$authority_sha256" "$token_sha256" \
    "$target_name" "$target_uid" "$target_generation" || return 1
  recovery_runner_watch_marker_is_exact "$final_path" || return 1
  [[ "$(<"$final_path")" == "$armed_json" ]] || return 1
  recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" || return 1
  recovery_checkpoint_writer_monitor_authority_is_exact \
    "$authority_path" "$authority_sha256" "$contract_path" \
    "$contract_sha256" "$baseline_path" "$stop_path" "$failure_path" \
    "$ready_path" "$progress_path" "$final_path" "$watcher_pid" \
    "$watcher_identity" "$runtime_generation" "$operation_owner" || return 1
  commit_json="$(recovery_checkpoint_writer_receipt_commit_json \
    "$authority_sha256" "$token" "$target_name" "$target_uid" \
    "$patch_resource_version")" || return 1
  recovery_publish_checkpoint_writer_handoff_marker \
    "$stop_path" "$commit_json" || return 1
  if recovery_wait_isolated_process_bounded \
      "$watcher_pid" "$watcher_identity" "$stop_path"; then
    printf -v "$joined_variable" '%s' ok
  else
    printf -v "$joined_variable" '%s' failed
    return 1
  fi
  recovery_runner_watch_marker_is_exact "$failure_path" || return 1
  recovery_runner_watch_marker_is_exact "$final_path" || return 1
  [[ ! -s "$failure_path" && -s "$final_path" ]] || return 1
  observed_ack_json="$(<"$final_path")"
  recovery_checkpoint_writer_receipt_ack_json_is_acceptable \
    "$observed_ack_json" "$contract_path" "$authority_sha256" "$token_sha256" \
    "$target_name" "$target_uid" "$target_generation" \
    "$patch_resource_version" || return 1
  recovery_checkpoint_writer_monitor_authority_is_exact \
    "$authority_path" "$authority_sha256" "$contract_path" \
    "$contract_sha256" "$baseline_path" "$stop_path" "$failure_path" \
    "$ready_path" "$progress_path" "$final_path" "$watcher_pid" \
    "$watcher_identity" "$runtime_generation" "$operation_owner" 0 || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$baseline_path" "$baseline_sha256" 2097152 || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  printf -v "$ack_variable" '%s' "$observed_ack_json"
}

recovery_checkpoint_writer_monitor_common_args() {
  local contract_path="$1" contract_sha256="$2" baseline_path="$3"
  local runtime_generation="$4" operation_owner="$5"
  [[ "$contract_sha256" =~ ^[a-f0-9]{64}$ &&
     "$runtime_generation" =~ ^(durable-v2|legacy-absent)$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" &&
     -n "${EXPECTED_KUBE_CONTEXT:-}" && -n "${NAMESPACE:-}" &&
     -n "${RECOVERY_NAMESPACE_UID:-}" &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_LOCK_NAME:-}" == "$RECOVERY_OPERATION_LOCK_GLOBAL_NAME" &&
     -n "${RECOVERY_OPERATION_LOCK_UID:-}" &&
     -n "${RECOVERY_OPERATION_LOCK_RESOURCE_VERSION:-}" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_NAME:-}" &&
     -n "${RECOVERY_SERIALIZATION_LEASE_UID:-}" &&
     "${RECOVERY_SERIALIZATION_LEASE_HOLDER:-}" =~ ^root-recovery: ]] || return 2
  printf '%s\0' \
    --context "$EXPECTED_KUBE_CONTEXT" \
    --namespace "$NAMESPACE" \
    --namespace-uid "$RECOVERY_NAMESPACE_UID" \
    --contract "$contract_path" \
    --contract-sha256 "$contract_sha256" \
    --baseline "$baseline_path" \
    --operation-lock-name "$RECOVERY_OPERATION_LOCK_NAME" \
    --operation-lock-uid "$RECOVERY_OPERATION_LOCK_UID" \
    --operation-lock-resource-version "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --operation-owner "$operation_owner" \
    --operation-id "$RECOVERY_OPERATION_ID" \
    --lease-name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --lease-uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --lease-holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --runtime-generation "$runtime_generation"
}

recovery_checkpoint_writer_monitor_kubectl_bin() {
  local requested="${KUBECTL_BIN:-kubectl}"
  if [[ -z "$requested" || "$requested" == kubectl ]]; then
    printf 'kubectl\n'
    return 0
  fi
  recovery_require_local_fixture_attestation || {
    printf 'Checkpoint writer KUBECTL_BIN overrides require the exact isolated fixture identity.\n' >&2
    return 1
  }
  [[ "$requested" == /* && -x "$requested" ]] || return 2
  recovery_require_regular_direct_file "$requested" || return 1
  printf '%s\n' "$requested"
}

recovery_checkpoint_writer_monitor_boundary_json() {
  local contract_path="$1" contract_sha256="$2" baseline_path="$3"
  local baseline_sha256="$4" runtime_generation="$5" operation_owner="$6"
  local watcher_path watcher_kubectl_bin
  local boundary_json
  local -a common_args=()
  [[ "$runtime_generation" =~ ^(durable-v2|legacy-absent)$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" ]] || return 2
  watcher_path="$(cd "$RECOVERY_SAFETY_DIR/.." && pwd -P)/watch-checkpoint-writers.mjs" ||
    return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$contract_path" "$contract_sha256" 131072 || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$baseline_path" "$baseline_sha256" 2097152 || return 1
  recovery_require_regular_direct_file "$watcher_path" || return 1
  watcher_kubectl_bin="$(
    recovery_checkpoint_writer_monitor_kubectl_bin
  )" || return 1
  while IFS= read -r -d '' argument; do
    common_args+=("$argument")
  done < <(recovery_checkpoint_writer_monitor_common_args \
    "$contract_path" "$contract_sha256" "$baseline_path" \
    "$runtime_generation" "$operation_owner")
  [[ "${#common_args[@]}" == 30 ]] || return 1
  boundary_json="$(env KUBECTL_BIN="$watcher_kubectl_bin" \
    node "$watcher_path" boundary \
      "${common_args[@]}" --baseline-sha256 "$baseline_sha256")" || return 1
  jq -e '
    (keys | sort) == ["boundaries", "stop"] and .stop == true and
    (.boundaries | keys | sort) == ["deployments", "pods", "replicasets"] and
    all(.boundaries[]; type == "string" and length > 0)
  ' >/dev/null 2>&1 <<<"$boundary_json" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  printf '%s\n' "$boundary_json"
}

recovery_start_checkpoint_writer_monitor() {
  local contract_path="$1" contract_sha256="$2" baseline_path="$3"
  local stop_path="$4" failure_path="$5" ready_path="$6" progress_path="$7"
  local final_path="$8" pid_variable="$9" identity_variable="${10}"
  local baseline_sha_variable="${11}"
  local runtime_generation="${12}"
  local operation_owner="${13}"
  local watcher_path watcher_kubectl_bin
  local marker_path started_pid="" started_identity="" ready_value="" attempt=0
  local spawn_gate="" authority_path authority_json authority_sha256=""
  local ready_authority_sha256=""
  local stable_seconds watcher_test_mode="" baseline_sha256
  local -a common_args=()
  watcher_path="$(cd "$RECOVERY_SAFETY_DIR/.." && pwd -P)/watch-checkpoint-writers.mjs" ||
    return 1
  [[ "$pid_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$identity_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$baseline_sha_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$runtime_generation" =~ ^(durable-v2|legacy-absent)$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" &&
     "$pid_variable" != "$identity_variable" &&
     "$pid_variable" != "$baseline_sha_variable" &&
     "$identity_variable" != "$baseline_sha_variable" ]] || return 2
  [[ "$stop_path" != "$failure_path" && "$stop_path" != "$ready_path" &&
     "$stop_path" != "$progress_path" && "$stop_path" != "$final_path" &&
     "$failure_path" != "$ready_path" && "$failure_path" != "$progress_path" &&
     "$failure_path" != "$final_path" && "$ready_path" != "$progress_path" &&
     "$ready_path" != "$final_path" && "$progress_path" != "$final_path" &&
     "$baseline_path" != "$stop_path" && "$baseline_path" != "$failure_path" &&
     "$baseline_path" != "$ready_path" && "$baseline_path" != "$progress_path" &&
     "$baseline_path" != "$final_path" ]] || return 2
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  [[ "$authority_path" != "$contract_path" &&
     "$authority_path" != "$baseline_path" &&
     "$authority_path" != "$stop_path" &&
     "$authority_path" != "$failure_path" &&
     "$authority_path" != "$ready_path" &&
     "$authority_path" != "$progress_path" &&
     "$authority_path" != "$final_path" &&
     ! -e "$authority_path" && ! -L "$authority_path" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$contract_path" "$contract_sha256" 131072 || return 1
  for marker_path in \
    "$stop_path" "$failure_path" "$ready_path" "$progress_path" "$final_path" \
    "$baseline_path"; do
    recovery_runner_watch_marker_is_exact "$marker_path" || return 1
    [[ ! -s "$marker_path" ]] || return 1
  done
  recovery_require_regular_direct_file "$watcher_path" || return 1
  command -v python3 >/dev/null 2>&1 || return 127
  watcher_kubectl_bin="$(
    recovery_checkpoint_writer_monitor_kubectl_bin
  )" || return 1
  while IFS= read -r -d '' argument; do
    common_args+=("$argument")
  done < <(recovery_checkpoint_writer_monitor_common_args \
    "$contract_path" "$contract_sha256" "$baseline_path" \
    "$runtime_generation" "$operation_owner")
  [[ "${#common_args[@]}" == 30 ]] || return 1
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  if [[ "$stable_seconds" != 61 ]]; then
    watcher_test_mode=local-fixture
  fi
  spawn_gate="$(mktemp "$(dirname "$stop_path")/.checkpoint-writer-spawn-gate.XXXXXX")" ||
    return 1
  chmod 600 "$spawn_gate" || {
    rm -f -- "$spawn_gate"
    return 1
  }
  (
    unset KUBECTL_BIN YENHUBS_RECOVERY_TEST_MODE \
      RECOVERY_TEST_STABLE_ABSENCE_SECONDS
    if [[ "$watcher_test_mode" == local-fixture ]]; then
      exec env \
        KUBECTL_BIN="$watcher_kubectl_bin" \
        YENHUBS_RECOVERY_TEST_MODE=local-fixture \
        RECOVERY_TEST_STABLE_ABSENCE_SECONDS="$stable_seconds" \
        python3 -I -c '
import os
import sys
import time
os.setsid()
gate_path = sys.argv[1]
deadline = time.monotonic() + 5
while True:
    try:
        with open(gate_path, "rb") as gate:
            decision = gate.read(16)
    except OSError:
        sys.exit(1)
    if decision == b"go\n":
        break
    if decision not in (b"",):
        sys.exit(1)
    if time.monotonic() >= deadline:
        sys.exit(1)
    time.sleep(0.01)
try:
    os.unlink(gate_path)
except OSError:
    sys.exit(1)
os.execvp(sys.argv[2], sys.argv[2:])
' "$spawn_gate" node "$watcher_path" monitor "${common_args[@]}" \
        --stop "$stop_path" --failure "$failure_path" --ready "$ready_path" \
        --progress "$progress_path" --final "$final_path" \
        --authority "$authority_path"
    fi
    exec env KUBECTL_BIN="$watcher_kubectl_bin" \
      python3 -I -c '
import os
import sys
import time
os.setsid()
gate_path = sys.argv[1]
deadline = time.monotonic() + 5
while True:
    try:
        with open(gate_path, "rb") as gate:
            decision = gate.read(16)
    except OSError:
        sys.exit(1)
    if decision == b"go\n":
        break
    if decision not in (b"",):
        sys.exit(1)
    if time.monotonic() >= deadline:
        sys.exit(1)
    time.sleep(0.01)
try:
    os.unlink(gate_path)
except OSError:
    sys.exit(1)
os.execvp(sys.argv[2], sys.argv[2:])
' "$spawn_gate" node "$watcher_path" monitor "${common_args[@]}" \
      --stop "$stop_path" --failure "$failure_path" --ready "$ready_path" \
      --progress "$progress_path" --final "$final_path" \
      --authority "$authority_path"
  ) &
  started_pid=$!
  started_identity="$(recovery_process_start_identity "$started_pid")" || {
    # The private gate proves that the watcher was never execed, so an identity
    # capture failure can be handled without signalling an untrusted PID.
    printf 'abort\n' >"$spawn_gate" 2>/dev/null || :
    wait "$started_pid" 2>/dev/null || :
    rm -f -- "$spawn_gate"
    return 1
  }
  authority_json="$(recovery_checkpoint_writer_monitor_authority_json \
    "$contract_path" "$contract_sha256" "$baseline_path" "$stop_path" \
    "$failure_path" "$ready_path" "$progress_path" "$final_path" \
    "$started_pid" "$started_identity" "$runtime_generation" \
    "$operation_owner")" || {
    printf 'abort\n' >"$spawn_gate" 2>/dev/null || :
    wait "$started_pid" 2>/dev/null || :
    rm -f -- "$spawn_gate"
    return 1
  }
  if ! recovery_publish_monitor_authority \
      "$authority_path" "$authority_json" authority_sha256; then
    printf 'abort\n' >"$spawn_gate" 2>/dev/null || :
    wait "$started_pid" 2>/dev/null || :
    rm -f -- "$spawn_gate" "$authority_path"
    return 1
  fi
  printf 'go\n' >"$spawn_gate" || {
    recovery_stop_process_group "$started_pid" "$started_identity" || :
    rm -f -- "$spawn_gate" "$authority_path"
    return 1
  }
  printf -v "$pid_variable" '%s' "$started_pid"
  printf -v "$identity_variable" '%s' "$started_identity"
  while [[ "$attempt" -lt 300 ]]; do
    if [[ -s "$failure_path" ]]; then
      recovery_discard_checkpoint_writer_monitor \
        "$stop_path" "$started_pid" "$started_identity"
      rm -f -- "$spawn_gate" "$authority_path"
      printf -v "$pid_variable" '%s' ""
      printf -v "$identity_variable" '%s' ""
      printf 'Checkpoint writer monitor failed before its ready handshake.\n' >&2
      return 1
    fi
    if [[ -s "$ready_path" ]]; then
      ready_value="$(<"$ready_path")"
      if [[ "$ready_value" =~ ^ready:([a-f0-9]{64}):([a-f0-9]{64})$ &&
            -s "$baseline_path" ]]; then
        # BASH_REMATCH is process-global.  Copy the digest before any helper
        # runs another =~ expression and overwrites the capture.
        baseline_sha256="${BASH_REMATCH[1]}"
        ready_authority_sha256="${BASH_REMATCH[2]}"
        if recovery_process_identity_is_live \
            "$started_pid" "$started_identity"; then
          recovery_checkpoint_writer_monitor_file_is_exact \
            "$baseline_path" "$baseline_sha256" 2097152 || break
          if [[ "$ready_authority_sha256" == "$authority_sha256" ]] &&
             recovery_checkpoint_writer_monitor_authority_is_exact \
               "$authority_path" "$authority_sha256" "$contract_path" \
               "$contract_sha256" "$baseline_path" "$stop_path" \
               "$failure_path" "$ready_path" "$progress_path" "$final_path" \
               "$started_pid" "$started_identity" "$runtime_generation" \
               "$operation_owner" &&
             recovery_stream_guard_progress_value \
               "$progress_path" "$authority_sha256" >/dev/null &&
             recovery_checkpoint_writer_monitor_boundary_json \
            "$contract_path" "$contract_sha256" "$baseline_path" \
            "$baseline_sha256" "$runtime_generation" "$operation_owner" >/dev/null &&
             recovery_process_identity_is_live \
               "$started_pid" "$started_identity"; then
            printf -v "$baseline_sha_variable" '%s' "$baseline_sha256"
            rm -f -- "$spawn_gate"
            return 0
          fi
        fi
        break
      fi
      break
    fi
    if ! recovery_process_identity_is_live \
        "$started_pid" "$started_identity"; then
      recovery_discard_checkpoint_writer_monitor \
        "$stop_path" "$started_pid" "$started_identity"
      rm -f -- "$spawn_gate" "$authority_path"
      printf -v "$pid_variable" '%s' ""
      printf -v "$identity_variable" '%s' ""
      printf 'Checkpoint writer monitor exited before its ready handshake.\n' >&2
      return 1
    fi
    sleep 0.05
    attempt=$((attempt + 1))
  done
  recovery_discard_checkpoint_writer_monitor \
    "$stop_path" "$started_pid" "$started_identity"
  rm -f -- "$spawn_gate" "$authority_path"
  printf -v "$pid_variable" '%s' ""
  printf -v "$identity_variable" '%s' ""
  printf -v "$baseline_sha_variable" '%s' ""
  printf 'Checkpoint writer monitor did not complete an exact ready handshake.\n' >&2
  return 1
}

recovery_require_checkpoint_writer_monitor_healthy() {
  local contract_path="$1" contract_sha256="$2" baseline_path="$3"
  local baseline_sha256="$4" failure_path="$5" ready_path="$6" watcher_pid="$7"
  local watcher_identity="$8" runtime_generation="$9" operation_owner="${10}"
  local ready_value authority_path authority_sha256 stop_path progress_path final_path
  [[ "$runtime_generation" =~ ^(durable-v2|legacy-absent)$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" ]] || return 2
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ ]] || return 2
  recovery_runner_watch_marker_is_exact "$failure_path" || return 1
  recovery_runner_watch_marker_is_exact "$ready_path" || return 1
  [[ ! -s "$failure_path" ]] || return 1
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  authority_sha256="$(recovery_monitor_authority_sha256_for_ready \
    "$ready_path")" || return 1
  stop_path="$(jq -er '.paths.stop' "$authority_path")" || return 1
  progress_path="$(jq -er '.paths.progress' "$authority_path")" || return 1
  final_path="$(jq -er '.paths.final' "$authority_path")" || return 1
  recovery_checkpoint_writer_monitor_authority_is_exact \
    "$authority_path" "$authority_sha256" "$contract_path" \
    "$contract_sha256" "$baseline_path" "$stop_path" "$failure_path" \
    "$ready_path" "$progress_path" "$final_path" "$watcher_pid" \
    "$watcher_identity" "$runtime_generation" "$operation_owner" || return 1
  ready_value="$(<"$ready_path")"
  [[ "$ready_value" == "ready:$baseline_sha256:$authority_sha256" ]] || return 1
  recovery_stream_guard_progress_value \
    "$progress_path" "$authority_sha256" >/dev/null || return 1
  recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" || return 1
  recovery_checkpoint_writer_monitor_boundary_json \
    "$contract_path" "$contract_sha256" "$baseline_path" \
    "$baseline_sha256" "$runtime_generation" "$operation_owner" >/dev/null || return 1
  recovery_process_identity_is_live "$watcher_pid" "$watcher_identity"
}

recovery_stop_checkpoint_writer_monitor() {
  local contract_path="$1" contract_sha256="$2" baseline_path="$3"
  local baseline_sha256="$4" stop_path="$5" failure_path="$6"
  local ready_path="$7" final_path="$8" watcher_pid="$9"
  local watcher_identity="${10}" joined_variable="${11}"
  local runtime_generation="${12}"
  local operation_owner="${13}"
  local boundary_json watcher_status=0 ready_value final_json=""
  local joined_state stop_written=0 authority_path authority_sha256 progress_path
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" &&
     "$runtime_generation" =~ ^(durable-v2|legacy-absent)$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" &&
     "$joined_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 2
  joined_state="${!joined_variable}"
  [[ "$joined_state" == 0 || "$joined_state" == ok ||
     "$joined_state" == failed ]] || return 2
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  authority_sha256="$(recovery_monitor_authority_sha256_for_ready \
    "$ready_path")" || return 1
  progress_path="$(jq -er '.paths.progress' "$authority_path")" || return 1
  recovery_checkpoint_writer_monitor_authority_is_exact \
    "$authority_path" "$authority_sha256" "$contract_path" \
    "$contract_sha256" "$baseline_path" "$stop_path" "$failure_path" \
    "$ready_path" "$progress_path" "$final_path" "$watcher_pid" \
    "$watcher_identity" "$runtime_generation" "$operation_owner" \
    "$([[ "$joined_state" == 0 ]] && printf 1 || printf 0)" || return 1
  if [[ "$joined_state" == 0 ]]; then
    if recovery_require_checkpoint_writer_monitor_healthy \
        "$contract_path" "$contract_sha256" "$baseline_path" \
        "$baseline_sha256" "$failure_path" "$ready_path" "$watcher_pid" \
        "$watcher_identity" "$runtime_generation" "$operation_owner" &&
       boundary_json="$(recovery_checkpoint_writer_monitor_boundary_json \
         "$contract_path" "$contract_sha256" "$baseline_path" \
         "$baseline_sha256" "$runtime_generation" "$operation_owner")" &&
       recovery_process_identity_is_live \
         "$watcher_pid" "$watcher_identity"; then
      recovery_signal_no_managed_bot_runner_watch_stop \
        "$stop_path" "$boundary_json" && stop_written=1 || watcher_status=1
    else
      watcher_status=1
      if recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" &&
         recovery_signal_no_managed_bot_runner_watch_stop \
           "$stop_path" discard 2>/dev/null; then
        stop_written=1
      fi
    fi
    if [[ "$stop_written" == 1 ]] &&
       recovery_wait_isolated_process_bounded \
         "$watcher_pid" "$watcher_identity" "$stop_path"; then
      printf -v "$joined_variable" '%s' ok
      joined_state=ok
    else
      if [[ "$stop_written" != 1 ]]; then
        recovery_stop_process_group \
          "$watcher_pid" "$watcher_identity" || :
      fi
      printf -v "$joined_variable" '%s' failed
      joined_state=failed
      watcher_status=1
    fi
  else
    [[ "$joined_state" == ok ]] || watcher_status=1
  fi
  recovery_runner_watch_marker_is_exact "$failure_path" || watcher_status=1
  recovery_runner_watch_marker_is_exact "$ready_path" || watcher_status=1
  recovery_runner_watch_marker_is_exact "$final_path" || watcher_status=1
  [[ ! -s "$failure_path" ]] || watcher_status=1
  if [[ -f "$ready_path" ]]; then ready_value="$(<"$ready_path")"; fi
  [[ "$ready_value" == "ready:$baseline_sha256:$authority_sha256" ]] || watcher_status=1
  recovery_stream_guard_progress_value \
    "$progress_path" "$authority_sha256" >/dev/null || watcher_status=1
  if [[ -f "$final_path" ]]; then final_json="$(<"$final_path")"; fi
  recovery_checkpoint_writer_monitor_final_json_is_acceptable \
    "$final_json" "$contract_path" "$authority_sha256" || watcher_status=1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$contract_path" "$contract_sha256" 131072 || watcher_status=1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$baseline_path" "$baseline_sha256" 2097152 || watcher_status=1
  recovery_require_operation_serialization || watcher_status=1
  recovery_require_operation_lock || watcher_status=1
  [[ "$watcher_status" == 0 ]]
}

recovery_discard_checkpoint_writer_monitor() {
  local stop_path="$1" watcher_pid="$2" watcher_identity="$3"
  local wait_status=0
  if [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" ]] &&
     recovery_process_identity_is_live "$watcher_pid" "$watcher_identity"; then
    if recovery_signal_no_managed_bot_runner_watch_stop \
        "$stop_path" discard 2>/dev/null; then
      recovery_wait_isolated_process_bounded \
        "$watcher_pid" "$watcher_identity" "$stop_path" 2>/dev/null || :
    else
      recovery_stop_process_group \
        "$watcher_pid" "$watcher_identity" || :
    fi
  elif [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" ]] &&
       ! kill -0 "$watcher_pid" 2>/dev/null; then
    # Reap a fast pre-ready exit, then revoke only descendants that still
    # retain its isolated PGID. Never signal a positive PID after reuse.
    if wait "$watcher_pid" 2>/dev/null; then wait_status=0; else wait_status=$?; fi
    if [[ "$wait_status" != 127 ]] && ! kill -0 "$watcher_pid" 2>/dev/null; then
      recovery_stop_reaped_isolated_process_group "$watcher_pid"
    fi
  fi
}

# The durable-v2 watcher consumes the immutable runner-fence baseline and the
# schema-3 writer control baseline produced immediately before it. Its positive
# markers bind both byte digests plus a third digest over the complete local
# authority identity, preventing a ready marker from being replayed across
# operations, owners, Leases or admission-fence transitions.
recovery_sha256_bytes() {
  local output
  if command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256)" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum)" || return 1
  else
    return 127
  fi
  output="${output%%[[:space:]]*}"
  # Both supported tools emit lowercase hexadecimal. Keep the stricter
  # contract here rather than relying on Bash 4's ${var,,}, because macOS
  # still ships Bash 3.2 and the recovery tooling must run there too.
  [[ "$output" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "$output"
}

recovery_durable_runner_monitor_control_capability_sha256() {
  local control_baseline_path="$1" control_baseline_sha256="$2"
  local durable_baseline_sha256="$3" operation_owner="$4"
  local capability_json
  [[ "$durable_baseline_sha256" =~ ^[a-f0-9]{64}$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" ]] || return 2
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$control_baseline_path" "$control_baseline_sha256" 2097152 || return 1
  jq -e \
    --arg context "$EXPECTED_KUBE_CONTEXT" --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$operation_owner" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" '
    (keys | sort) == ["boundaries","consumers","context","deployments",
      "lease","namespace","namespace_uid","operation_id","operation_lock",
      "operation_owner","pods","recovery_operation_fence","replica_sets",
      "runtime_generation","schema_version","storage_helper"] and
    .schema_version == 3 and .runtime_generation == "durable-v2" and
    .context == $context and .namespace == $namespace and
    .namespace_uid == $namespace_uid and .operation_id == $operation_id and
    .operation_owner == $operation_owner and
    .operation_lock == {name:$lock_name,uid:$lock_uid,resource_version:$lock_rv} and
    .lease.name == $lease_name and .lease.uid == $lease_uid and
    .lease.holder == $lease_holder and
    (.lease.acquire_time | type == "string" and length > 0) and
    (.lease.lease_transitions | type == "number" and floor == . and . >= 0) and
    (.recovery_operation_fence | keys | sort) == ["binding","namespaces","policy"] and
    (.recovery_operation_fence.namespaces | keys | sort) == ["parent","runner"] and
    .recovery_operation_fence.namespaces.parent.name == $namespace and
    .recovery_operation_fence.namespaces.parent.uid == $namespace_uid and
    .recovery_operation_fence.namespaces.runner.name == "hcce-bot-runners" and
    all(.recovery_operation_fence.namespaces[];
      .phase == "Active" and .metadata_name_label == .name and
      (.uid | type == "string" and length > 0) and
      (.resource_version | type == "string" and length > 0)) and
    (.recovery_operation_fence.policy | keys | sort) ==
      ["generation","resource_version","spec_sha256","uid"] and
    (.recovery_operation_fence.policy.generation | type == "number" and
      floor == . and . > 0) and
    (.recovery_operation_fence.policy.spec_sha256 |
      type == "string" and test("^[a-f0-9]{64}$")) and
    (.recovery_operation_fence.binding | keys | sort) ==
      ["resource_version","spec_sha256","uid"] and
    (.recovery_operation_fence.binding.spec_sha256 |
      type == "string" and test("^[a-f0-9]{64}$")) and
    all(.recovery_operation_fence.policy.uid,
      .recovery_operation_fence.policy.resource_version,
      .recovery_operation_fence.binding.uid,
      .recovery_operation_fence.binding.resource_version;
      type == "string" and length > 0)
  ' "$control_baseline_path" >/dev/null || return 1
  capability_json="$(jq -cS \
    --arg durable_sha "$durable_baseline_sha256" \
    --arg control_sha "$control_baseline_sha256" '
    {schema_version:1,context:.context,
     parent_namespace:.recovery_operation_fence.namespaces.parent,
     runner_namespace:.recovery_operation_fence.namespaces.runner,
     operation_id:.operation_id,operation_owner:.operation_owner,
     operation_lock:.operation_lock,lease:.lease,
     policy:.recovery_operation_fence.policy,
     binding:.recovery_operation_fence.binding,
     durable_fence_baseline_sha256:$durable_sha,
     control_baseline_sha256:$control_sha}
  ' "$control_baseline_path")" || return 1
  printf '%s' "$capability_json" | recovery_sha256_bytes
}

recovery_durable_runner_monitor_authority_json() {
  local durable_baseline_path="$1" durable_baseline_sha256="$2"
  local control_baseline_path="$3" control_baseline_sha256="$4"
  local stop_path="$5" failure_path="$6" ready_path="$7" progress_path="$8"
  local final_path="$9" watcher_pid="${10}" watcher_identity="${11}"
  local control_capability_sha256="${12}" operation_owner="${13}"
  local authority_path
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  [[ "$durable_baseline_sha256" =~ ^[a-f0-9]{64}$ &&
     "$control_baseline_sha256" =~ ^[a-f0-9]{64}$ &&
     "$control_capability_sha256" =~ ^[a-f0-9]{64}$ &&
     "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" ]] || return 2
  jq -cnS \
    --arg kind durable-runner-quiescence-monitor --argjson pid "$watcher_pid" \
    --arg start_identity "$watcher_identity" \
    --arg context "$EXPECTED_KUBE_CONTEXT" --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg operation_owner "$operation_owner" --arg runtime_generation durable-v2 \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg lock_rv "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" \
    --arg lease_name "$RECOVERY_SERIALIZATION_LEASE_NAME" \
    --arg lease_uid "$RECOVERY_SERIALIZATION_LEASE_UID" \
    --arg lease_holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
    --arg authority "$authority_path" \
    --arg durable_baseline "$durable_baseline_path" \
    --arg control_baseline "$control_baseline_path" --arg stop "$stop_path" \
    --arg failure "$failure_path" --arg ready "$ready_path" \
    --arg progress "$progress_path" --arg final "$final_path" \
    --arg durable_sha256 "$durable_baseline_sha256" \
    --arg control_sha256 "$control_baseline_sha256" \
    --arg control_capability_sha256 "$control_capability_sha256" '
    {schema_version:1,kind:$kind,pid:$pid,start_identity:$start_identity,
     context:$context,namespace:$namespace,namespace_uid:$namespace_uid,
     operation_id:$operation_id,operation_owner:$operation_owner,
     runtime_generation:$runtime_generation,
     operation_lock:{name:$lock_name,uid:$lock_uid,resource_version:$lock_rv},
     lease:{name:$lease_name,uid:$lease_uid,holder:$lease_holder},
     paths:{authority:$authority,durable_baseline:$durable_baseline,
       control_baseline:$control_baseline,stop:$stop,failure:$failure,
       ready:$ready,progress:$progress,final:$final},
     hashes:{durable_baseline_sha256:$durable_sha256,
       control_baseline_sha256:$control_sha256,
       control_capability_sha256:$control_capability_sha256}}
  '
}

recovery_durable_runner_monitor_authority_is_exact() {
  local authority_path="$1" authority_sha256="$2"
  local durable_baseline_path="$3" durable_baseline_sha256="$4"
  local control_baseline_path="$5" control_baseline_sha256="$6"
  local stop_path="$7" failure_path="$8" ready_path="$9"
  local progress_path="${10}" final_path="${11}" watcher_pid="${12}"
  local watcher_identity="${13}" control_capability_sha256="${14}"
  local operation_owner="${15}" require_live="${16:-1}" expected_json
  [[ "$require_live" == 0 || "$require_live" == 1 ]] || return 2
  if [[ "$require_live" == 1 ]]; then
    recovery_monitor_authority_common_is_exact \
      "$authority_path" "$authority_sha256" \
      durable-runner-quiescence-monitor "$watcher_pid" "$watcher_identity" \
      "$failure_path" "$ready_path" "$progress_path" || return 1
  else
    recovery_checkpoint_writer_monitor_file_is_exact \
      "$authority_path" "$authority_sha256" 65536 || return 1
  fi
  expected_json="$(recovery_durable_runner_monitor_authority_json \
    "$durable_baseline_path" "$durable_baseline_sha256" \
    "$control_baseline_path" "$control_baseline_sha256" "$stop_path" \
    "$failure_path" "$ready_path" "$progress_path" "$final_path" \
    "$watcher_pid" "$watcher_identity" "$control_capability_sha256" \
    "$operation_owner")" || return 1
  [[ "$(<"$authority_path")" == "$expected_json" ]]
}

recovery_durable_runner_monitor_positive_marker() {
  local durable_baseline_sha256="$1" control_baseline_sha256="$2"
  local capability_sha256="$3" authority_sha256="${4:-}"
  [[ "$durable_baseline_sha256" =~ ^[a-f0-9]{64}$ &&
     "$control_baseline_sha256" =~ ^[a-f0-9]{64}$ &&
     "$capability_sha256" =~ ^[a-f0-9]{64}$ &&
     "$authority_sha256" =~ ^[a-f0-9]{64}$ ]] || return 2
  printf '%s:%s:%s:%s\n' "$durable_baseline_sha256" \
    "$control_baseline_sha256" "$capability_sha256" "$authority_sha256"
}

recovery_durable_runner_monitor_kubectl_bin() {
  recovery_checkpoint_writer_monitor_kubectl_bin
}

recovery_signal_durable_runner_quiescence_monitor() {
  local stop_path="$1" action="$2"
  recovery_runner_watch_marker_is_exact "$stop_path" || return 1
  case "$action" in
    stop|discard) printf '%s\n' "$action" >"$stop_path" ;;
    *) return 2 ;;
  esac
}

recovery_start_durable_runner_quiescence_monitor() {
  local durable_baseline_path="$1" durable_baseline_sha256="$2"
  local control_baseline_path="$3" control_baseline_sha256="$4"
  local stop_path="$5" failure_path="$6" ready_path="$7"
  local progress_path="$8" final_path="$9" pid_variable="${10}"
  local identity_variable="${11}" capability_variable="${12}"
  local operation_owner="${13}"
  local watcher_path watcher_kubectl_bin marker_path spawn_gate=""
  local started_pid="" started_identity="" expected_capability=""
  local expected_marker="" ready_value="" attempt=0 watcher_test_mode=""
  local authority_path authority_json authority_sha256=""
  watcher_path="$(cd "$RECOVERY_SAFETY_DIR/.." && pwd -P)/watch-durable-runner-quiescence.mjs" ||
    return 1
  [[ "$pid_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$identity_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$capability_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$pid_variable" != "$identity_variable" &&
     "$pid_variable" != "$capability_variable" &&
     "$identity_variable" != "$capability_variable" &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" ]] || return 2
  [[ "$stop_path" != "$failure_path" && "$stop_path" != "$ready_path" &&
     "$stop_path" != "$progress_path" && "$stop_path" != "$final_path" &&
     "$failure_path" != "$ready_path" && "$failure_path" != "$progress_path" &&
     "$failure_path" != "$final_path" && "$ready_path" != "$progress_path" &&
     "$ready_path" != "$final_path" && "$progress_path" != "$final_path" &&
     "$durable_baseline_path" != "$control_baseline_path" ]] || return 2
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  [[ "$authority_path" != "$durable_baseline_path" &&
     "$authority_path" != "$control_baseline_path" &&
     "$authority_path" != "$stop_path" &&
     "$authority_path" != "$failure_path" &&
     "$authority_path" != "$ready_path" &&
     "$authority_path" != "$progress_path" &&
     "$authority_path" != "$final_path" &&
     ! -e "$authority_path" && ! -L "$authority_path" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$durable_baseline_path" "$durable_baseline_sha256" 1048576 || return 1
  recovery_require_checkpoint_runner_quiescence_exact \
    durable-v2 "$durable_baseline_path" "$durable_baseline_sha256" || return 1
  expected_capability="$(
    recovery_durable_runner_monitor_control_capability_sha256 \
      "$control_baseline_path" "$control_baseline_sha256" \
      "$durable_baseline_sha256" "$operation_owner"
  )" || return 1
  for marker_path in "$stop_path" "$failure_path" "$ready_path" \
    "$progress_path" "$final_path"; do
    recovery_runner_watch_marker_is_exact "$marker_path" || return 1
    [[ ! -s "$marker_path" ]] || return 1
  done
  recovery_require_regular_direct_file "$watcher_path" || return 1
  command -v python3 >/dev/null 2>&1 || return 127
  watcher_kubectl_bin="$(recovery_durable_runner_monitor_kubectl_bin)" || return 1
  # shellcheck disable=SC2031 # Prior fixture exports occur only in child subshells.
  if [[ "${YENHUBS_RECOVERY_TEST_MODE:-}" == local-fixture ]]; then
    recovery_require_local_fixture_attestation || return 1
    watcher_test_mode=local-fixture
  fi
  spawn_gate="$(mktemp \
    "$(dirname "$stop_path")/.durable-runner-monitor-spawn-gate.XXXXXX")" ||
    return 1
  chmod 600 "$spawn_gate" || {
    rm -f -- "$spawn_gate"
    return 1
  }
  (
    unset KUBECTL_BIN YENHUBS_RECOVERY_TEST_MODE
    if [[ "$watcher_test_mode" == local-fixture ]]; then
      # shellcheck disable=SC2031 # This export is intentionally child-local.
      export YENHUBS_RECOVERY_TEST_MODE=local-fixture
    fi
    exec env KUBECTL_BIN="$watcher_kubectl_bin" python3 -I -c '
import os
import sys
import time
os.setsid()
gate_path = sys.argv[1]
deadline = time.monotonic() + 5
while True:
    try:
        with open(gate_path, "rb") as gate:
            decision = gate.read(16)
    except OSError:
        sys.exit(1)
    if decision == b"go\n":
        break
    if decision not in (b"",):
        sys.exit(1)
    if time.monotonic() >= deadline:
        sys.exit(1)
    time.sleep(0.01)
try:
    os.unlink(gate_path)
except OSError:
    sys.exit(1)
os.execvp(sys.argv[2], sys.argv[2:])
' "$spawn_gate" node "$watcher_path" \
      --context "$EXPECTED_KUBE_CONTEXT" --namespace "$NAMESPACE" \
      --runner-namespace hcce-bot-runners \
      --baseline "$durable_baseline_path" \
      --baseline-sha256 "$durable_baseline_sha256" \
      --control-baseline "$control_baseline_path" \
      --control-baseline-sha256 "$control_baseline_sha256" \
      --stop "$stop_path" --failure "$failure_path" --ready "$ready_path" \
      --progress "$progress_path" --final "$final_path" \
      --authority "$authority_path"
  ) &
  started_pid=$!
  started_identity="$(recovery_process_start_identity "$started_pid")" || {
    printf 'abort\n' >"$spawn_gate" 2>/dev/null || :
    wait "$started_pid" 2>/dev/null || :
    rm -f -- "$spawn_gate"
    return 1
  }
  authority_json="$(recovery_durable_runner_monitor_authority_json \
    "$durable_baseline_path" "$durable_baseline_sha256" \
    "$control_baseline_path" "$control_baseline_sha256" "$stop_path" \
    "$failure_path" "$ready_path" "$progress_path" "$final_path" \
    "$started_pid" "$started_identity" "$expected_capability" \
    "$operation_owner")" || {
    printf 'abort\n' >"$spawn_gate" 2>/dev/null || :
    wait "$started_pid" 2>/dev/null || :
    rm -f -- "$spawn_gate"
    return 1
  }
  if ! recovery_publish_monitor_authority \
      "$authority_path" "$authority_json" authority_sha256; then
    printf 'abort\n' >"$spawn_gate" 2>/dev/null || :
    wait "$started_pid" 2>/dev/null || :
    rm -f -- "$spawn_gate" "$authority_path"
    return 1
  fi
  expected_marker="$(recovery_durable_runner_monitor_positive_marker \
    "$durable_baseline_sha256" "$control_baseline_sha256" \
    "$expected_capability" "$authority_sha256")" || {
    printf 'abort\n' >"$spawn_gate" 2>/dev/null || :
    wait "$started_pid" 2>/dev/null || :
    rm -f -- "$spawn_gate" "$authority_path"
    return 1
  }
  printf 'go\n' >"$spawn_gate" || {
    recovery_stop_process_group "$started_pid" "$started_identity" || :
    rm -f -- "$spawn_gate" "$authority_path"
    return 1
  }
  printf -v "$pid_variable" '%s' "$started_pid"
  printf -v "$identity_variable" '%s' "$started_identity"
  while [[ "$attempt" -lt 400 ]]; do
    if [[ -s "$failure_path" ]]; then
      recovery_discard_durable_runner_quiescence_monitor \
        "$stop_path" "$started_pid" "$started_identity"
      rm -f -- "$authority_path"
      printf -v "$pid_variable" '%s' ''
      printf -v "$identity_variable" '%s' ''
      printf -v "$capability_variable" '%s' ''
      printf 'Durable runner quiescence monitor failed before its ready handshake.\n' >&2
      return 1
    fi
    if [[ -s "$ready_path" ]]; then
      ready_value="$(<"$ready_path")"
      if [[ "$ready_value" == "ready:$expected_marker" ]] &&
         recovery_durable_runner_monitor_authority_is_exact \
           "$authority_path" "$authority_sha256" "$durable_baseline_path" \
           "$durable_baseline_sha256" "$control_baseline_path" \
           "$control_baseline_sha256" "$stop_path" "$failure_path" \
           "$ready_path" "$progress_path" "$final_path" "$started_pid" \
           "$started_identity" "$expected_capability" "$operation_owner" &&
         recovery_stream_guard_progress_value \
           "$progress_path" "$authority_sha256" >/dev/null &&
         recovery_process_identity_is_live \
           "$started_pid" "$started_identity" &&
         recovery_require_operation_serialization &&
         recovery_require_operation_lock; then
        printf -v "$capability_variable" '%s' "$expected_capability"
        rm -f -- "$spawn_gate"
        return 0
      fi
      break
    fi
    if ! recovery_process_identity_is_live \
        "$started_pid" "$started_identity"; then
      recovery_discard_durable_runner_quiescence_monitor \
        "$stop_path" "$started_pid" "$started_identity"
      rm -f -- "$authority_path"
      printf -v "$pid_variable" '%s' ''
      printf -v "$identity_variable" '%s' ''
      printf -v "$capability_variable" '%s' ''
      printf 'Durable runner quiescence monitor exited before its ready handshake.\n' >&2
      return 1
    fi
    sleep 0.05
    attempt=$((attempt + 1))
  done
  recovery_discard_durable_runner_quiescence_monitor \
    "$stop_path" "$started_pid" "$started_identity"
  rm -f -- "$spawn_gate" "$authority_path"
  printf -v "$pid_variable" '%s' ''
  printf -v "$identity_variable" '%s' ''
  printf -v "$capability_variable" '%s' ''
  printf 'Durable runner quiescence monitor did not complete its exact capability handshake.\n' >&2
  return 1
}

recovery_require_durable_runner_quiescence_monitor_healthy() {
  local durable_baseline_path="$1" durable_baseline_sha256="$2"
  local control_baseline_path="$3" control_baseline_sha256="$4"
  local failure_path="$5" ready_path="$6" progress_path="$7"
  local watcher_pid="$8" watcher_identity="$9" capability_sha256="${10}"
  local operation_owner="${11}" expected_capability expected_marker ready_value
  local authority_path authority_sha256 stop_path final_path
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" &&
     "$capability_sha256" =~ ^[a-f0-9]{64}$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" ]] || return 2
  recovery_runner_watch_marker_is_exact "$failure_path" || return 1
  recovery_runner_watch_marker_is_exact "$ready_path" || return 1
  recovery_runner_watch_marker_is_exact "$progress_path" || return 1
  [[ ! -s "$failure_path" ]] || return 1
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  authority_sha256="$(recovery_monitor_authority_sha256_for_ready \
    "$ready_path")" || return 1
  stop_path="$(jq -er '.paths.stop' "$authority_path")" || return 1
  final_path="$(jq -er '.paths.final' "$authority_path")" || return 1
  expected_capability="$(
    recovery_durable_runner_monitor_control_capability_sha256 \
      "$control_baseline_path" "$control_baseline_sha256" \
      "$durable_baseline_sha256" "$operation_owner"
  )" || return 1
  [[ "$expected_capability" == "$capability_sha256" ]] || return 1
  recovery_durable_runner_monitor_authority_is_exact \
    "$authority_path" "$authority_sha256" "$durable_baseline_path" \
    "$durable_baseline_sha256" "$control_baseline_path" \
    "$control_baseline_sha256" "$stop_path" "$failure_path" "$ready_path" \
    "$progress_path" "$final_path" "$watcher_pid" "$watcher_identity" \
    "$capability_sha256" "$operation_owner" || return 1
  expected_marker="$(recovery_durable_runner_monitor_positive_marker \
    "$durable_baseline_sha256" "$control_baseline_sha256" \
    "$capability_sha256" "$authority_sha256")" || return 1
  ready_value="$(<"$ready_path")"
  [[ "$ready_value" == "ready:$expected_marker" ]] || return 1
  recovery_stream_guard_progress_value \
    "$progress_path" "$authority_sha256" >/dev/null || return 1
  recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$durable_baseline_path" "$durable_baseline_sha256" 1048576 || return 1
  recovery_require_checkpoint_runner_quiescence_exact \
    durable-v2 "$durable_baseline_path" "$durable_baseline_sha256" || return 1
  recovery_process_identity_is_live "$watcher_pid" "$watcher_identity"
}

recovery_stop_durable_runner_quiescence_monitor() {
  local durable_baseline_path="$1" durable_baseline_sha256="$2"
  local control_baseline_path="$3" control_baseline_sha256="$4"
  local stop_path="$5" failure_path="$6" ready_path="$7"
  local progress_path="$8" final_path="$9" watcher_pid="${10}"
  local watcher_identity="${11}" capability_sha256="${12}"
  local joined_variable="${13}" operation_owner="${14}"
  local joined_state watcher_status=0 stop_written=0
  local expected_marker ready_value="" final_value=""
  local authority_path authority_sha256
  [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" &&
     "$capability_sha256" =~ ^[a-f0-9]{64}$ &&
     "$joined_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$operation_owner" =~ ^(checkpoint-backup|checkpoint-restore)$ &&
     "$operation_owner" == "${RECOVERY_OPERATION_OWNER:-}" ]] || return 2
  joined_state="${!joined_variable}"
  [[ "$joined_state" == 0 || "$joined_state" == ok ||
     "$joined_state" == failed ]] || return 2
  authority_path="$(recovery_monitor_authority_path "$ready_path")" || return 1
  authority_sha256="$(recovery_monitor_authority_sha256_for_ready \
    "$ready_path")" || return 1
  recovery_durable_runner_monitor_authority_is_exact \
    "$authority_path" "$authority_sha256" "$durable_baseline_path" \
    "$durable_baseline_sha256" "$control_baseline_path" \
    "$control_baseline_sha256" "$stop_path" "$failure_path" "$ready_path" \
    "$progress_path" "$final_path" "$watcher_pid" "$watcher_identity" \
    "$capability_sha256" "$operation_owner" \
    "$([[ "$joined_state" == 0 ]] && printf 1 || printf 0)" || return 1
  expected_marker="$(recovery_durable_runner_monitor_positive_marker \
    "$durable_baseline_sha256" "$control_baseline_sha256" \
    "$capability_sha256" "$authority_sha256")" || return 1
  if [[ "$joined_state" == 0 ]]; then
    if recovery_require_durable_runner_quiescence_monitor_healthy \
        "$durable_baseline_path" "$durable_baseline_sha256" \
        "$control_baseline_path" "$control_baseline_sha256" \
        "$failure_path" "$ready_path" "$progress_path" "$watcher_pid" \
        "$watcher_identity" "$capability_sha256" "$operation_owner" &&
       recovery_signal_durable_runner_quiescence_monitor "$stop_path" stop; then
      stop_written=1
    else
      watcher_status=1
      if recovery_process_identity_is_live "$watcher_pid" "$watcher_identity" &&
         recovery_signal_durable_runner_quiescence_monitor \
           "$stop_path" discard 2>/dev/null; then
        stop_written=1
      fi
    fi
    if [[ "$stop_written" == 1 ]] &&
       recovery_wait_isolated_process_bounded \
         "$watcher_pid" "$watcher_identity" "$stop_path"; then
      printf -v "$joined_variable" '%s' ok
      joined_state=ok
    else
      if [[ "$stop_written" != 1 ]]; then
        recovery_stop_process_group "$watcher_pid" "$watcher_identity" || :
      fi
      printf -v "$joined_variable" '%s' failed
      joined_state=failed
      watcher_status=1
    fi
  else
    [[ "$joined_state" == ok ]] || watcher_status=1
  fi
  for marker_path in "$failure_path" "$ready_path" "$progress_path" \
    "$final_path"; do
    recovery_runner_watch_marker_is_exact "$marker_path" || watcher_status=1
  done
  [[ ! -s "$failure_path" ]] || watcher_status=1
  [[ -f "$ready_path" ]] && ready_value="$(<"$ready_path")"
  [[ -f "$final_path" ]] && final_value="$(<"$final_path")"
  [[ "$ready_value" == "ready:$expected_marker" ]] || watcher_status=1
  [[ "$final_value" == "complete:$expected_marker" ]] || watcher_status=1
  recovery_stream_guard_progress_value \
    "$progress_path" "$authority_sha256" >/dev/null || watcher_status=1
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$durable_baseline_path" "$durable_baseline_sha256" 1048576 || watcher_status=1
  [[ "$(recovery_durable_runner_monitor_control_capability_sha256 \
      "$control_baseline_path" "$control_baseline_sha256" \
      "$durable_baseline_sha256" "$operation_owner" 2>/dev/null || :)" == \
     "$capability_sha256" ]] || watcher_status=1
  recovery_require_operation_serialization || watcher_status=1
  recovery_require_operation_lock || watcher_status=1
  recovery_require_checkpoint_runner_quiescence_exact \
    durable-v2 "$durable_baseline_path" "$durable_baseline_sha256" ||
    watcher_status=1
  [[ "$watcher_status" == 0 ]]
}

recovery_discard_durable_runner_quiescence_monitor() {
  local stop_path="$1" watcher_pid="$2" watcher_identity="$3"
  local wait_status=0
  if [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" ]] &&
     recovery_process_identity_is_live "$watcher_pid" "$watcher_identity"; then
    if recovery_signal_durable_runner_quiescence_monitor \
        "$stop_path" discard 2>/dev/null; then
      recovery_wait_isolated_process_bounded \
        "$watcher_pid" "$watcher_identity" "$stop_path" 2>/dev/null || :
    else
      recovery_stop_process_group "$watcher_pid" "$watcher_identity" || :
    fi
  elif [[ "$watcher_pid" =~ ^[1-9][0-9]*$ && -n "$watcher_identity" ]] &&
       ! kill -0 "$watcher_pid" 2>/dev/null; then
    if wait "$watcher_pid" 2>/dev/null; then wait_status=0; else wait_status=$?; fi
    if [[ "$wait_status" != 127 ]] && ! kill -0 "$watcher_pid" 2>/dev/null; then
      recovery_stop_reaped_isolated_process_group "$watcher_pid"
    fi
  fi
}

recovery_wait_for_no_pods() {
  local selector="$1"
  local description="$2"
  local timeout="${3:-180s}"
  local remaining

  remaining="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l "$selector" -o name
  )" || {
    printf 'Could not inspect %s pods before waiting; refusing further mutation.\n' \
      "$description" >&2
    return 1
  }
  if [[ -z "$remaining" ]]; then
    return 0
  fi

  if ! recovery_kubectl_wait_bounded "${timeout%s}" \
    wait --for=delete pod -n "$NAMESPACE" -l "$selector"; then
    printf 'Timed out waiting for %s pods to stop; refusing further mutation.\n' \
      "$description" >&2
    return 1
  fi

  remaining="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l "$selector" -o name
  )" || {
    printf 'Could not verify that %s pods stopped; refusing further mutation.\n' \
      "$description" >&2
    return 1
  }
  if [[ -n "$remaining" ]]; then
    printf 'Pods still remain for %s; refusing further mutation:\n%s\n' \
      "$description" "$remaining" >&2
    return 1
  fi
}

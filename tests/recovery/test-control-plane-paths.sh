#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
source "$ROOT/deployment/lib/recovery-safety.sh"
TMP="$(mktemp -d)"
trap 'rm -f "$TMP/paths" "$TMP/link"; rmdir "$TMP"' EXIT
original_guard="$(declare -f recovery_require_regular_direct_file)"
eval "${original_guard/recovery_require_regular_direct_file/original_direct_file_guard}"
recovery_private_values_file_is_acceptable() { return 0; }
recovery_require_regular_direct_file() {
  printf '%s\n' "$1" >> "$TMP/paths"
  original_direct_file_guard "$1"
}
# Stop before any live read: this test only exercises path construction.
recovery_require_live_runner_recovery_phase() { return 99; }
export EXPECTED_KUBE_CONTEXT=path-test
export HCCE_MANIFEST_PATH="$ROOT/README.md"
status=0
recovery_require_live_runner_active_control_plane_exact unused || status=$?
[[ "$status" == 1 && "$(wc -l < "$TMP/paths" | tr -d ' ')" == 3 ]]
if grep -F '/..' "$TMP/paths"; then exit 1; fi
ln -s "$ROOT/README.md" "$TMP/link"
if original_direct_file_guard "$TMP/link"; then exit 1; fi
if original_direct_file_guard "$ROOT/deployment/../README.md"; then exit 1; fi
printf 'PASS: real verifier paths accepted; symlinks and traversal still rejected.\n'

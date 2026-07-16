#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=deployment/lib/reactivation-gate-functions.sh
# shellcheck disable=SC1091
# The dynamic source path is resolved relative to the repository at runtime.
source "$ROOT_DIR/deployment/lib/reactivation-gate-functions.sh"

test_count=0
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-security-gates.XXXXXX")"
cleanup() {
  rm -rf -- "$temp_root"
}
trap cleanup EXIT INT TERM

pass_test() {
  test_count=$((test_count + 1))
  printf 'PASS  %s\n' "$1"
}

fail_test() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

if reactivation_live_result_is_clean 0 0 &&
  ! reactivation_live_result_is_clean 1 0 &&
  ! reactivation_live_result_is_clean 0 1 &&
  ! reactivation_live_result_is_clean 1 1; then
  pass_test "live acceptance requires zero failures and zero warnings"
else
  fail_test "live acceptance status matrix"
fi

mode_file="$temp_root/values.yaml"
: >"$mode_file"
chmod 600 "$mode_file"
reactivation_values_file_is_private "$mode_file" || fail_test "mode 600 accepted"
chmod 640 "$mode_file"
if reactivation_values_file_is_private "$mode_file"; then
  fail_test "mode 640 rejected"
fi
pass_test "local values mode must be exactly 600"

exit_temp="$temp_root/cleanup-on-exit"
bash -c '
  set -euo pipefail
  source "$1"
  reactivation_install_cleanup_traps
  : >"$2"
  reactivation_register_temp_path "$2"
' _ "$ROOT_DIR/deployment/lib/reactivation-gate-functions.sh" "$exit_temp"
[[ ! -e "$exit_temp" ]] || fail_test "cleanup on EXIT"
pass_test "registered temporary file is removed on EXIT"

for signal_spec in "130:INT" "143:TERM"; do
  signal_code="${signal_spec%%:*}"
  signal_name="${signal_spec#*:}"
  signal_temp="$temp_root/cleanup-on-${signal_name}"
  set +e
  bash -c '
    set -euo pipefail
    source "$1"
    reactivation_install_cleanup_traps
    : >"$2"
    reactivation_register_temp_path "$2"
    kill -s "$3" "$$"
    exit 99
  ' _ "$ROOT_DIR/deployment/lib/reactivation-gate-functions.sh" "$signal_temp" "$signal_name"
  signal_status=$?
  set -e
  [[ "$signal_status" == "$signal_code" ]] || fail_test "$signal_name exit status"
  [[ ! -e "$signal_temp" ]] || fail_test "cleanup on $signal_name"
done
pass_test "registered temporary files are removed on INT and TERM"

range_repo="$temp_root/range-repo"
mkdir -p "$range_repo"
git -C "$range_repo" init -q
git -C "$range_repo" config user.name "Gate Test"
git -C "$range_repo" config user.email "gate-test@example.invalid"
printf 'first\n' >"$range_repo/file.txt"
git -C "$range_repo" add file.txt
git -C "$range_repo" commit -qm first
first_revision="$(git -C "$range_repo" rev-parse HEAD)"
first_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" workflow_dispatch "" "" "$first_revision"
)"
[[ "$first_range" == "$first_revision" ]] || fail_test "root commit scan range"

printf 'second\n' >>"$range_repo/file.txt"
git -C "$range_repo" commit -qam second
second_revision="$(git -C "$range_repo" rev-parse HEAD)"
push_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" push "" "$first_revision" "$second_revision"
)"
pr_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" pull_request "$first_revision" "" "$second_revision"
)"
fallback_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" workflow_dispatch "" "" "$second_revision"
)"
expected_range="$first_revision..$second_revision"
[[ "$push_range" == "$expected_range" ]] || fail_test "push scan range"
[[ "$pr_range" == "$expected_range" ]] || fail_test "pull request scan range"
[[ "$fallback_range" == "$expected_range" ]] || fail_test "fallback scan range"
pass_test "Git range selection covers every introduced commit"

sub_repo="$temp_root/sub-repo"
super_repo="$temp_root/super-repo"
mkdir -p "$sub_repo" "$super_repo"
git -C "$sub_repo" init -q
git -C "$sub_repo" config user.name "Gate Test"
git -C "$sub_repo" config user.email "gate-test@example.invalid"
printf 'pinned\n' >"$sub_repo/file.txt"
git -C "$sub_repo" add file.txt
git -C "$sub_repo" commit -qm pinned

git -C "$super_repo" init -q
git -C "$super_repo" config user.name "Gate Test"
git -C "$super_repo" config user.email "gate-test@example.invalid"
printf 'root\n' >"$super_repo/README.md"
git -C "$super_repo" add README.md
git -C "$super_repo" commit -qm root
git -C "$super_repo" -c protocol.file.allow=always submodule add -q "$sub_repo" modules/demo
git -C "$super_repo" commit -qam "pin submodule"
bash "$ROOT_DIR/scripts/verify-gitlinks.sh" "$super_repo" >/dev/null ||
  fail_test "valid gitlink accepted"

printf 'newer\n' >>"$sub_repo/file.txt"
git -C "$sub_repo" commit -qam newer
newer_revision="$(git -C "$sub_repo" rev-parse HEAD)"
git -C "$super_repo/modules/demo" fetch -q
git -C "$super_repo/modules/demo" checkout -q "$newer_revision"
if bash "$ROOT_DIR/scripts/verify-gitlinks.sh" "$super_repo" >/dev/null 2>&1; then
  fail_test "mismatched gitlink rejected"
fi
git -C "$super_repo/modules/demo" checkout -q "$(git -C "$super_repo" ls-tree HEAD modules/demo | awk '{print $3}')"
git -C "$super_repo" submodule deinit -q -f modules/demo
mkdir -p "$super_repo/modules/demo"
if bash "$ROOT_DIR/scripts/verify-gitlinks.sh" "$super_repo" >/dev/null 2>&1; then
  fail_test "uninitialized gitlink rejected"
fi
pass_test "gitlink verifier accepts exact pins and rejects drift or missing checkout"

printf '\n%d security gate regression tests passed\n' "$test_count"

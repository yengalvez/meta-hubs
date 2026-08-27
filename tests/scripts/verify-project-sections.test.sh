#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/verify-project.sh"

TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-verification-receipts-test.XXXXXX")"
trap 'find "$TEST_TMP_DIR" -type f -delete; find "$TEST_TMP_DIR" -depth -type d -exec rmdir {} \;' EXIT
chmod 700 "$TEST_TMP_DIR"

test_count=0

pass_test() {
  test_count=$((test_count + 1))
  printf 'ok %d - %s\n' "$test_count" "$1"
}

fail_test() {
  test_count=$((test_count + 1))
  printf 'not ok %d - %s\n' "$test_count" "$1" >&2
  exit 1
}

expected_sections=$'advisories\nstatic\nsecurity\nrecovery\nhubs\nbrowser-capacity\nh5\nhcce\nbot-orchestrator\ndialog\nphotomnemonic\ncoturn\nspoke\nreticulum\ncomposition'
if [[ "$(printf '%s\n' "${VERIFY_FULL_SECTIONS[@]}")" == "$expected_sections" ]]; then
  pass_test 'section inventory is exact and ordered'
else
  fail_test 'section inventory is exact and ordered'
fi

if verification_section_is_known dialog &&
   verification_section_is_known composition &&
   ! verification_section_is_known unknown; then
  pass_test 'section allowlist rejects unknown names'
else
  fail_test 'section allowlist rejects unknown names'
fi

if [[ "$(verification_section_inputs dialog)" == $'cloud\tcommunity-edition/services/dialog' ]] &&
   ! verification_section_inputs dialog | grep -q 'tests/recovery'; then
  pass_test 'Dialog evidence does not invalidate recovery inputs'
else
  fail_test 'Dialog evidence does not invalidate recovery inputs'
fi

if verification_section_inputs recovery | grep -Fqx $'root\tdeployment' &&
   verification_section_inputs recovery | grep -Fqx $'root\ttests/recovery' &&
   ! verification_section_inputs recovery | grep -q 'services/dialog'; then
  pass_test 'recovery closure is explicit and excludes Dialog'
else
  fail_test 'recovery closure is explicit and excludes Dialog'
fi

if verification_section_inputs advisories |
     grep -Fqx $'cloud\tcommunity-edition/services/reticulum/mix.exs' &&
   verification_section_inputs advisories |
     grep -Fqx $'cloud\tcommunity-edition/services/reticulum/mix.lock' &&
   verification_section_inputs advisories |
     grep -Fqx $'cloud\tcommunity-edition/services/reticulum/scripts/verify-cowlib-security-contract.sh'; then
  pass_test 'expiring advisories evidence owns the Cowlib Git security contract'
else
  fail_test 'expiring advisories evidence owns the Cowlib Git security contract'
fi

dialog_harness_before="$(verification_section_harness_sha256 dialog)"
recovery_harness_before="$(verification_section_harness_sha256 recovery)"
run_recovery() {
  printf 'changed recovery fixture\n' >/dev/null
}
dialog_harness_after="$(verification_section_harness_sha256 dialog)"
recovery_harness_after="$(verification_section_harness_sha256 recovery)"
if [[ "$dialog_harness_before" == "$dialog_harness_after" &&
      "$recovery_harness_before" != "$recovery_harness_after" ]]; then
  pass_test 'a section command change invalidates only its own harness evidence'
else
  fail_test 'a section command change invalidates only its own harness evidence'
fi

dialog_toolchain_before="$(verification_section_toolchain_sha256 dialog)"
reticulum_toolchain_before="$(verification_section_toolchain_sha256 reticulum)"
fake_bin="$TEST_TMP_DIR/fake-bin"
mkdir -m 700 "$fake_bin"
printf '#!/bin/sh\nprintf "v-fixture-node\\n"\n' >"$fake_bin/node"
chmod 700 "$fake_bin/node"
dialog_toolchain_after="$(PATH="$fake_bin:$PATH" verification_section_toolchain_sha256 dialog)"
reticulum_toolchain_after="$(PATH="$fake_bin:$PATH" verification_section_toolchain_sha256 reticulum)"
if [[ "$dialog_toolchain_before" != "$dialog_toolchain_after" &&
      "$reticulum_toolchain_before" == "$reticulum_toolchain_after" ]]; then
  pass_test 'a tool version change invalidates only sections that use that tool'
else
  fail_test 'a tool version change invalidates only sections that use that tool'
fi

private_dir="$TEST_TMP_DIR/private"
mkdir -m 700 "$private_dir"
if (ensure_private_evidence_dir "$private_dir" >/dev/null); then
  pass_test 'private evidence directory is accepted'
else
  fail_test 'private evidence directory is accepted'
fi

public_dir="$TEST_TMP_DIR/public"
mkdir -m 755 "$public_dir"
if (ensure_private_evidence_dir "$public_dir" >/dev/null 2>&1); then
  fail_test 'non-private evidence directory is rejected'
else
  pass_test 'non-private evidence directory is rejected'
fi

inside_checkout="$ROOT_DIR/.verification-evidence-forbidden"
if (ensure_private_evidence_dir "$inside_checkout" >/dev/null 2>&1); then
  fail_test 'evidence inside the checkout is rejected before creation'
elif [[ ! -e "$inside_checkout" ]]; then
  pass_test 'evidence inside the checkout is rejected before creation'
else
  fail_test 'evidence inside the checkout is rejected before creation'
fi

VERIFY_EVIDENCE_DIR="$private_dir"
export VERIFY_EVIDENCE_DIR
section=dialog
input_sha="$(verification_section_input_sha256 "$section")"
section_dir="$VERIFY_EVIDENCE_DIR/$section"
mkdir -m 700 "$section_dir"
log_path="$section_dir/$input_sha.log"
printf 'fixture verification log\n' >"$log_path"
chmod 600 "$log_path"
now="$(date +%s)"
write_pass_receipt "$section" "$input_sha" "$log_path" "$now" "$now"
receipt="$(section_receipt_path "$section" "$input_sha")"

if receipt_is_current "$section" "$receipt" "$input_sha"; then
  pass_test 'exact content-bound receipt is accepted'
else
  fail_test 'exact content-bound receipt is accepted'
fi

printf 'tamper\n' >>"$log_path"
if receipt_is_current "$section" "$receipt" "$input_sha"; then
  fail_test 'tampered receipt log is rejected'
else
  pass_test 'tampered receipt log is rejected'
fi

printf 'fixture verification log\n' >"$log_path"
if receipt_is_current "$section" "$receipt" "$input_sha"; then
  pass_test 'restored exact log revalidates the receipt'
else
  fail_test 'restored exact log revalidates the receipt'
fi

receipt_next="$receipt.invalid"
awk '
  /^input_sha256=/ { print "input_sha256=" substr($0, 14) "0"; next }
  { print }
' "$receipt" >"$receipt_next"
chmod 600 "$receipt_next"
if receipt_is_current "$section" "$receipt_next" "$input_sha"; then
  fail_test 'wrong input fingerprint is rejected'
else
  pass_test 'wrong input fingerprint is rejected'
fi

if [[ "$(verification_section_input_sha256 dialog)" == "$input_sha" ]]; then
  pass_test 'section input fingerprint is deterministic'
else
  fail_test 'section input fingerprint is deterministic'
fi

printf '%d verify-project section tests passed\n' "$test_count"

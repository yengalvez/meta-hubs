#!/usr/bin/env bash

# Test-only, opt-in diagnostics. Never echo captured command output: even a
# successful recovery command may contain private paths or fixture sentinels.
recovery_test_profile_checkpoint_timing() {
  [[ "${YENHUBS_RECOVERY_TEST_PROFILE:-0}" == 1 ]] || return 0
  local line
  local timing_pattern='^YENHUBS_TIMING operation=checkpoint stage=(pre-publication|quiescence|database-backup|storage-backup|content-validation|checksum-manifest|staging-verification|final-claim|artifact-transfer|claimed-verification|terminal-boundary|precommit|publication|resume|lock-release|serialization-release|local-cleanup) stage_seconds=[0-9]{1,9} total_seconds=[0-9]{1,9} result=(complete|success|failure|interrupted)$'
  local -a saved_matches=("${BASH_REMATCH[@]}")
  while IFS= read -r line; do
    if [[ "$line" =~ $timing_pattern ]]; then
      printf 'RECOVERY_TEST_PROFILE %s\n' "$line"
    fi
  done <<<"$1"
  BASH_REMATCH=("${saved_matches[@]}")
  return 0
}

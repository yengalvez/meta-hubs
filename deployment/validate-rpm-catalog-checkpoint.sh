#!/usr/bin/env bash
# Offline catalogue adapter. No cluster reads, credentials, leases or restore.
set -euo pipefail
[[ $# == 1 ]] || exit 2
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
directory="$1"
recovery_require_regular_direct_file "$directory/checkpoint-metadata.json"
stamp="$(jq -er '.stamp | select(type == "string" and test("^[0-9]{8}-[0-9]{6}$"))' "$directory/checkpoint-metadata.json")"
if [[ "$(jq -r '.schema // empty' "$directory/checkpoint-metadata.json")" == freeze-bundle-v1 ]]; then
  recovery_verify_freeze_bundle_directory "$directory" "$stamp"
else
  recovery_verify_checkpoint_directory "$directory" "$stamp"
fi
"$SCRIPT_DIR/validate-checkpoint.sh" "$directory/retdb-$stamp.sql.gz" "$directory/ret-storage-$stamp.tar.gz"

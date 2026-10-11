#!/usr/bin/env bash

# Fixed monthly DigitalOcean volume-snapshot entrypoint. Public selectors may
# confirm this route, but may never select or fall back to a streaming backup.
set -Eeuo pipefail

[[ "${CHECKPOINT_BACKEND-native-monthly}" == native-monthly ]] || {
  printf 'Monthly snapshots require CHECKPOINT_BACKEND=native-monthly; no fallback is allowed.\n' >&2
  exit 2
}
[[ "${CHECKPOINT_FORMAT-native-monthly-v1}" == native-monthly-v1 ]] || {
  printf 'Monthly snapshots require CHECKPOINT_FORMAT=native-monthly-v1; legacy formats are not allowed.\n' >&2
  exit 2
}
[[ "$#" == 1 && "$1" == /* ]] || {
  printf 'Usage: create-monthly-snapshot.sh /absolute/output-directory\n' >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# "legacy" is only the shared coordinator's inventory/metadata schema selector.
# The fixed backend below chooses native-pair.json instead of SQL/media streams.
# Keep its Lease, quiescence monitors, abort recovery, resume and publication
# gates in the original process; an error exits here without retry or fallback.
exec env CHECKPOINT_BACKEND=native-monthly CHECKPOINT_FORMAT=legacy \
  "$SCRIPT_DIR/create-checkpoint.sh" "$1"

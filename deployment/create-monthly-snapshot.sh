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

# Direct monthly route. It never invokes the historical coordinator/guardian.
exec env CHECKPOINT_BACKEND=native-monthly CHECKPOINT_FORMAT=native-monthly-v1 \
  node "$SCRIPT_DIR/monthly-minimal-snapshot.mjs" "$1"

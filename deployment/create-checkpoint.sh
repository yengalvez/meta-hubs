#!/usr/bin/env bash

# Creates a complete, locally stored checkpoint: PostgreSQL, Reticulum owned
# files, non-secret infrastructure inventory, exact image refs and checksums.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
OUTPUT_DIR="${1:-$ROOT_DIR/output/checkpoints/$TIMESTAMP}"

if [[ -e "$OUTPUT_DIR" ]]; then
  printf 'Refusing to reuse checkpoint directory: %s\n' "$OUTPUT_DIR" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

"$SCRIPT_DIR/backup-retdb.sh" "$OUTPUT_DIR/retdb-$TIMESTAMP.sql.gz"
"$SCRIPT_DIR/backup-ret-storage.sh" "$OUTPUT_DIR/ret-storage-$TIMESTAMP.tar.gz"
"$SCRIPT_DIR/capture-instance-state.sh" "$OUTPUT_DIR"

CHECKSUM_TMP="$(mktemp /tmp/yenhubs-checksums.XXXXXX)"
trap 'rm -f "$CHECKSUM_TMP"' EXIT
(
  cd "$OUTPUT_DIR"
  find . -maxdepth 1 -type f -print0 |
    sort -z |
    xargs -0 shasum -a 256 >"$CHECKSUM_TMP"
)
mv "$CHECKSUM_TMP" "$OUTPUT_DIR/SHA256SUMS"
trap - EXIT
chmod 600 "$OUTPUT_DIR/SHA256SUMS"

printf 'Complete YenHubs checkpoint created: %s\n' "$OUTPUT_DIR"

#!/usr/bin/env bash

# Standalone storage-only backups are intentionally disabled. A valid YenHubs
# checkpoint always binds PostgreSQL metadata and ret-pvc bytes together.

set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/ret-storage-YYYYMMDD-HHMMSS.tar.gz\n' "$0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf 'Standalone ret-pvc backup is superseded and performs no cluster or output operation. Run %s/create-checkpoint.sh instead.\n' \
  "$SCRIPT_DIR" >&2
exit 1

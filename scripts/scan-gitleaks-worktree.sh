#!/usr/bin/env bash

# Scan exactly one Git worktree without descending into gitlinks or following
# symlinks. Only tracked and non-ignored untracked paths are materialized.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"

if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf 'Usage: %s REPOSITORY [REPOSITORY_RELATIVE_CONFIG]\n' "$0" >&2
  exit 2
fi

REPOSITORY="$1"
CONFIG_PATH="${2:-}"
GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"
if ! REPOSITORY="$(git -C "$REPOSITORY" rev-parse --show-toplevel 2>/dev/null)"; then
  printf 'Not a Git worktree.\n' >&2
  exit 1
fi
CONFIG_RESOLVED=""
if [[ -n "$CONFIG_PATH" ]]; then
  if [[ "$CONFIG_PATH" == /* ]]; then
    CONFIG_RESOLVED="$CONFIG_PATH"
  elif [[ "$CONFIG_PATH" != *..* ]]; then
    CONFIG_RESOLVED="$REPOSITORY/$CONFIG_PATH"
  fi
  if [[ -z "$CONFIG_RESOLVED" || ! -f "$CONFIG_RESOLVED" ||
        -L "$CONFIG_RESOLVED" ]]; then
    printf 'Gitleaks config must be one direct regular file.\n' >&2
    exit 1
  fi
fi

SCAN_DIR="$(mktemp -d "$TEMP_ROOT/yenhubs-gitleaks-worktree.XXXXXX")"
SCAN_DIR_OWNED=1
CONFIG_SNAPSHOT=""
cleanup_scan() {
  if [[ -n "$CONFIG_SNAPSHOT" && -f "$CONFIG_SNAPSHOT" &&
        ! -L "$CONFIG_SNAPSHOT" &&
        "$(basename "$CONFIG_SNAPSHOT")" =~ ^yenhubs-gitleaks-policy\.[A-Za-z0-9]{6}$ ]]; then
    rm -f -- "$CONFIG_SNAPSHOT"
  fi
  if [[ "${SCAN_DIR_OWNED:-0}" == "1" && -d "$SCAN_DIR" && ! -L "$SCAN_DIR" &&
        "$(basename "$SCAN_DIR")" =~ ^yenhubs-gitleaks-worktree\.[A-Za-z0-9]{6}$ ]]; then
    chmod -R u+rwX "$SCAN_DIR" 2>/dev/null || :
    rm -rf -- "$SCAN_DIR"
  fi
}
scan_interrupted() {
  local status="$1"
  trap - EXIT INT TERM
  cleanup_scan
  exit "$status"
}
trap cleanup_scan EXIT
trap 'scan_interrupted 130' INT
trap 'scan_interrupted 143' TERM

if [[ -n "$CONFIG_RESOLVED" ]]; then
  CONFIG_SNAPSHOT="$(mktemp "$TEMP_ROOT/yenhubs-gitleaks-policy.XXXXXX")"
  chmod 600 "$CONFIG_SNAPSHOT"
  if ! node "$ROOT_DIR/deployment/snapshot-private-file.mjs" \
    "$CONFIG_RESOLVED" "$CONFIG_SNAPSHOT" --allow-public-source; then
    printf 'Gitleaks config changed, is linked, or is not a regular file.\n' >&2
    exit 1
  fi
  CONFIG_RESOLVED="$CONFIG_SNAPSHOT"
fi

while IFS= read -r -d '' path; do
  if [[ -L "$REPOSITORY/$path" ]]; then
    # Scan the link text itself, never the linked target.
    mkdir -p "$SCAN_DIR/$(dirname "$path")"
    printf '%s\n' "$(readlink "$REPOSITORY/$path")" >"$SCAN_DIR/$path"
  elif [[ -d "$REPOSITORY/$path" ]]; then
    # A gitlink is represented by a directory in the superproject. Its own
    # helper invocation scans it with its repository-specific configuration.
    continue
  elif [[ -f "$REPOSITORY/$path" ]]; then
    mkdir -p "$SCAN_DIR/$(dirname "$path")"
    COPYFILE_DISABLE=1 command cp "$REPOSITORY/$path" "$SCAN_DIR/$path"
  elif [[ ! -e "$REPOSITORY/$path" ]]; then
    # Cached files deleted from the current worktree have no current bytes to
    # scan. Their committed bytes remain covered by the independent history
    # scan.
    continue
  else
    printf 'Git-listed path is neither a regular file nor a safe symlink: %s\n' "$path" >&2
    exit 1
  fi
  chmod 600 "$SCAN_DIR/$path"
done < <(git -C "$REPOSITORY" ls-files -z --cached --others --exclude-standard)

args=(detect --no-git --redact --timeout 300 --source "$SCAN_DIR")
if [[ -n "$CONFIG_PATH" ]]; then
  args+=(--config "$CONFIG_RESOLVED")
fi
"$GITLEAKS_BIN" "${args[@]}"

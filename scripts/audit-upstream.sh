#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FETCH=true
OUTPUT_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/audit-upstream.sh [--no-fetch] [--output FILE]

Audits the two upstream-derived submodules without changing either worktree.
The command fails only when a newer stable release is not an ancestor of the
current branch. Conflicts against unreleased upstream/master are reported as
planning information.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-fetch)
      FETCH=false
      shift
      ;;
    --output)
      OUTPUT_PATH="${2:?--output requires a file path}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

tmp_report="$(mktemp /tmp/yenhubs-upstream-audit.XXXXXX)"
trap 'rm -f "$tmp_report"' EXIT
overall_status=0

audit_repo() {
  local name="$1"
  local path="$2"
  local tag_pattern="$3"
  local latest_release
  local release_ahead
  local release_behind
  local master_ahead
  local master_behind
  local merge_output
  local merge_status

  if [[ ! -d "$path/.git" && ! -f "$path/.git" ]]; then
    printf 'Missing git repository: %s\n' "$path" >&2
    overall_status=1
    return
  fi

  if ! git -C "$path" remote get-url upstream >/dev/null 2>&1; then
    printf 'Missing upstream remote in %s\n' "$path" >&2
    overall_status=1
    return
  fi

  if [[ "$FETCH" == true ]]; then
    git -C "$path" fetch upstream --tags --prune >/dev/null
  fi

  latest_release="$(
    git -C "$path" tag -l "$tag_pattern" --sort=-version:refname |
      head -n 1
  )"
  if [[ -z "$latest_release" ]]; then
    printf 'No release matching %s in %s\n' "$tag_pattern" "$path" >&2
    overall_status=1
    return
  fi

  read -r release_ahead release_behind < <(
    git -C "$path" rev-list --left-right --count "$latest_release...HEAD"
  )
  read -r master_ahead master_behind < <(
    git -C "$path" rev-list --left-right --count "upstream/master...HEAD"
  )

  merge_output="$(mktemp /tmp/yenhubs-merge-tree.XXXXXX)"
  set +e
  git -C "$path" merge-tree --write-tree HEAD upstream/master >"$merge_output" 2>&1
  merge_status=$?
  set -e

  {
    printf '## %s\n\n' "$name"
    # Backticks are intentional Markdown delimiters, not shell substitutions.
    # shellcheck disable=SC2016
    printf -- '- Path: `%s`\n' "$path"
    # shellcheck disable=SC2016
    printf -- '- Branch: `%s`\n' "$(git -C "$path" branch --show-current)"
    # shellcheck disable=SC2016
    printf -- '- Commit: `%s`\n' "$(git -C "$path" rev-parse HEAD)"
    # shellcheck disable=SC2016
    printf -- '- Latest stable release: `%s` (`%s`)\n' \
      "$latest_release" "$(git -C "$path" rev-parse "$latest_release")"
    printf -- '- Stable delta: %s custom commits ahead; %s release commits missing.\n' \
      "$release_behind" "$release_ahead"
    printf -- '- Unreleased upstream/master delta: %s custom commits; %s upstream commits not integrated.\n' \
      "$master_behind" "$master_ahead"

    if [[ "$merge_status" -eq 0 ]]; then
      printf -- '- Dry merge against upstream/master: clean.\n'
    else
      printf -- '- Dry merge against upstream/master: conflicts detected (informational until an official release).\n'
      sed -n 's/^CONFLICT.* in /  - `/p' "$merge_output" | sed 's/$/`/'
    fi
    printf '\n'
  } >>"$tmp_report"

  if [[ "$release_ahead" -ne 0 ]]; then
    overall_status=1
  fi

  rm -f "$merge_output"
}

{
  printf '# YenHubs upstream audit\n\n'
  printf 'Generated: %s\n\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  # shellcheck disable=SC2016
  printf 'Stable releases are the deployment baseline. `upstream/master` is audited only as an early conflict signal.\n\n'
} >"$tmp_report"

audit_repo "Hubs client" "$ROOT_DIR/hubs" "prod-*"
audit_repo "Hubs Community Edition" "$ROOT_DIR/hubs-cloud" "[0-9]*.[0-9]*.[0-9]*"

cat "$tmp_report"
if [[ -n "$OUTPUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUTPUT_PATH")"
  cp "$tmp_report" "$OUTPUT_PATH"
fi

exit "$overall_status"

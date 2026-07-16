#!/usr/bin/env bash

# Print the smallest reliable Git log range for the current GitHub event.
# The repository must have been checked out with full history.

set -euo pipefail

event_name="${1:-${GITHUB_EVENT_NAME:-}}"
pull_request_base="${2:-${PR_BASE_SHA:-}}"
push_before="${3:-${PUSH_BEFORE_SHA:-}}"
head_revision="${4:-${GITHUB_SHA:-HEAD}}"
zero_revision="0000000000000000000000000000000000000000"

if ! git cat-file -e "${head_revision}^{commit}" 2>/dev/null; then
  printf 'Head revision is not available: %s\n' "$head_revision" >&2
  exit 1
fi

base_revision=""
case "$event_name" in
  pull_request | pull_request_target)
    base_revision="$pull_request_base"
    ;;
  push)
    base_revision="$push_before"
    ;;
esac

if [[ -n "$base_revision" && "$base_revision" != "$zero_revision" ]] &&
  git cat-file -e "${base_revision}^{commit}" 2>/dev/null; then
  if [[ "$base_revision" == "$head_revision" ]]; then
    printf '%s\n' "$head_revision"
  else
    printf '%s..%s\n' "$base_revision" "$head_revision"
  fi
  exit 0
fi

if parent_revision="$(git rev-parse "${head_revision}^" 2>/dev/null)"; then
  printf '%s..%s\n' "$parent_revision" "$head_revision"
else
  printf '%s\n' "$head_revision"
fi

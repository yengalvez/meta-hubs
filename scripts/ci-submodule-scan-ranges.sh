#!/usr/bin/env bash

# Print direct-submodule Gitleaks ranges as: <path><TAB><old>..<new>.
# Incremental events scan old gitlink..new gitlink. Bootstrap and manual runs
# start at the reviewed clean baseline, never at contaminated root history.

set -euo pipefail

event_name="${1:-${GITHUB_EVENT_NAME:-}}"
pull_request_base="${2:-${PR_BASE_SHA:-}}"
push_before="${3:-${PUSH_BEFORE_SHA:-}}"
head_revision="${4:-${GITHUB_SHA:-HEAD}}"
default_branch="${5:-${DEFAULT_BRANCH:-main}}"
root_dir="$(git rev-parse --show-toplevel)"
baseline_map="${6:-${SUBMODULE_BASELINE_MAP:-$root_dir/scripts/gitleaks-submodule-baselines.tsv}}"
zero_revision="0000000000000000000000000000000000000000"
bootstrap_default=false
if [[ "$baseline_map" == --bootstrap-default ]]; then
  bootstrap_default=true
  baseline_map=""
fi

if ! git -C "$root_dir" cat-file -e "${head_revision}^{commit}" 2>/dev/null; then
  printf 'Head revision is not available: %s\n' "$head_revision" >&2
  exit 1
fi
if [[ "$bootstrap_default" == false ]]; then
  if [[ ! -f "$baseline_map" || -L "$baseline_map" ]]; then
    printf 'A regular versioned submodule baseline map is required.\n' >&2
    exit 1
  fi
  if ! awk '
    /^[[:space:]]*(#|$)/ { next }
    NF != 2 || $1 !~ /^[A-Za-z0-9._\/-]+$/ || $2 !~ /^[a-fA-F0-9]{40}$/ { exit 2 }
    seen[$1]++ { exit 2 }
    END { if (length(seen) == 0) exit 2 }
  ' "$baseline_map"; then
    printf 'Submodule baseline map is malformed or contains duplicate paths.\n' >&2
    exit 1
  fi
fi

[[ -f "$root_dir/.gitmodules" ]] || exit 0
if ! submodule_paths="$(
  git -C "$root_dir" config --file .gitmodules --get-regexp '^submodule\..*\.path$' |
    awk '{print $2}' | LC_ALL=C sort
)"; then
  printf 'Could not enumerate direct submodules.\n' >&2
  exit 1
fi
if [[ "$bootstrap_default" == false ]]; then
  map_paths="$(awk '!/^[[:space:]]*(#|$)/ {print $1}' "$baseline_map" | LC_ALL=C sort)"
  if [[ "$map_paths" != "$submodule_paths" ]]; then
    printf 'Baseline map paths do not exactly match direct submodules.\n' >&2
    exit 1
  fi
fi

incremental=false
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
   git -C "$root_dir" cat-file -e "${base_revision}^{commit}" 2>/dev/null; then
  incremental=true
fi

# Keep this argument part of the stable interface used by the workflow/tests.
: "$default_branch"

while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  if [[ ! "$path" =~ ^[A-Za-z0-9._/-]+$ || "$path" == /* ||
        "$path" == *../* || "$path" == ../* || "$path" == */.. ]]; then
    printf 'Unsafe direct submodule path: %s.\n' "$path" >&2
    exit 1
  fi
  if ! new_revision="$(
    git -C "$root_dir" ls-tree "$head_revision" -- "$path" |
      awk '$1 == "160000" { print $3 }'
  )" || [[ ! "$new_revision" =~ ^[a-fA-F0-9]{40}$ ]]; then
    printf 'Head does not contain one valid gitlink for %s.\n' "$path" >&2
    exit 1
  fi
  if [[ ! -e "$root_dir/$path/.git" ]]; then
    printf 'Submodule %s is not initialized.\n' "$path" >&2
    exit 1
  fi
  if [[ "$bootstrap_default" == true ]]; then
    if ! git -C "$root_dir/$path" cat-file -e "${new_revision}^{commit}" 2>/dev/null; then
      printf 'Submodule %s lacks required revision %s.\n' "$path" "$new_revision" >&2
      exit 1
    fi
    # A single revision asks Gitleaks to scan every commit reachable from the
    # candidate gitlink. This is intentionally conservative for first-policy
    # bootstrap and uses no candidate-owned allowlist or clean baseline.
    printf '%s\t%s\n' "$path" "$new_revision"
    continue
  fi
  if ! baseline_revision="$(awk -v wanted="$path" '
    !/^[[:space:]]*(#|$)/ && $1 == wanted { print $2 }
  ' "$baseline_map")" || [[ ! "$baseline_revision" =~ ^[a-fA-F0-9]{40}$ ]]; then
    printf 'Missing clean baseline for submodule %s.\n' "$path" >&2
    exit 1
  fi
  for revision in "$baseline_revision" "$new_revision"; do
    if ! git -C "$root_dir/$path" cat-file -e "${revision}^{commit}" 2>/dev/null; then
      printf 'Submodule %s lacks required revision %s.\n' "$path" "$revision" >&2
      exit 1
    fi
  done
  if ! git -C "$root_dir/$path" merge-base --is-ancestor \
    "$baseline_revision" "$new_revision"; then
    printf 'Submodule %s gitlink is not descended from its clean baseline.\n' "$path" >&2
    exit 1
  fi

  if [[ "$incremental" == true ]]; then
    if ! old_revision="$(
      git -C "$root_dir" ls-tree "$base_revision" -- "$path" |
        awk '$1 == "160000" { print $3 }'
    )" || [[ ! "$old_revision" =~ ^[a-fA-F0-9]{40}$ ]]; then
      printf 'Base revision lacks a valid gitlink for %s.\n' "$path" >&2
      exit 1
    fi
    if ! git -C "$root_dir/$path" cat-file -e "${old_revision}^{commit}" 2>/dev/null ||
       ! git -C "$root_dir/$path" merge-base --is-ancestor \
         "$baseline_revision" "$old_revision"; then
      printf 'Submodule %s base gitlink is missing or predates the clean baseline.\n' "$path" >&2
      exit 1
    fi
    [[ "$old_revision" != "$new_revision" ]] || continue
    printf '%s\t%s..%s\n' "$path" "$old_revision" "$new_revision"
  else
    [[ "$baseline_revision" != "$new_revision" ]] || continue
    printf '%s\t%s..%s\n' "$path" "$baseline_revision" "$new_revision"
  fi
done <<<"$submodule_paths"

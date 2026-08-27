#!/usr/bin/env bash

# Read-only provenance guards shared by freeze capture and greenfield preflight.
# A commit hash is not sufficient evidence when tracked or untracked local bytes
# can change the scripts, generators or submodules used by an operation.

yenhubs_git_repository_is_clean() {
  local repository="$1" status
  [[ -n "$repository" && -d "$repository" && ! -L "$repository" ]] || return 2
  git -C "$repository" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  status="$(git -C "$repository" status --porcelain=v1 \
    --untracked-files=normal --ignore-submodules=none 2>/dev/null)" || return 1
  [[ -z "$status" ]]
}

yenhubs_require_clean_source_tree() {
  local root="$1" relative repository
  [[ -n "$root" && -d "$root" && ! -L "$root" ]] || return 2
  for relative in . hubs hubs-cloud; do
    repository="$root"
    [[ "$relative" == . ]] || repository="$root/$relative"
    if ! yenhubs_git_repository_is_clean "$repository"; then
      printf 'Recovery source repository is not a clean direct checkout: %s\n' \
        "$relative" >&2
      return 1
    fi
  done
}

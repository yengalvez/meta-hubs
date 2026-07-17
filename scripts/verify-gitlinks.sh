#!/usr/bin/env bash

# Verify that every declared submodule is initialized at its exact gitlink and
# that no root-level gitlink lacks a .gitmodules declaration.

set -euo pipefail

ROOT_DIR="${1:-$(git rev-parse --show-toplevel)}"

if [[ ! -f "$ROOT_DIR/.gitmodules" ]]; then
  if git -C "$ROOT_DIR" ls-files --stage | awk '$1 == "160000" { found = 1 } END { exit !found }'; then
    printf 'Gitlinks exist but .gitmodules is missing\n' >&2
    exit 1
  fi
  printf 'No gitlinks declared\n'
  exit 0
fi

declared_paths=()
while read -r _ path; do
  declared_paths+=("$path")
done < <(
  git -C "$ROOT_DIR" config --file .gitmodules --get-regexp '^submodule\..*\.path$' |
    LC_ALL=C sort -k2
)

indexed_paths=()
while IFS=$'\t' read -r metadata path; do
  [[ "${metadata%% *}" == "160000" ]] && indexed_paths+=("$path")
done < <(git -C "$ROOT_DIR" ls-files --stage)

if [[ "${declared_paths[*]}" != "${indexed_paths[*]}" ]]; then
  printf 'Declared submodules and indexed gitlinks differ\n' >&2
  printf 'Declared: %s\n' "${declared_paths[*]:-none}" >&2
  printf 'Indexed:  %s\n' "${indexed_paths[*]:-none}" >&2
  exit 1
fi

for path in "${declared_paths[@]}"; do
  expected="$(git -C "$ROOT_DIR" ls-files --stage -- "$path" | awk '$1 == "160000" {print $2}')"
  actual=""
  if [[ -e "$ROOT_DIR/$path/.git" ]]; then
    actual="$(git -C "$ROOT_DIR/$path" rev-parse HEAD 2>/dev/null || true)"
  fi
  if [[ -z "$expected" || "$actual" != "$expected" ]]; then
    printf 'Gitlink mismatch: %s expected=%s actual=%s\n' \
      "$path" "${expected:-missing}" "${actual:-uninitialized}" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$ROOT_DIR/$path" status --porcelain --untracked-files=normal)" ]]; then
    printf 'Submodule worktree is dirty: %s\n' "$path" >&2
    exit 1
  fi
done

while IFS= read -r status_line; do
  [[ -z "$status_line" ]] && continue
  if [[ "${status_line:0:1}" != " " ]]; then
    printf 'Recursive submodule mismatch: %s\n' "$status_line" >&2
    exit 1
  fi
done < <(git -C "$ROOT_DIR" submodule status --recursive)

printf 'Verified %d pinned gitlink(s)\n' "${#declared_paths[@]}"

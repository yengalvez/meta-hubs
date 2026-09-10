#!/usr/bin/env bash
# Source-only fixture for the real fresh-shell executor.
run_section_body() {
  if [[ "$1" == composition ]]; then
    printf 'successful-section\n'
    return 0
  fi
  false
  printf 'incorrect-later-success\n'
}

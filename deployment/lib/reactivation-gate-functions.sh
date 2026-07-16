#!/usr/bin/env bash

# Shared, side-effect-free helpers for the reactivation gates. Callers install
# the cleanup traps explicitly so sourcing this file never changes shell state.

REACTIVATION_TEMP_PATHS=()

reactivation_register_temp_path() {
  local path="${1:-}"
  [[ -n "$path" ]] || return 2
  REACTIVATION_TEMP_PATHS+=("$path")
}

reactivation_cleanup_temp_paths() {
  local path
  for path in "${REACTIVATION_TEMP_PATHS[@]}"; do
    [[ -n "$path" ]] && rm -f -- "$path"
  done
  REACTIVATION_TEMP_PATHS=()
}

reactivation_handle_signal() {
  local exit_code="$1"
  trap - EXIT INT TERM
  reactivation_cleanup_temp_paths
  exit "$exit_code"
}

reactivation_install_cleanup_traps() {
  trap reactivation_cleanup_temp_paths EXIT
  trap 'reactivation_handle_signal 130' INT
  trap 'reactivation_handle_signal 143' TERM
}

reactivation_file_mode() {
  local path="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}

reactivation_values_file_is_private() {
  local path="$1"
  [[ "$(reactivation_file_mode "$path")" == "600" ]]
}

reactivation_live_result_is_clean() {
  local failures="$1"
  local warnings="$2"
  [[ "$failures" =~ ^[0-9]+$ && "$warnings" =~ ^[0-9]+$ ]] || return 2
  ((failures == 0 && warnings == 0))
}

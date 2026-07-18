#!/usr/bin/env bash

# Pure and callback-driven primitives for the process-local DB_PASS rotation.
#
# This file deliberately performs no Kubernetes operation.  A tracked driver
# must provide the callbacks listed by pldb_require_rotation_callbacks and keep
# its context, Lease and object identities pinned.  Passwords enter only on
# stdin.  Callbacks that need credential material receive an MD5 verifier on
# stdin and only the validated PostgreSQL role name in argv.

pldb_error() {
  printf 'process-local DB rotation: %s\n' "$1" >&2
}

pldb_require_no_xtrace() {
  case "$-" in
    *x*)
      pldb_error 'shell xtrace must be disabled before handling credentials'
      return 1
      ;;
  esac
}

pldb_validate_role() {
  local role="${1:-}"
  [[ "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]
}

pldb_validate_existing_password() {
  local password="${1:-}"
  [[ -n "$password" && ${#password} -le 256 &&
     ! "$password" =~ [[:cntrl:]] ]]
}

pldb_validate_new_password() {
  local password="${1:-}"
  [[ "$password" =~ ^[A-Za-z0-9_-]{32,128}$ ]]
}

# Backwards-compatible public validator for callers preparing a new value.
pldb_validate_password() {
  pldb_validate_new_password "${1:-}"
}

pldb_validate_verifier() {
  local verifier="${1:-}"
  [[ "$verifier" =~ ^md5[a-f0-9]{32}$ ]]
}

# Read one password from stdin and emit PostgreSQL's legacy MD5 verifier.
# The output remains authentication material and must be piped, never logged.
pldb_password_to_verifier() {
  local role="${1:-}" password="" digest="" output=""
  pldb_require_no_xtrace || return 1
  pldb_validate_role "$role" || {
    pldb_error 'invalid PostgreSQL role name'
    return 2
  }
  if ! IFS= read -r password; then
    pldb_error 'one newline-terminated password is required on stdin'
    return 2
  fi
  if ! pldb_validate_existing_password "$password"; then
    password=""
    pldb_error 'password must be one nonempty control-free line of at most 256 characters'
    return 2
  fi
  if IFS= read -r output || [[ -n "$output" ]]; then
    password=""
    output=""
    pldb_error 'password stdin must contain exactly one line'
    return 2
  fi

  if command -v md5sum >/dev/null 2>&1; then
    output="$(printf '%s%s' "$password" "$role" | command md5sum)" || {
      password=""
      return 1
    }
    digest="${output%%[[:space:]]*}"
  elif command -v md5 >/dev/null 2>&1; then
    digest="$(printf '%s%s' "$password" "$role" | command md5 -q)" || {
      password=""
      return 1
    }
  elif command -v openssl >/dev/null 2>&1; then
    output="$(printf '%s%s' "$password" "$role" | command openssl dgst -md5 -r)" || {
      password=""
      return 1
    }
    digest="${output%%[[:space:]]*}"
  else
    password=""
    pldb_error 'md5sum, md5 or openssl is required'
    return 127
  fi
  password=""
  output=""
  digest="$(printf '%s' "$digest" | tr '[:upper:]' '[:lower:]')"
  [[ "$digest" =~ ^[a-f0-9]{32}$ ]] || {
    digest=""
    pldb_error 'MD5 implementation returned an invalid digest'
    return 1
  }
  printf 'md5%s\n' "$digest"
}

# Classify a stored verifier without printing it.  Input is exactly:
# current-verifier, old-verifier, new-verifier (one line each).
pldb_classify_verifier() {
  local current="" old_verifier="" new_verifier="" extra=""
  pldb_require_no_xtrace || return 1
  IFS= read -r current || return 2
  IFS= read -r old_verifier || return 2
  IFS= read -r new_verifier || return 2
  if IFS= read -r extra || [[ -n "$extra" ]]; then return 2; fi
  pldb_validate_verifier "$old_verifier" || return 2
  pldb_validate_verifier "$new_verifier" || return 2
  [[ "$old_verifier" != "$new_verifier" ]] || return 2
  if [[ "$current" == "$new_verifier" ]]; then
    printf 'new\n'
  elif [[ "$current" == "$old_verifier" ]]; then
    printf 'old\n'
  else
    printf 'unknown\n'
  fi
}

# Emit a psql program that returns only old/new/unknown.  The two verifiers are
# read from stdin.  This function is stream-only: its output contains verifiers
# and must be connected directly to a supervised psql transport.
pldb_emit_classification_sql() {
  local role="${1:-}" old_verifier="" new_verifier="" extra=""
  pldb_require_no_xtrace || return 1
  pldb_validate_role "$role" || return 2
  IFS= read -r old_verifier || return 2
  IFS= read -r new_verifier || return 2
  if IFS= read -r extra || [[ -n "$extra" ]]; then return 2; fi
  pldb_validate_verifier "$old_verifier" || return 2
  pldb_validate_verifier "$new_verifier" || return 2
  [[ "$old_verifier" != "$new_verifier" ]] || return 2
  printf '%s\n' \
    '\set ON_ERROR_STOP on' \
    '\set QUIET 1' \
    '\pset format unaligned' \
    '\pset tuples_only on' \
    '\pset pager off' \
    "\\set old_verifier '$old_verifier'" \
    "\\set new_verifier '$new_verifier'" \
    "SET log_statement = 'none';" \
    'SET log_transaction_sample_rate = 0;' \
    'SET track_activities = off;' \
    'SET log_min_duration_statement = -1;' \
    'SET log_duration = off;' \
    "SET log_min_error_statement = 'panic';" \
    'SET debug_print_parse = off;' \
    'SET debug_print_rewritten = off;' \
    'SET debug_print_plan = off;' \
    'SET log_parser_stats = off;' \
    'SET log_planner_stats = off;' \
    'SET log_executor_stats = off;' \
    'SET log_statement_stats = off;' \
    "SET pg_stat_statements.track = 'none';" \
    'SET auto_explain.log_min_duration = -1;' \
    "SET pgaudit.log = 'none';" \
    'BEGIN;' \
    "SELECT COALESCE((SELECT CASE WHEN rolpassword = :'new_verifier' THEN 'new' WHEN rolpassword = :'old_verifier' THEN 'old' ELSE 'unknown' END FROM pg_authid WHERE rolname = '$role'), 'unknown');" \
    'ROLLBACK;'
}

# Emit one atomic ALTER ROLE program.  The new verifier is read from stdin.
# Output is credential-bearing SQL and must be piped directly to a supervised
# psql transport whose stdout/stderr are suppressed by its caller.
pldb_emit_alter_sql() {
  local role="${1:-}" new_verifier="" extra=""
  pldb_require_no_xtrace || return 1
  pldb_validate_role "$role" || return 2
  IFS= read -r new_verifier || return 2
  if IFS= read -r extra || [[ -n "$extra" ]]; then return 2; fi
  pldb_validate_verifier "$new_verifier" || return 2
  printf '%s\n' \
    '\set ON_ERROR_STOP on' \
    '\set QUIET 1' \
    "\\set new_verifier '$new_verifier'" \
    "SET log_statement = 'none';" \
    'SET log_transaction_sample_rate = 0;' \
    'SET track_activities = off;' \
    'SET log_min_duration_statement = -1;' \
    'SET log_duration = off;' \
    "SET log_min_error_statement = 'panic';" \
    'SET debug_print_parse = off;' \
    'SET debug_print_rewritten = off;' \
    'SET debug_print_plan = off;' \
    'SET log_parser_stats = off;' \
    'SET log_planner_stats = off;' \
    'SET log_executor_stats = off;' \
    'SET log_statement_stats = off;' \
    "SET pg_stat_statements.track = 'none';" \
    'SET auto_explain.log_min_duration = -1;' \
    "SET pgaudit.log = 'none';" \
    'BEGIN;' \
    "ALTER ROLE \"$role\" WITH PASSWORD :'new_verifier';" \
    'COMMIT;'
}

# Emit a value-free PostgreSQL session check for the admission-closed boundary.
# It returns only clear/residual and never terminates an unknown connection.
# The driver must run it over the exact PostgreSQL Pod's Unix socket after all
# declared consumers and the TCP probe have been fenced.
pldb_emit_session_quiescence_sql() {
  local role="${1:-}"
  pldb_validate_role "$role" || return 2
  printf '%s\n' \
    '\set ON_ERROR_STOP on' \
    '\set QUIET 1' \
    '\pset format unaligned' \
    '\pset tuples_only on' \
    '\pset pager off' \
    "SET log_statement = 'none';" \
    'SET log_transaction_sample_rate = 0;' \
    'SET track_activities = off;' \
    'SET log_min_duration_statement = -1;' \
    'SET log_duration = off;' \
    "SET log_min_error_statement = 'panic';" \
    'SET debug_print_parse = off;' \
    'SET debug_print_rewritten = off;' \
    'SET debug_print_plan = off;' \
    'SET log_parser_stats = off;' \
    'SET log_planner_stats = off;' \
    'SET log_executor_stats = off;' \
    'SET log_statement_stats = off;' \
    "SET pg_stat_statements.track = 'none';" \
    'SET auto_explain.log_min_duration = -1;' \
    "SET pgaudit.log = 'none';" \
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend') THEN 'residual' ELSE 'clear' END;"
}

pldb_callback_name() {
  local variable_name="$1" callback=""
  callback="${!variable_name:-}"
  [[ "$callback" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  command -v "$callback" >/dev/null 2>&1 || return 1
  printf '%s\n' "$callback"
}

pldb_require_callbacks() {
  local variable_name callback
  for variable_name in "$@"; do
    callback="$(pldb_callback_name "$variable_name")" || {
      pldb_error "required callback is missing or invalid: $variable_name"
      return 2
    }
  done
}

pldb_call_silent() {
  local variable_name="$1" callback
  shift
  callback="$(pldb_callback_name "$variable_name")" || return 2
  (
    pldb_require_no_xtrace || exit 1
    "$callback" "$@" >/dev/null 2>&1
  ) || return 1
  pldb_require_no_xtrace
}

pldb_call_with_verifier() {
  local variable_name="$1" role="$2" verifier="$3" callback
  callback="$(pldb_callback_name "$variable_name")" || return 2
  pldb_validate_role "$role" || return 2
  pldb_validate_verifier "$verifier" || return 2
  (
    pldb_require_no_xtrace || exit 1
    printf '%s\n' "$verifier" | "$callback" "$role" >/dev/null 2>&1
  ) || return 1
  pldb_require_no_xtrace
}

pldb_classify_with_callback() {
  local role="$1" old_verifier="$2" new_verifier="$3" callback classification
  callback="$(pldb_callback_name PLDB_CLASSIFY_CALLBACK)" || return 2
  classification="$(
    (
      pldb_require_no_xtrace || exit 1
      printf '%s\n%s\n' "$old_verifier" "$new_verifier" |
        "$callback" "$role"
    ) 2>/dev/null
  )" || return 1
  pldb_require_no_xtrace || return 1
  case "$classification" in
    old|new|unknown) printf '%s\n' "$classification" ;;
    *) return 1 ;;
  esac
}

pldb_fail_closed() {
  local stage="$1"
  pldb_call_silent PLDB_FAIL_CLOSE_CALLBACK "$stage" ||
    pldb_error 'fail-close callback also failed; consumers must remain stopped'
  pldb_error "failed at $stage; consumers must remain stopped"
  return 1
}

pldb_require_rotation_callbacks() {
  pldb_require_callbacks \
    PLDB_GUARD_CALLBACK \
    PLDB_QUIESCE_CALLBACK \
    PLDB_ASSERT_QUIESCED_CALLBACK \
    PLDB_CLASSIFY_CALLBACK \
    PLDB_ALTER_CALLBACK \
    PLDB_ROLE_NEW_CALLBACK \
    PLDB_APPLY_CALLBACK \
    PLDB_START_POOLS_CALLBACK \
    PLDB_VERIFY_POOLS_CALLBACK \
    PLDB_START_CONSUMERS_CALLBACK \
    PLDB_VERIFY_RUNTIME_CALLBACK \
    PLDB_COMPLETE_CALLBACK \
    PLDB_FAIL_CLOSE_CALLBACK
}

# Execute the fail-closed rotation state machine.  Stdin contains exactly two
# newline-terminated passwords: old then new.  It emits no credential material.
pldb_run_rotation() {
  local role="${1:-}" old_password="" new_password="" extra=""
  local old_verifier="" new_verifier="" classification=""
  pldb_require_no_xtrace || return 1
  pldb_validate_role "$role" || {
    pldb_error 'invalid PostgreSQL role name'
    return 2
  }
  pldb_require_rotation_callbacks || return 2
  IFS= read -r old_password || {
    pldb_error 'old and new passwords are required on stdin'
    return 2
  }
  IFS= read -r new_password || {
    old_password=""
    pldb_error 'old and new passwords are required on stdin'
    return 2
  }
  if IFS= read -r extra || [[ -n "$extra" ]]; then
    old_password=""
    new_password=""
    pldb_error 'password stdin must contain exactly two lines'
    return 2
  fi
  if ! pldb_validate_existing_password "$old_password" ||
     ! pldb_validate_new_password "$new_password" ||
     [[ "$old_password" == "$new_password" ]]; then
    old_password=""
    new_password=""
    pldb_error 'password inputs are invalid or not distinct'
    return 2
  fi
  old_verifier="$(printf '%s\n' "$old_password" | pldb_password_to_verifier "$role")" || {
    old_password=""
    new_password=""
    return 1
  }
  new_verifier="$(printf '%s\n' "$new_password" | pldb_password_to_verifier "$role")" || {
    old_password=""
    new_password=""
    old_verifier=""
    return 1
  }
  old_password=""
  new_password=""
  [[ "$old_verifier" != "$new_verifier" ]] || {
    old_verifier=""
    new_verifier=""
    pldb_error 'old and new verifier collision'
    return 2
  }

  pldb_call_silent PLDB_GUARD_CALLBACK || {
    old_verifier=""
    new_verifier=""
    pldb_error 'guard rejected the rotation before quiescence'
    return 1
  }
  pldb_call_silent PLDB_QUIESCE_CALLBACK || {
    old_verifier=""
    new_verifier=""
    pldb_fail_closed quiesce
    return 1
  }
  pldb_call_silent PLDB_ASSERT_QUIESCED_CALLBACK || {
    old_verifier=""
    new_verifier=""
    pldb_fail_closed assert-quiesced
    return 1
  }
  classification="$(pldb_classify_with_callback \
    "$role" "$old_verifier" "$new_verifier")" || {
    old_verifier=""
    new_verifier=""
    pldb_fail_closed classify-role
    return 1
  }
  case "$classification" in
    old)
      pldb_call_with_verifier PLDB_ALTER_CALLBACK "$role" "$new_verifier" || {
        old_verifier=""
        new_verifier=""
        pldb_fail_closed alter-role
        return 1
      }
      classification="$(pldb_classify_with_callback \
        "$role" "$old_verifier" "$new_verifier")" || classification=unknown
      [[ "$classification" == new ]] || {
        old_verifier=""
        new_verifier=""
        pldb_fail_closed verify-altered-role
        return 1
      }
      ;;
    new)
      # Idempotent re-entry after a committed ALTER and before external state
      # publication.  Never restore the old verifier.
      ;;
    unknown)
      old_verifier=""
      new_verifier=""
      pldb_fail_closed unknown-role-state
      return 1
      ;;
  esac

  # This boundary is deliberately a separate callback.  The driver persists
  # the confirmed-new state in the operation lock here, including the
  # idempotent crash window where ALTER committed before that lock advanced.
  # Like every callback it runs in an isolated process: durable state must be
  # re-read from the API, never passed through shell variables.
  if ! pldb_call_silent PLDB_ROLE_NEW_CALLBACK; then
    old_verifier=""
    new_verifier=""
    pldb_fail_closed persist-new-role-state
    return 1
  fi

  if ! pldb_call_silent PLDB_APPLY_CALLBACK; then
    old_verifier=""
    new_verifier=""
    pldb_fail_closed apply-new-credentials
    return 1
  fi
  if ! pldb_call_silent PLDB_START_POOLS_CALLBACK; then
    old_verifier=""
    new_verifier=""
    pldb_fail_closed start-pools
    return 1
  fi
  if ! pldb_call_silent PLDB_VERIFY_POOLS_CALLBACK; then
    old_verifier=""
    new_verifier=""
    pldb_fail_closed verify-pools
    return 1
  fi
  if ! pldb_call_silent PLDB_START_CONSUMERS_CALLBACK; then
    old_verifier=""
    new_verifier=""
    pldb_fail_closed start-consumers
    return 1
  fi
  if ! pldb_call_silent PLDB_VERIFY_RUNTIME_CALLBACK; then
    old_verifier=""
    new_verifier=""
    pldb_fail_closed verify-runtime
    return 1
  fi
  if ! pldb_call_silent PLDB_COMPLETE_CALLBACK; then
    old_verifier=""
    new_verifier=""
    pldb_fail_closed complete
    return 1
  fi
  old_verifier=""
  new_verifier=""
  classification=""
  return 0
}

# Roll back workload specs while retaining the new DB credential.  Stdin is
# exactly one new password.  No old password or verifier is accepted here.
pldb_run_rollback_with_new() {
  local role="${1:-}" new_password="" extra="" new_verifier=""
  pldb_require_no_xtrace || return 1
  pldb_validate_role "$role" || return 2
  pldb_require_callbacks \
    PLDB_GUARD_CALLBACK \
    PLDB_QUIESCE_CALLBACK \
    PLDB_ASSERT_QUIESCED_CALLBACK \
    PLDB_ASSERT_NEW_CALLBACK \
    PLDB_ROLLBACK_CALLBACK \
    PLDB_START_POOLS_CALLBACK \
    PLDB_VERIFY_POOLS_CALLBACK \
    PLDB_START_CONSUMERS_CALLBACK \
    PLDB_VERIFY_RUNTIME_CALLBACK \
    PLDB_COMPLETE_CALLBACK \
    PLDB_FAIL_CLOSE_CALLBACK || return 2
  IFS= read -r new_password || return 2
  if IFS= read -r extra || [[ -n "$extra" ]]; then
    new_password=""
    pldb_error 'rollback requires exactly one valid new password line'
    return 2
  fi
  if ! pldb_validate_new_password "$new_password"; then
    new_password=""
    pldb_error 'rollback requires exactly one valid new password line'
    return 2
  fi
  new_verifier="$(printf '%s\n' "$new_password" | pldb_password_to_verifier "$role")" || {
    new_password=""
    return 1
  }
  new_password=""
  pldb_call_silent PLDB_GUARD_CALLBACK || {
    new_verifier=""
    pldb_error 'guard rejected rollback before quiescence'
    return 1
  }
  pldb_call_silent PLDB_QUIESCE_CALLBACK || {
    new_verifier=""
    pldb_fail_closed rollback-quiesce
    return 1
  }
  pldb_call_silent PLDB_ASSERT_QUIESCED_CALLBACK || {
    new_verifier=""
    pldb_fail_closed rollback-assert-quiesced
    return 1
  }
  pldb_call_with_verifier PLDB_ASSERT_NEW_CALLBACK "$role" "$new_verifier" || {
    new_verifier=""
    pldb_fail_closed rollback-role-is-not-new
    return 1
  }
  pldb_call_with_verifier PLDB_ROLLBACK_CALLBACK "$role" "$new_verifier" || {
    new_verifier=""
    pldb_fail_closed rollback-apply
    return 1
  }
  if ! pldb_call_silent PLDB_START_POOLS_CALLBACK ||
     ! pldb_call_silent PLDB_VERIFY_POOLS_CALLBACK ||
     ! pldb_call_silent PLDB_START_CONSUMERS_CALLBACK ||
     ! pldb_call_silent PLDB_VERIFY_RUNTIME_CALLBACK ||
     ! pldb_call_silent PLDB_COMPLETE_CALLBACK; then
    new_verifier=""
    pldb_fail_closed rollback-verification
    return 1
  fi
  new_verifier=""
}

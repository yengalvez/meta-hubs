#!/usr/bin/env bash

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck source=deployment/lib/process-local-db-rotation.sh
source "$ROOT_DIR/deployment/lib/process-local-db-rotation.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-db-rotation-tests.XXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT INT TERM
EVENT_LOG="$TMP_DIR/events.log"
ARGV_LOG="$TMP_DIR/argv.log"
STATE_FILE="$TMP_DIR/role-state"
KUBECTL_CALLED="$TMP_DIR/kubectl-called"
mkdir -p "$TMP_DIR/bin"
cat >"$TMP_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
printf 'called\n' >"$KUBECTL_CALLED"
exit 99
STUB
chmod 700 "$TMP_DIR/bin/kubectl"
export KUBECTL_CALLED
PATH="$TMP_DIR/bin:$PATH"
export PATH

PASS_COUNT=0
FAIL_COUNT=0
LAST_OUTPUT=""

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %s - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'not ok %s - %s\n%s\n' \
    "$((PASS_COUNT + FAIL_COUNT))" "$1" "$2" >&2
}

expect_success() {
  local name="$1"
  shift
  if LAST_OUTPUT="$("$@" 2>&1)"; then
    pass "$name"
  else
    fail "$name" "$LAST_OUTPUT"
  fi
}

expect_failure() {
  local name="$1" expected="$2"
  shift 2
  if LAST_OUTPUT="$("$@" 2>&1)"; then
    fail "$name" 'command unexpectedly succeeded'
  elif [[ "$LAST_OUTPUT" != *"$expected"* ]]; then
    fail "$name" "expected safe diagnostic '$expected', got: $LAST_OUTPUT"
  else
    pass "$name"
  fi
}

assert_log() {
  local name="$1" expected="$2" actual
  actual="$(cat "$EVENT_LOG")"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected events:\n$expected\nactual events:\n$actual"
  fi
}

assert_file_absent_or_empty() {
  local name="$1" path="$2"
  if [[ ! -s "$path" ]]; then pass "$name"; else fail "$name" "$(cat "$path")"; fi
}

assert_no_material() {
  local name="$1" path="$2"
  if [[ -e "$path" ]] && grep -F -e "$OLD_PASSWORD" -e "$NEW_PASSWORD" \
      -e "$OLD_VERIFIER" -e "$NEW_VERIFIER" "$path" >/dev/null 2>&1; then
    fail "$name" 'credential material leaked'
  else
    pass "$name"
  fi
}

OLD_PASSWORD='OLD_DB_PASSWORD_SENTINEL_AAAAAAAAAAAAAA'
NEW_PASSWORD='NEW_DB_PASSWORD_SENTINEL_BBBBBBBBBBBBBB'
OLD_VERIFIER="$(printf '%s\n' "$OLD_PASSWORD" | pldb_password_to_verifier postgres)"
NEW_VERIFIER="$(printf '%s\n' "$NEW_PASSWORD" | pldb_password_to_verifier postgres)"
export OLD_PASSWORD NEW_PASSWORD OLD_VERIFIER NEW_VERIFIER

FAIL_STAGE=""
ALTER_RESULT_STATE=new
MALICIOUS_ALTER_OUTPUT=0
CALLBACK_LOCAL_SENTINEL=parent

record_event() {
  local event="$1"
  shift
  printf '%s\n' "$event" >>"$EVENT_LOG"
  printf '%s' "$event" >>"$ARGV_LOG"
  if [[ $# -gt 0 ]]; then printf '\t%s' "$*" >>"$ARGV_LOG"; fi
  printf '\n' >>"$ARGV_LOG"
}

stage_ok() {
  [[ "$FAIL_STAGE" != "$1" ]]
}

cb_guard() { record_event guard "$@"; stage_ok guard; }
cb_quiesce() { record_event quiesce "$@"; stage_ok quiesce; }
cb_assert_quiesced() {
  record_event assert_quiesced "$@"
  stage_ok assert_quiesced
}

cb_classify() {
  local role="${1:-}" old_verifier="" new_verifier="" extra=""
  record_event classify "$@"
  [[ "$role" == postgres ]] || return 1
  IFS= read -r old_verifier || return 1
  IFS= read -r new_verifier || return 1
  if IFS= read -r extra; then [[ -n "$extra" ]] || :; return 1; fi
  [[ "$old_verifier" == "$OLD_VERIFIER" &&
     "$new_verifier" == "$NEW_VERIFIER" ]] || return 1
  stage_ok classify || return 1
  cat "$STATE_FILE"
}

cb_alter() {
  local role="${1:-}" verifier="" extra=""
  record_event alter "$@"
  [[ "$role" == postgres ]] || return 1
  IFS= read -r verifier || return 1
  if IFS= read -r extra; then [[ -n "$extra" ]] || :; return 1; fi
  [[ "$verifier" == "$NEW_VERIFIER" ]] || return 1
  if [[ "$MALICIOUS_ALTER_OUTPUT" == 1 ]]; then
    printf '%s\n' "$NEW_PASSWORD"
    printf '%s\n' "$verifier" >&2
  fi
  stage_ok alter || return 1
  printf '%s\n' "$ALTER_RESULT_STATE" >"$STATE_FILE"
}

cb_role_new() {
  record_event role_new "$@"
  CALLBACK_LOCAL_SENTINEL=child
  stage_ok role_new
}

cb_apply() { record_event apply "$@"; stage_ok apply; }
cb_start_pools() { record_event start_pools "$@"; stage_ok start_pools; }
cb_verify_pools() { record_event verify_pools "$@"; stage_ok verify_pools; }
cb_start_consumers() {
  record_event start_consumers "$@"
  stage_ok start_consumers
}
cb_verify_runtime() {
  record_event verify_runtime "$@"
  stage_ok verify_runtime
}
cb_complete() { record_event complete "$@"; stage_ok complete; }
cb_fail_close() {
  local stage="${1:-missing}"
  record_event "fail_close:$stage"
  stage_ok fail_close
}

cb_assert_new() {
  local role="${1:-}" verifier="" extra=""
  record_event assert_new "$@"
  [[ "$role" == postgres ]] || return 1
  IFS= read -r verifier || return 1
  if IFS= read -r extra; then [[ -n "$extra" ]] || :; return 1; fi
  [[ "$verifier" == "$NEW_VERIFIER" && "$(cat "$STATE_FILE")" == new ]]
}

cb_rollback() {
  local role="${1:-}" verifier="" extra=""
  record_event rollback "$@"
  [[ "$role" == postgres ]] || return 1
  IFS= read -r verifier || return 1
  if IFS= read -r extra; then [[ -n "$extra" ]] || :; return 1; fi
  [[ "$verifier" == "$NEW_VERIFIER" ]] || return 1
  stage_ok rollback
}

export PLDB_GUARD_CALLBACK=cb_guard
export PLDB_QUIESCE_CALLBACK=cb_quiesce
export PLDB_ASSERT_QUIESCED_CALLBACK=cb_assert_quiesced
export PLDB_CLASSIFY_CALLBACK=cb_classify
export PLDB_ALTER_CALLBACK=cb_alter
export PLDB_ROLE_NEW_CALLBACK=cb_role_new
export PLDB_APPLY_CALLBACK=cb_apply
export PLDB_START_POOLS_CALLBACK=cb_start_pools
export PLDB_VERIFY_POOLS_CALLBACK=cb_verify_pools
export PLDB_START_CONSUMERS_CALLBACK=cb_start_consumers
export PLDB_VERIFY_RUNTIME_CALLBACK=cb_verify_runtime
export PLDB_COMPLETE_CALLBACK=cb_complete
export PLDB_FAIL_CLOSE_CALLBACK=cb_fail_close
export PLDB_ASSERT_NEW_CALLBACK=cb_assert_new
export PLDB_ROLLBACK_CALLBACK=cb_rollback

reset_fixture() {
  local state="${1:-old}" fail_stage="${2:-}"
  : >"$EVENT_LOG"
  : >"$ARGV_LOG"
  rm -f -- "$KUBECTL_CALLED"
  printf '%s\n' "$state" >"$STATE_FILE"
  FAIL_STAGE="$fail_stage"
  ALTER_RESULT_STATE=new
  MALICIOUS_ALTER_OUTPUT=0
  CALLBACK_LOCAL_SENTINEL=parent
}

invoke_rotation() {
  printf '%s\n%s\n' "$OLD_PASSWORD" "$NEW_PASSWORD" |
    pldb_run_rotation postgres
}

invoke_rotation_extra_line() {
  printf '%s\n%s\n%s\n' "$OLD_PASSWORD" "$NEW_PASSWORD" extra |
    pldb_run_rotation postgres
}

invoke_rotation_unterminated_extra() {
  printf '%s\n%s\n%s' "$OLD_PASSWORD" "$NEW_PASSWORD" extra |
    pldb_run_rotation postgres
}

invoke_rollback_new() {
  printf '%s\n' "$NEW_PASSWORD" | pldb_run_rollback_with_new postgres
}

invoke_rollback_old() {
  printf '%s\n' "$OLD_PASSWORD" | pldb_run_rollback_with_new postgres
}

if pldb_validate_role postgres && ! pldb_validate_role 'postgres;drop' &&
   pldb_validate_existing_password 'legacy:pass/with+symbols!' &&
   pldb_validate_password "$NEW_PASSWORD" &&
   ! pldb_validate_new_password 'legacy:pass/with+symbols!' &&
   ! pldb_validate_password short &&
   pldb_validate_verifier "$NEW_VERIFIER"; then
  pass 'validators accept only the constrained role, password and verifier forms'
else
  fail 'validators accept only the constrained role, password and verifier forms' 'validation mismatch'
fi

LEGACY_VERIFIER="$(printf '%s\n' 'legacy:pass/with+symbols!' |
  pldb_password_to_verifier postgres)"
if pldb_validate_verifier "$LEGACY_VERIFIER"; then
  pass 'existing legacy password symbols can be rotated while new values stay base64url-only'
else
  fail 'existing legacy password symbols can be rotated while new values stay base64url-only' \
    'legacy verifier was rejected'
fi
LEGACY_VERIFIER=""

if [[ "$OLD_VERIFIER" =~ ^md5[a-f0-9]{32}$ &&
      "$NEW_VERIFIER" =~ ^md5[a-f0-9]{32}$ &&
      "$OLD_VERIFIER" != "$NEW_VERIFIER" ]]; then
  pass 'passwords become distinct PostgreSQL MD5 verifiers through stdin'
else
  fail 'passwords become distinct PostgreSQL MD5 verifiers through stdin' 'invalid verifier'
fi

# shellcheck disable=SC2016 # Expanded by the isolated bash fixture.
expect_success 'pure classifier identifies old verifier' bash -c '
  source "$1"
  printf "%s\n%s\n%s\n" "$2" "$2" "$3" | pldb_classify_verifier | grep -qx old
' _ "$ROOT_DIR/deployment/lib/process-local-db-rotation.sh" "$OLD_VERIFIER" "$NEW_VERIFIER"
# shellcheck disable=SC2016 # Expanded by the isolated bash fixture.
expect_success 'pure classifier identifies new verifier' bash -c '
  source "$1"
  printf "%s\n%s\n%s\n" "$3" "$2" "$3" | pldb_classify_verifier | grep -qx new
' _ "$ROOT_DIR/deployment/lib/process-local-db-rotation.sh" "$OLD_VERIFIER" "$NEW_VERIFIER"
# shellcheck disable=SC2016 # Expanded by the isolated bash fixture.
expect_success 'pure classifier maps any other stored format to unknown' bash -c '
  source "$1"
  printf "SCRAM-SHA-256-fixture\n%s\n%s\n" "$2" "$3" | pldb_classify_verifier | grep -qx unknown
' _ "$ROOT_DIR/deployment/lib/process-local-db-rotation.sh" "$OLD_VERIFIER" "$NEW_VERIFIER"

CLASSIFY_SQL="$(printf '%s\n%s\n' "$OLD_VERIFIER" "$NEW_VERIFIER" |
  pldb_emit_classification_sql postgres)"
ALTER_SQL="$(printf '%s\n' "$NEW_VERIFIER" | pldb_emit_alter_sql postgres)"
SESSION_SQL="$(pldb_emit_session_quiescence_sql postgres)"
if [[ "$CLASSIFY_SQL" == *"COALESCE"* && "$CLASSIFY_SQL" == *"unknown"* &&
      "$CLASSIFY_SQL" == *'\pset tuples_only on'* &&
      "$CLASSIFY_SQL" == *"SET log_statement = 'none';"* &&
      "$CLASSIFY_SQL" == *"SET log_transaction_sample_rate = 0;"* &&
      "$CLASSIFY_SQL" == *"SET track_activities = off;"* &&
      "$CLASSIFY_SQL" == *"SET debug_print_parse = off;"* &&
      "$CLASSIFY_SQL" == *"SET pg_stat_statements.track = 'none';"* &&
      "$CLASSIFY_SQL" == *"SET pgaudit.log = 'none';"$'\n'"BEGIN;"$'\n'"SELECT COALESCE"* &&
      "$ALTER_SQL" == *"BEGIN;"* && "$ALTER_SQL" == *'ALTER ROLE "postgres"'* &&
      "$ALTER_SQL" == *"SET log_statement = 'none';"$'\n'"SET log_transaction_sample_rate = 0;"* &&
      "$ALTER_SQL" == *"SET track_activities = off;"* &&
      "$ALTER_SQL" == *"SET pgaudit.log = 'none';"$'\n'"BEGIN;"$'\n'"ALTER ROLE"* &&
      "$ALTER_SQL" == *"COMMIT;"* &&
      "$SESSION_SQL" == *"pg_stat_activity"* &&
      "$SESSION_SQL" == *"backend_type = 'client backend'"* &&
      "$SESSION_SQL" != *"usename ="* &&
      "$SESSION_SQL" == *"THEN 'residual' ELSE 'clear'"* &&
      "$CLASSIFY_SQL$ALTER_SQL" != *'\\set'* &&
      "$CLASSIFY_SQL$ALTER_SQL" != *'\\pset'* &&
      "$CLASSIFY_SQL$ALTER_SQL" != *"SET LOCAL"* &&
      "$CLASSIFY_SQL$ALTER_SQL" != *"$OLD_PASSWORD"* &&
      "$CLASSIFY_SQL$ALTER_SQL" != *"$NEW_PASSWORD"* ]]; then
  pass 'stream SQL disables server statement sampling before atomic verifier operations'
else
  fail 'stream SQL disables server statement sampling before atomic verifier operations' 'SQL contract mismatch'
fi
CLASSIFY_SQL=""
ALTER_SQL=""
SESSION_SQL=""

if ! printf '%s\nunterminated-extra' "$NEW_VERIFIER" |
    pldb_emit_alter_sql postgres >/dev/null 2>&1; then
  pass 'ALTER SQL emitter rejects unterminated trailing input'
else
  fail 'ALTER SQL emitter rejects unterminated trailing input' \
    'unterminated verifier material was accepted'
fi

reset_fixture old
expect_success 'happy path rotates then starts pools before other consumers' invoke_rotation
assert_log 'happy path ordering is exact' "$(printf '%s\n' \
  guard quiesce assert_quiesced classify alter classify role_new apply start_pools \
  verify_pools start_consumers verify_runtime complete)"
assert_no_material 'happy path emits no credential material' <(printf '%s' "$LAST_OUTPUT")
assert_no_material 'callbacks receive no credential material in argv' "$ARGV_LOG"
if [[ "$CALLBACK_LOCAL_SENTINEL" == parent ]]; then
  pass 'callback-local variables never become durable state in the parent'
else
  fail 'callback-local variables never become durable state in the parent' \
    'isolated callback state escaped to the parent'
fi

reset_fixture new
expect_success 'new verifier makes re-entry idempotent' invoke_rotation
assert_log 'idempotent re-entry skips ALTER' "$(printf '%s\n' \
  guard quiesce assert_quiesced classify role_new apply start_pools verify_pools \
  start_consumers verify_runtime complete)"

reset_fixture new role_new
expect_failure 'confirmed-new boundary must persist before manifest apply' \
  'persist-new-role-state' invoke_rotation
assert_log 'failed durable state transition starts no apply or consumer' "$(printf '%s\n' \
  guard quiesce assert_quiesced classify role_new \
  fail_close:persist-new-role-state)"

reset_fixture unknown
expect_failure 'unknown role state fails closed' 'unknown-role-state' invoke_rotation
assert_log 'unknown role state never applies or resumes' "$(printf '%s\n' \
  guard quiesce assert_quiesced classify fail_close:unknown-role-state)"
assert_no_material 'unknown-state diagnostic is redacted' <(printf '%s' "$LAST_OUTPUT")

reset_fixture old alter
expect_failure 'ALTER failure keeps consumers stopped' 'alter-role' invoke_rotation
assert_log 'ALTER failure enters fail-close immediately' "$(printf '%s\n' \
  guard quiesce assert_quiesced classify alter fail_close:alter-role)"
if [[ "$(cat "$STATE_FILE")" == old ]]; then
  pass 'failed ALTER leaves the old role state unchanged'
else
  fail 'failed ALTER leaves the old role state unchanged' "$(cat "$STATE_FILE")"
fi

reset_fixture old
ALTER_RESULT_STATE=unknown
expect_failure 'post-ALTER mismatch fails closed' 'verify-altered-role' invoke_rotation
assert_log 'post-ALTER mismatch is checked before manifest apply' "$(printf '%s\n' \
  guard quiesce assert_quiesced classify alter classify \
  fail_close:verify-altered-role)"

reset_fixture old apply
expect_failure 'partial manifest apply fails closed with the role already new' \
  'apply-new-credentials' invoke_rotation
assert_log 'apply failure starts no pools or consumers' "$(printf '%s\n' \
  guard quiesce assert_quiesced classify alter classify role_new apply \
  fail_close:apply-new-credentials)"
if [[ "$(cat "$STATE_FILE")" == new ]]; then
  pass 'post-ALTER failure never restores the old verifier'
else
  fail 'post-ALTER failure never restores the old verifier' "$(cat "$STATE_FILE")"
fi

reset_fixture old verify_pools
expect_failure 'pool verification failure prevents consumer resume' \
  'verify-pools' invoke_rotation
assert_log 'pool failure happens before dependent consumers' "$(printf '%s\n' \
  guard quiesce assert_quiesced classify alter classify role_new apply start_pools \
  verify_pools fail_close:verify-pools)"

reset_fixture old guard
expect_failure 'guard rejection performs no mutation' 'before quiescence' invoke_rotation
assert_log 'guard rejection neither quiesces nor invokes fail-close' 'guard'

reset_fixture old quiesce
expect_failure 'partial quiescence invokes fail-close' 'failed at quiesce' invoke_rotation
assert_log 'quiescence failure is fenced' "$(printf '%s\n' guard quiesce fail_close:quiesce)"

reset_fixture old
expect_failure 'extra password input is rejected before callbacks' \
  'exactly two lines' invoke_rotation_extra_line
assert_file_absent_or_empty 'invalid stdin performs no callback' "$EVENT_LOG"

reset_fixture old
expect_failure 'unterminated extra password input is rejected before callbacks' \
  'exactly two lines' invoke_rotation_unterminated_extra
assert_file_absent_or_empty 'unterminated extra stdin performs no callback' "$EVENT_LOG"

cb_guard_xtrace() {
  set -x
  record_event guard "$@"
}
reset_fixture old
PLDB_GUARD_CALLBACK=cb_guard_xtrace
expect_success 'callback xtrace is isolated from the credential driver' invoke_rotation
case "$-" in
  *x*) fail 'callback xtrace cannot poison the parent shell' 'parent xtrace remained enabled' ;;
  *) pass 'callback xtrace cannot poison the parent shell' ;;
esac
assert_no_material 'callback xtrace output remains suppressed' <(printf '%s' "$LAST_OUTPUT")
PLDB_GUARD_CALLBACK=cb_guard

reset_fixture old
MALICIOUS_ALTER_OUTPUT=1
expect_success 'callback stdout and stderr are suppressed during credential transport' invoke_rotation
assert_no_material 'malicious callback cannot leak through driver output' <(printf '%s' "$LAST_OUTPUT")
assert_no_material 'malicious callback cannot place credentials in argv log' "$ARGV_LOG"

reset_fixture new
expect_success 'rollback accepts only the new credential over stdin' invoke_rollback_new
assert_log 'rollback verifies new role before old workload specs are applied' "$(printf '%s\n' \
  guard quiesce assert_quiesced assert_new rollback start_pools verify_pools \
  start_consumers verify_runtime complete)"
assert_no_material 'rollback emits no credential material' <(printf '%s' "$LAST_OUTPUT")

reset_fixture new
expect_failure 'rollback cannot authenticate with the old credential' \
  'rollback-role-is-not-new' invoke_rollback_old
assert_log 'old-credential rollback fails before applying workload specs' "$(printf '%s\n' \
  guard quiesce assert_quiesced assert_new \
  fail_close:rollback-role-is-not-new)"

reset_fixture new rollback
expect_failure 'rollback apply failure remains fail-closed' 'rollback-apply' invoke_rollback_new
assert_log 'rollback failure resumes nothing' "$(printf '%s\n' \
  guard quiesce assert_quiesced assert_new rollback fail_close:rollback-apply)"

reset_fixture old
saved_callback="$PLDB_APPLY_CALLBACK"
PLDB_APPLY_CALLBACK='invalid/callback'
expect_failure 'invalid callback is rejected before reading credentials or mutating' \
  'PLDB_APPLY_CALLBACK' invoke_rotation
PLDB_APPLY_CALLBACK="$saved_callback"
assert_file_absent_or_empty 'invalid callback performs no operation' "$EVENT_LOG"

if [[ ! -e "$KUBECTL_CALLED" ]]; then
  pass 'the library and fixtures never invoke kubectl'
else
  fail 'the library and fixtures never invoke kubectl' 'kubectl stub was called'
fi

if [[ "$FAIL_COUNT" -ne 0 ]]; then
  printf '%s process-local DB rotation tests failed; %s passed.\n' \
    "$FAIL_COUNT" "$PASS_COUNT" >&2
  exit 1
fi
printf 'All %s process-local DB rotation tests passed using local callbacks only.\n' \
  "$PASS_COUNT"

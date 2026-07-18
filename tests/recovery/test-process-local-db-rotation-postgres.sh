#!/usr/bin/env bash

# Integration coverage for the credential-bearing SQL emitters.  With no
# external service configured this starts a private local PostgreSQL instance;
# CI supplies exact PostgreSQL 12 and 14 service containers.

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck source=deployment/lib/process-local-db-rotation.sh
source "$ROOT_DIR/deployment/lib/process-local-db-rotation.sh"

for command in grep mktemp; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Missing integration-test command: %s\n' "$command" >&2
    exit 1
  }
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-pldb-postgres.XXXXXX")"
LOCAL_SERVER=0
LOCAL_DATA=""
LOCAL_LOG="$TMP_DIR/postgres.log"
OLD_PGPASS="$TMP_DIR/old.pgpass"
NEW_PGPASS="$TMP_DIR/new.pgpass"
OTHER_PGPASS="$TMP_DIR/other.pgpass"
PATTERNS="$TMP_DIR/forbidden-verifiers"
PGUSER_TEST=postgres
PGDATABASE_TEST=postgres
OLD_PASSWORD=OldFixturePassword_AAAAAAAAAAAAAAAA
NEW_PASSWORD=NewFixturePassword_BBBBBBBBBBBBBBBB
OTHER_PASSWORD=OtherFixturePassword_CCCCCCCCCCCCC
SETUP_PASSWORD="${PLDB_SETUP_PASSWORD:-}"

cleanup() {
  if [[ "$LOCAL_SERVER" == 1 && -n "$LOCAL_DATA" ]]; then
    pg_ctl -D "$LOCAL_DATA" -m immediate stop >/dev/null 2>&1 || :
  fi
  find "$TMP_DIR" -depth -delete
}
trap cleanup EXIT INT TERM

if [[ -n "${PLDB_PGHOST:-}" ]]; then
  command -v psql >/dev/null 2>&1 || {
    printf 'psql is required for the configured PostgreSQL integration fixture.\n' >&2
    exit 1
  }
  PGHOST_TEST="$PLDB_PGHOST"
  PGPORT_TEST="${PLDB_PGPORT:-5432}"
  [[ -n "$SETUP_PASSWORD" ]] || {
    printf 'PLDB_SETUP_PASSWORD is required for an external PostgreSQL fixture.\n' >&2
    exit 2
  }
else
  for command in psql initdb pg_ctl; do
    command -v "$command" >/dev/null 2>&1 || {
      printf 'SKIP PostgreSQL integration: configure PLDB_PGHOST or install local psql/initdb/pg_ctl.\n'
      exit 0
    }
  done
  LOCAL_DATA="$TMP_DIR/data"
  PGHOST_TEST=127.0.0.1
  PGPORT_TEST="${PLDB_PGPORT:-55439}"
  initdb -D "$LOCAL_DATA" --auth-local=trust --auth-host=md5 \
    -U "$PGUSER_TEST" >/dev/null
  pg_ctl -D "$LOCAL_DATA" \
    -o "-k $TMP_DIR -h $PGHOST_TEST -p $PGPORT_TEST -c logging_collector=off -c log_destination=stderr" \
    -l "$LOCAL_LOG" -w start >/dev/null
  LOCAL_SERVER=1
fi

[[ "$PGPORT_TEST" =~ ^[1-9][0-9]{0,4}$ && "$PGPORT_TEST" -le 65535 ]] || {
  printf 'Invalid PostgreSQL integration port.\n' >&2
  exit 2
}

psql_base=(psql -X -q -v ON_ERROR_STOP=1 -h "$PGHOST_TEST" \
  -p "$PGPORT_TEST" -U "$PGUSER_TEST" -d "$PGDATABASE_TEST")

run_setup_psql() {
  if [[ "$LOCAL_SERVER" == 1 ]]; then
    psql -X -q -v ON_ERROR_STOP=1 -h "$TMP_DIR" -p "$PGPORT_TEST" \
      -U "$PGUSER_TEST" -d "$PGDATABASE_TEST" "$@"
  else
    PGPASSWORD="$SETUP_PASSWORD" "${psql_base[@]}" "$@"
  fi
}

# Turn on every stock PostgreSQL 12 statement/debug channel that could retain
# query text.  Each emitted psql program must disable them at session scope
# before its verifier-bearing SELECT/ALTER begins.
run_setup_psql >/dev/null <<'SQL'
ALTER SYSTEM SET log_statement = 'all';
ALTER SYSTEM SET log_min_duration_statement = 0;
ALTER SYSTEM SET log_duration = on;
ALTER SYSTEM SET log_transaction_sample_rate = 1;
ALTER SYSTEM SET debug_print_parse = on;
ALTER SYSTEM SET debug_print_rewritten = on;
ALTER SYSTEM SET debug_print_plan = on;
ALTER SYSTEM SET log_statement_stats = on;
ALTER SYSTEM SET track_activities = on;
SELECT pg_reload_conf();
SQL

OLD_VERIFIER="$(printf '%s\n' "$OLD_PASSWORD" |
  pldb_password_to_verifier "$PGUSER_TEST")"
NEW_VERIFIER="$(printf '%s\n' "$NEW_PASSWORD" |
  pldb_password_to_verifier "$PGUSER_TEST")"
OTHER_VERIFIER="$(printf '%s\n' "$OTHER_PASSWORD" |
  pldb_password_to_verifier aud065_other)"
printf '%s\n%s\n%s\n' "$OLD_VERIFIER" "$NEW_VERIFIER" "$OTHER_VERIFIER" >"$PATTERNS"
chmod 600 "$PATTERNS"

# Establish the exact legacy-MD5 starting state without sending plaintext to
# PostgreSQL or placing any password/verifier in argv.  Configure the auxiliary
# role first: on an external TCP fixture the following ALTER of postgres changes
# the setup credential immediately, so no later setup call may use it.
run_setup_psql -c 'CREATE ROLE aud065_other LOGIN' >/dev/null
printf '%s\n' "$OTHER_VERIFIER" | pldb_emit_alter_sql aud065_other |
  run_setup_psql >/dev/null
printf '%s\n' "$OLD_VERIFIER" | pldb_emit_alter_sql "$PGUSER_TEST" |
  run_setup_psql >/dev/null
SETUP_PASSWORD=""

printf '%s:%s:*:%s:%s\n' \
  "$PGHOST_TEST" "$PGPORT_TEST" "$PGUSER_TEST" "$OLD_PASSWORD" >"$OLD_PGPASS"
printf '%s:%s:*:%s:%s\n' \
  "$PGHOST_TEST" "$PGPORT_TEST" "$PGUSER_TEST" "$NEW_PASSWORD" >"$NEW_PGPASS"
printf '%s:%s:*:%s:%s\n' \
  "$PGHOST_TEST" "$PGPORT_TEST" aud065_other "$OTHER_PASSWORD" >"$OTHER_PGPASS"
chmod 600 "$OLD_PGPASS" "$NEW_PGPASS" "$OTHER_PGPASS"

classification="$(
  printf '%s\n%s\n' "$OLD_VERIFIER" "$NEW_VERIFIER" |
    pldb_emit_classification_sql "$PGUSER_TEST" |
    PGPASSFILE="$OLD_PGPASS" "${psql_base[@]}"
)"
[[ "$classification" == old ]] || {
  printf 'Initial PostgreSQL verifier classification was not old.\n' >&2
  exit 1
}

# SHOW runs after COMMIT in the same ephemeral session and proves that activity
# tracking remained disabled across the sensitive statement.
alter_output="$(
  {
    printf '%s\n' "$NEW_VERIFIER" | pldb_emit_alter_sql "$PGUSER_TEST"
    printf 'SHOW track_activities;\n'
  } | PGPASSFILE="$OLD_PGPASS" "${psql_base[@]}" -At
)"
[[ "$alter_output" == off ]] || {
  printf 'Credential session did not keep track_activities disabled.\n' >&2
  exit 1
}

classification="$(
  printf '%s\n%s\n' "$OLD_VERIFIER" "$NEW_VERIFIER" |
    pldb_emit_classification_sql "$PGUSER_TEST" |
    PGPASSFILE="$NEW_PGPASS" "${psql_base[@]}"
)"
[[ "$classification" == new ]] || {
  printf 'Rotated PostgreSQL verifier classification was not new.\n' >&2
  exit 1
}

if PGPASSFILE="$OLD_PGPASS" "${psql_base[@]}" -Atc 'select 1' \
    >/dev/null 2>&1; then
  printf 'A fresh connection still accepted the old password.\n' >&2
  exit 1
fi
PGPASSFILE="$NEW_PGPASS" "${psql_base[@]}" -Atc 'select 1' \
  >/dev/null 2>&1 || {
  printf 'A fresh connection rejected the new password.\n' >&2
  exit 1
}

session_state="$(
  pldb_emit_session_quiescence_sql "$PGUSER_TEST" |
    PGPASSFILE="$NEW_PGPASS" "${psql_base[@]}"
)"
[[ "$session_state" == clear ]] || {
  printf 'PostgreSQL reported a residual client session at the clear boundary.\n' >&2
  exit 1
}

PGPASSFILE="$NEW_PGPASS" "${psql_base[@]}" -Atc 'select pg_sleep(2)' \
  >/dev/null 2>&1 &
residual_pid=$!
sleep 0.2
session_state="$(
  pldb_emit_session_quiescence_sql "$PGUSER_TEST" |
    PGPASSFILE="$NEW_PGPASS" "${psql_base[@]}"
)"
wait "$residual_pid"
[[ "$session_state" == residual ]] || {
  printf 'PostgreSQL failed to detect a pre-existing client session.\n' >&2
  exit 1
}

PGPASSFILE="$OTHER_PGPASS" psql -X -q -v ON_ERROR_STOP=1 \
  -h "$PGHOST_TEST" -p "$PGPORT_TEST" -U aud065_other -d "$PGDATABASE_TEST" \
  -Atc 'select pg_sleep(2)' >/dev/null 2>&1 &
other_residual_pid=$!
sleep 0.2
session_state="$(
  pldb_emit_session_quiescence_sql "$PGUSER_TEST" |
    PGPASSFILE="$NEW_PGPASS" "${psql_base[@]}"
)"
wait "$other_residual_pid"
[[ "$session_state" == residual ]] || {
  printf 'PostgreSQL failed to detect a client session owned by another role.\n' >&2
  exit 1
}

# Flush one harmless statement, then inspect logs without ever printing them.
PGPASSFILE="$NEW_PGPASS" "${psql_base[@]}" -Atc 'select pg_sleep(0.1)' \
  >/dev/null 2>&1
if [[ -n "${PLDB_POSTGRES_CONTAINER_ID:-}" ]]; then
  command -v docker >/dev/null 2>&1 || {
    printf 'docker is required to inspect the PostgreSQL service log.\n' >&2
    exit 1
  }
  if docker logs "$PLDB_POSTGRES_CONTAINER_ID" 2>&1 |
      grep -F -f "$PATTERNS" >/dev/null; then
    printf 'A verifier appeared in PostgreSQL service logs.\n' >&2
    exit 1
  fi
elif [[ "$LOCAL_SERVER" == 1 ]]; then
  if grep -F -f "$PATTERNS" "$LOCAL_LOG" >/dev/null; then
    printf 'A verifier appeared in PostgreSQL local logs.\n' >&2
    exit 1
  fi
else
  printf 'No PostgreSQL log source was supplied for integration verification.\n' >&2
  exit 2
fi

OLD_PASSWORD=""
NEW_PASSWORD=""
OLD_VERIFIER=""
NEW_VERIFIER=""
OTHER_PASSWORD=""
OTHER_VERIFIER=""
classification=""
alter_output=""
session_state=""
printf 'PostgreSQL credential rotation integration passed with fresh-auth rejection and redacted server logs.\n'

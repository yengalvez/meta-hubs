#!/usr/bin/env bash

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d /tmp/yenhubs-recovery-tests.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
PASS_COUNT=0
FAIL_COUNT=0
LAST_OUTPUT=""

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %s - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'not ok %s - %s\n%s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1" "$2" >&2
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
  local name="$1"
  local expected="$2"
  shift 2
  if LAST_OUTPUT="$("$@" 2>&1)"; then
    fail "$name" 'command unexpectedly succeeded'
  elif [[ "$LAST_OUTPUT" != *"$expected"* ]]; then
    fail "$name" "expected error containing '$expected', got: $LAST_OUTPUT"
  else
    pass "$name"
  fi
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

make_sql_fixture() {
  local plain_path="$1"
  local gzip_path="$2"

  {
    printf 'CREATE SCHEMA ret0;\n'
    printf 'CREATE TABLE ret0.schema_migrations (version bigint);\n'
    printf 'COPY ret0.schema_migrations (version) FROM stdin;\n1\n\\.\n'
    printf 'COPY ret0.owned_files (owned_file_uuid, state) FROM stdin;\n'
    printf 'active-one\tactive\n'
    printf 'deferred-one\texpiring\n'
    printf '\\.\n'
  } >"$plain_path"
  gzip -c "$plain_path" >"$gzip_path"
}

make_storage_fixture() {
  local fixture_name="$1"
  local mode="$2"
  local tree="$TMP_DIR/$fixture_name-tree"
  local tar_path="$TMP_DIR/$fixture_name.tar"
  local gzip_path="$TMP_DIR/$fixture_name.tar.gz"

  mkdir -p "$tree/owned/aa" "$tree/owned/dd"
  if [[ "$mode" != "missing-active" ]]; then
    printf 'blob' >"$tree/owned/aa/active-one.blob"
    printf '{}' >"$tree/owned/aa/active-one.meta.json"
  fi
  if [[ "$mode" == "symlink" ]]; then
    ln -s ../../outside "$tree/owned/dd/deferred-one.blob"
  else
    printf 'blob' >"$tree/owned/dd/deferred-one.blob"
  fi
  if [[ "$mode" != "incomplete" ]]; then
    printf '{}' >"$tree/owned/dd/deferred-one.meta.json"
  fi
  tar -C "$tree" -cf "$tar_path" owned
  gzip -c "$tar_path" >"$gzip_path"
  printf '%s\n' "$gzip_path"
}

SQL_PLAIN="$TMP_DIR/retdb.sql"
SQL_GZIP="$TMP_DIR/retdb.sql.gz"
make_sql_fixture "$SQL_PLAIN" "$SQL_GZIP"
VALID_STORAGE="$(make_storage_fixture valid valid)"
MISSING_STORAGE="$(make_storage_fixture missing missing-active)"
INCOMPLETE_STORAGE="$(make_storage_fixture incomplete incomplete)"
SYMLINK_STORAGE="$(make_storage_fixture symlink symlink)"
VALID_TAR="$TMP_DIR/valid.tar"

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/stub-state"
KUBECTL_LOG="$TMP_DIR/kubectl.log"
export KUBECTL_LOG

cat >"$TMP_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$KUBECTL_LOG"

if [[ "${1:-}" == "--context" ]]; then
  shift 2
fi
joined="$*"

if [[ "$joined" == "config current-context" ]]; then
  printf '%s' "${STUB_CURRENT_CONTEXT:-fixture-context}"
  exit 0
fi
if [[ "$joined" == get\ namespace\ * ]]; then
  printf '%s' "${STUB_NAMESPACE_UID:-fixture-uid}"
  exit 0
fi
if [[ "$joined" == rollout\ status\ * || "$joined" == get\ pvc\ * ]]; then
  exit 0
fi
if [[ "$joined" == get\ pod\ *"-l app=pgsql"*"jsonpath"* ]]; then
  printf 'pgsql-0'
  exit 0
fi
if [[ "$joined" == get\ pod\ *"-l app=reticulum"*"jsonpath"* ]]; then
  printf 'reticulum-0'
  exit 0
fi
if [[ "$joined" == get\ deployment\ * ]]; then
  deployment="${3:-}"
  case ",${STUB_DEPLOYMENTS:-}," in
    *",$deployment,"*) ;;
    *) exit 1 ;;
  esac
  if [[ "$joined" == *".spec.replicas"* ]]; then
    printf '1'
  elif [[ "$joined" == *".spec.selector.matchLabels.app"* ]]; then
    printf '%s' "$deployment"
  elif [[ "$joined" == *".spec.template.spec.containers"* ]]; then
    printf 'registry.invalid/reticulum@sha256:fixture'
  fi
  exit 0
fi
if [[ "$joined" == get\ pod\ *"-o name"* ]]; then
  if [[ "$joined" == *"-l app="* ]]; then
    if [[ ! -e "${STUB_STATE_DIR:?}/waited" ]]; then
      printf 'pod/workload-0\n'
    elif [[ "${STUB_MODE:-}" == "residual" ]]; then
      printf 'pod/workload-still-running\n'
    fi
    exit 0
  fi
  exit 1
fi
if [[ "$joined" == wait\ --for=delete\ * ]]; then
  if [[ "${STUB_MODE:-}" == "timeout" ]]; then
    exit 1
  fi
  : >"${STUB_STATE_DIR:?}/waited"
  exit 0
fi
if [[ "$joined" == wait\ --for=condition=Ready\ * ]]; then
  exit 0
fi
if [[ "$joined" == scale\ deployment\ * || "$joined" == delete\ pod\ * ]]; then
  exit 0
fi
if [[ "$joined" == apply\ -f\ - ]]; then
  while IFS= read -r _line; do :; done
  exit 0
fi
if [[ "$joined" == exec\ * ]]; then
  if [[ "$joined" == *"pg_dump"* ]]; then
    cat "${STUB_SQL_PLAIN:?}"
  elif [[ "$joined" == *"count(*) from information_schema.tables"* ]]; then
    printf '1\n1\n1\n'
  elif [[ "$joined" == *"select count(*) from ret0.owned_files"* ]]; then
    printf '1\n'
  elif [[ "$joined" == *"select owned_file_uuid from ret0.owned_files"* ]]; then
    printf 'active-one\n'
  elif [[ "$joined" == *"basename {} .meta.json"* ]]; then
    printf 'active-one\ndeferred-one\n'
  elif [[ "$joined" == *"basename {} .blob"* ]]; then
    printf 'active-one\ndeferred-one\n'
  elif [[ "$joined" == *"find /storage/owned -type f 2>/dev/null"* ]]; then
    printf '0\n'
  elif [[ "$joined" == *"find /storage/owned"*"wc -l"* ]]; then
    printf '2\n2\n'
  elif [[ "$joined" == *"tar -C /storage -cf - owned"* ]]; then
    cat "${STUB_TAR_STREAM:?}"
  else
    printf '0\n'
  fi
  exit 0
fi

printf 'Unhandled kubectl stub call: %s\n' "$joined" >&2
exit 90
STUB
chmod 700 "$TMP_DIR/bin/kubectl"

export PATH="$TMP_DIR/bin:$PATH"
export STUB_STATE_DIR="$TMP_DIR/stub-state"
export STUB_SQL_PLAIN="$SQL_PLAIN"
export STUB_TAR_STREAM="$VALID_TAR"

reset_stub() {
  : >"$KUBECTL_LOG"
  rm -f "$STUB_STATE_DIR/waited"
}

expect_success 'offline validator accepts complete deferred pairs' \
  "$ROOT_DIR/deployment/validate-checkpoint.sh" "$SQL_GZIP" "$VALID_STORAGE"
expect_failure 'offline validator rejects a missing active pair' 'missing_active_blobs=1' \
  "$ROOT_DIR/deployment/validate-checkpoint.sh" "$SQL_GZIP" "$MISSING_STORAGE"
expect_failure 'offline validator rejects any incomplete physical pair' 'incomplete_pairs=1' \
  "$ROOT_DIR/deployment/validate-checkpoint.sh" "$SQL_GZIP" "$INCOMPLETE_STORAGE"
expect_failure 'offline validator rejects archive links' 'links or unsupported entry types' \
  "$ROOT_DIR/deployment/validate-checkpoint.sh" "$SQL_GZIP" "$SYMLINK_STORAGE"

VALIDATOR_LINE="$(awk '/validate-checkpoint\.sh/ { print NR; exit }' "$ROOT_DIR/deployment/create-checkpoint.sh")"
CHECKSUM_LINE="$(awk '/CHECKSUM_TMP=/ { print NR; exit }' "$ROOT_DIR/deployment/create-checkpoint.sh")"
if [[ -n "$VALIDATOR_LINE" && -n "$CHECKSUM_LINE" && "$VALIDATOR_LINE" -lt "$CHECKSUM_LINE" ]]; then
  pass 'checkpoint content validation precedes SHA256SUMS creation'
else
  fail 'checkpoint content validation precedes SHA256SUMS creation' \
    "validator_line=${VALIDATOR_LINE:-missing} checksum_line=${CHECKSUM_LINE:-missing}"
fi

reset_stub
expect_success 'database preflight is explicitly read-only' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  RESTORE_PREFLIGHT=1 STUB_DEPLOYMENTS= \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$SQL_GZIP"
if grep -Eq ' scale | exec | apply ' "$KUBECTL_LOG"; then
  fail 'database preflight emits no mutating kubectl call' "$(cat "$KUBECTL_LOG")"
else
  pass 'database preflight emits no mutating kubectl call'
fi
if awk '$0 != "config current-context" && $0 !~ /^--context fixture-context / { bad=1 } END { exit bad ? 0 : 1 }' \
  "$KUBECTL_LOG"; then
  fail 'all cluster calls are bound to the expected context' "$(cat "$KUBECTL_LOG")"
else
  pass 'all cluster calls are bound to the expected context'
fi

reset_stub
expect_failure 'wrong kubectl context fails before cluster access' 'kubectl context mismatch' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  RESTORE_PREFLIGHT=1 STUB_CURRENT_CONTEXT=wrong-context \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$SQL_GZIP"
if grep -q -- '--context fixture-context get namespace' "$KUBECTL_LOG"; then
  fail 'context mismatch does not query the target' "$(cat "$KUBECTL_LOG")"
else
  pass 'context mismatch does not query the target'
fi

reset_stub
expect_failure 'wrong namespace UID is rejected' 'Namespace UID mismatch' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  RESTORE_PREFLIGHT=1 STUB_NAMESPACE_UID=recreated-uid \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$SQL_GZIP"

reset_stub
expect_failure 'generic database confirmation is rejected before scale' 'for this exact target' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  CONFIRM_RESTORE=retdb STUB_DEPLOYMENTS=reticulum \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$SQL_GZIP"
if grep -q ' scale ' "$KUBECTL_LOG"; then
  fail 'bad confirmation performs no scale' "$(cat "$KUBECTL_LOG")"
else
  pass 'bad confirmation performs no scale'
fi

reset_stub
expect_failure 'pod deletion timeout blocks database mutation' 'Timed out waiting' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  CONFIRM_RESTORE=retdb:fixture-context:hcce:fixture-uid \
  STUB_DEPLOYMENTS=reticulum STUB_MODE=timeout \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$SQL_GZIP"
if grep -q ' exec ' "$KUBECTL_LOG"; then
  fail 'database timeout never invokes destructive exec' "$(cat "$KUBECTL_LOG")"
else
  pass 'database timeout never invokes destructive exec'
fi

reset_stub
expect_failure 'remaining consumer pod blocks database mutation' 'Pods still remain' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  CONFIRM_RESTORE=retdb:fixture-context:hcce:fixture-uid \
  STUB_DEPLOYMENTS=reticulum STUB_MODE=residual \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$SQL_GZIP"
if grep -q ' exec ' "$KUBECTL_LOG"; then
  fail 'remaining database pod never invokes destructive exec' "$(cat "$KUBECTL_LOG")"
else
  pass 'remaining database pod never invokes destructive exec'
fi

reset_stub
expect_success 'exact database confirmation completes the stubbed restore path' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  CONFIRM_RESTORE=retdb:fixture-context:hcce:fixture-uid \
  STUB_DEPLOYMENTS=reticulum STUB_MODE=normal \
  "$ROOT_DIR/deployment/restore-retdb.sh" "$SQL_GZIP"
if grep -q 'dropdb' "$KUBECTL_LOG" && grep -q -- '--replicas=1' "$KUBECTL_LOG"; then
  pass 'stubbed database restore mutates only after exact confirmation and resumes replicas'
else
  fail 'stubbed database restore mutates only after exact confirmation and resumes replicas' \
    "$(cat "$KUBECTL_LOG")"
fi

reset_stub
expect_success 'storage preflight validates DB/archive without writes' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  RESTORE_STORAGE_PREFLIGHT=1 STUB_DEPLOYMENTS= \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" "$VALID_STORAGE"
if grep -Eq ' scale | apply ' "$KUBECTL_LOG"; then
  fail 'storage preflight emits no write operation' "$(cat "$KUBECTL_LOG")"
else
  pass 'storage preflight emits no write operation'
fi

reset_stub
expect_failure 'storage restore rejects links before cluster access' 'links or unsupported entry types' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  RESTORE_STORAGE_PREFLIGHT=1 STUB_DEPLOYMENTS= \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" "$SYMLINK_STORAGE"
if [[ -s "$KUBECTL_LOG" ]]; then
  fail 'unsafe storage archive performs no kubectl call' "$(cat "$KUBECTL_LOG")"
else
  pass 'unsafe storage archive performs no kubectl call'
fi

reset_stub
expect_failure 'Reticulum deletion timeout blocks restore pod and PVC write' 'Timed out waiting' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  CONFIRM_RESTORE_STORAGE=ret-pvc:fixture-context:hcce:fixture-uid \
  STUB_DEPLOYMENTS=reticulum STUB_MODE=timeout \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" "$VALID_STORAGE"
if grep -Eq ' apply |tar -C /storage -xf' "$KUBECTL_LOG"; then
  fail 'Reticulum timeout prevents restore pod/PVC writes' "$(cat "$KUBECTL_LOG")"
else
  pass 'Reticulum timeout prevents restore pod/PVC writes'
fi

reset_stub
expect_failure 'remaining Reticulum pod blocks restore pod and PVC write' 'Pods still remain' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  CONFIRM_RESTORE_STORAGE=ret-pvc:fixture-context:hcce:fixture-uid \
  STUB_DEPLOYMENTS=reticulum STUB_MODE=residual \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" "$VALID_STORAGE"
if grep -Eq ' apply |tar -C /storage -xf' "$KUBECTL_LOG"; then
  fail 'remaining Reticulum pod prevents restore pod/PVC writes' "$(cat "$KUBECTL_LOG")"
else
  pass 'remaining Reticulum pod prevents restore pod/PVC writes'
fi

reset_stub
expect_success 'exact storage confirmation completes the stubbed restore path' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  CONFIRM_RESTORE_STORAGE=ret-pvc:fixture-context:hcce:fixture-uid \
  STUB_DEPLOYMENTS=reticulum STUB_MODE=normal \
  "$ROOT_DIR/deployment/restore-ret-storage.sh" "$VALID_STORAGE"
if grep -q ' apply -f -' "$KUBECTL_LOG" && grep -q -- '--replicas=1' "$KUBECTL_LOG"; then
  pass 'stubbed storage restore writes only after exact confirmation and resumes Reticulum'
else
  fail 'stubbed storage restore writes only after exact confirmation and resumes Reticulum' \
    "$(cat "$KUBECTL_LOG")"
fi

reset_stub
DB_BACKUP="$TMP_DIR/mode/retdb.sql.gz"
expect_success 'database backup succeeds against the isolated stub' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  STUB_DEPLOYMENTS= \
  "$ROOT_DIR/deployment/backup-retdb.sh" "$DB_BACKUP"
if [[ "$(file_mode "$DB_BACKUP")" == "600" ]]; then
  pass 'database backup is mode 0600'
else
  fail 'database backup is mode 0600' "mode=$(file_mode "$DB_BACKUP")"
fi

reset_stub
STORAGE_BACKUP="$TMP_DIR/mode/ret-storage.tar.gz"
expect_success 'storage backup succeeds against the isolated stub' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  STUB_DEPLOYMENTS= \
  "$ROOT_DIR/deployment/backup-ret-storage.sh" "$STORAGE_BACKUP"
if [[ "$(file_mode "$STORAGE_BACKUP")" == "600" ]]; then
  pass 'storage backup is mode 0600'
else
  fail 'storage backup is mode 0600' "mode=$(file_mode "$STORAGE_BACKUP")"
fi

reset_stub
UNSAFE_BACKUP="$TMP_DIR/mode/unsafe-ret-storage.tar.gz"
expect_failure 'storage backup rejects a symlink emitted by the source volume' 'links or unsupported entry types' \
  env EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid \
  STUB_DEPLOYMENTS= STUB_TAR_STREAM="$TMP_DIR/symlink.tar" \
  "$ROOT_DIR/deployment/backup-ret-storage.sh" "$UNSAFE_BACKUP"
if [[ ! -e "$UNSAFE_BACKUP" ]]; then
  pass 'rejected storage backup leaves no final artifact'
else
  fail 'rejected storage backup leaves no final artifact' "unexpected=$UNSAFE_BACKUP"
fi

if [[ "$FAIL_COUNT" -ne 0 ]]; then
  printf '%s recovery safety test(s) failed; %s passed.\n' "$FAIL_COUNT" "$PASS_COUNT" >&2
  exit 1
fi
printf 'All %s recovery safety tests passed using local fixtures only.\n' "$PASS_COUNT"

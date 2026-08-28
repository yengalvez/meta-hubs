#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_RECEIPT_SCHEMA="yenhubs-project-verification-v2"
VERIFY_AUDIT_MAX_AGE_SECONDS="${VERIFY_AUDIT_MAX_AGE_SECONDS:-86400}"
VERIFY_EVIDENCE_DIR="${YENHUBS_VERIFY_EVIDENCE_DIR:-}"
if [[ -n "${YENHUBS_RETICULUM_TEST_DB_CREDENTIALS:-}" ]]; then
  VERIFY_RETICULUM_TEST_DB_CREDENTIALS="$YENHUBS_RETICULUM_TEST_DB_CREDENTIALS"
elif [[ "$(uname -s)" == Darwin ]]; then
  # Homebrew PostgreSQL initializes its local development role from the macOS
  # account name. Linux CI uses the explicit postgres role instead.
  VERIFY_RETICULUM_TEST_DB_CREDENTIALS="$(id -un)"
else
  VERIFY_RETICULUM_TEST_DB_CREDENTIALS=postgres
fi

VERIFY_NORMAL_SECTIONS=(advisories static security recovery)
VERIFY_FULL_SECTIONS=(
  advisories static security recovery hubs browser-capacity h5 hcce
  bot-orchestrator dialog photomnemonic coturn spoke reticulum composition
)

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/verify-project.sh
  scripts/verify-project.sh --full [--evidence-dir ABSOLUTE_PRIVATE_DIR]
  scripts/verify-project.sh --section NAME [--evidence-dir ABSOLUTE_PRIVATE_DIR]
  scripts/verify-project.sh --finalize --evidence-dir ABSOLUTE_PRIVATE_DIR
  scripts/verify-project.sh --list-sections

Normal and full modes preserve successful section receipts and continue after
an independent section fails. A receipt is reusable only while its declared
inputs, verification harness, toolchain, private log and cleanup result match.
Without --evidence-dir, receipts live in one stable private per-user cache
outside the checkout so a later invocation does not repeat unchanged sections.
USAGE
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    return 1
  }
}

sha256_stream() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

sha256_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    sha256sum "$path" | awk '{print $1}'
  fi
}

portable_file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

portable_file_owner() {
  stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1"
}

verification_section_is_known() {
  local candidate="$1" section
  for section in "${VERIFY_FULL_SECTIONS[@]}"; do
    [[ "$candidate" != "$section" ]] || return 0
  done
  return 1
}

verification_section_inputs() {
  case "$1" in
    advisories)
      cat <<'INPUTS'
hubs	package.json
hubs	package-lock.json
hubs	admin/package.json
hubs	admin/package-lock.json
root	tests/browser/package.json
root	tests/browser/package-lock.json
root	tests/capacity/package.json
root	tests/capacity/package-lock.json
cloud	community-edition/package.json
cloud	community-edition/package-lock.json
cloud	community-edition/services/bot-orchestrator/package.json
cloud	community-edition/services/bot-orchestrator/package-lock.json
cloud	community-edition/services/dialog/package.json
cloud	community-edition/services/dialog/package-lock.json
cloud	community-edition/services/dialog/Dockerfile
cloud	community-edition/services/photomnemonic/package.json
cloud	community-edition/services/photomnemonic/package-lock.json
cloud	community-edition/services/reticulum/mix.exs
cloud	community-edition/services/reticulum/mix.lock
cloud	community-edition/services/reticulum/scripts/verify-cowlib-security-contract.sh
INPUTS
      ;;
    static)
      printf 'root\t.\nhubs\t.\ncloud\t.\n'
      ;;
    security)
      printf 'root\t.\ncloud\tcommunity-edition\n'
      ;;
    recovery | h5)
      cat <<'INPUTS'
root	deployment
root	tests/recovery
root	tests/scripts
root	scripts/test-aud065.sh
root	scripts/verify-gitlinks.sh
cloud	community-edition/apply
cloud	community-edition/generate_script
cloud	community-edition/input-values.ci.yaml
cloud	community-edition/package.json
cloud	community-edition/package-lock.json
cloud	community-edition/services/bot-orchestrator/kubernetes-runner-manager.js
INPUTS
      ;;
    hubs)
      printf 'hubs\t.\n'
      ;;
    browser-capacity)
      printf 'root\ttests/browser\nroot\ttests/capacity\nhubs\t.\n'
      ;;
    hcce)
      printf 'cloud\tcommunity-edition\n'
      ;;
    bot-orchestrator)
      printf 'cloud\tcommunity-edition/services/bot-orchestrator\n'
      ;;
    dialog)
      printf 'cloud\tcommunity-edition/services/dialog\n'
      ;;
    photomnemonic)
      printf 'cloud\tcommunity-edition/services/photomnemonic\n'
      ;;
    coturn)
      printf 'cloud\tcommunity-edition/services/coturn\n'
      ;;
    spoke)
      printf 'cloud\tcommunity-edition/services/spoke\n'
      ;;
    reticulum)
      printf 'cloud\tcommunity-edition/services/reticulum\n'
      ;;
    composition)
      cat <<'INPUTS'
root	scripts/verify-project.sh
root	scripts/verify-gitlinks.sh
cloud	community-edition/apply
cloud	community-edition/generate_script
cloud	community-edition/input-values.ci.yaml
cloud	community-edition/package.json
cloud	community-edition/package-lock.json
INPUTS
      ;;
    *) return 2 ;;
  esac
}

repository_path_for_label() {
  case "$1" in
    root) printf '%s\n' "$ROOT_DIR" ;;
    hubs) printf '%s\n' "$ROOT_DIR/hubs" ;;
    cloud) printf '%s\n' "$ROOT_DIR/hubs-cloud" ;;
    *) return 2 ;;
  esac
}

verification_section_input_sha256() {
  local section="$1" label relative repository file absolute kind digest executable
  {
    while IFS=$'\t' read -r label relative; do
      [[ -n "$label" && -n "$relative" ]] || continue
      repository="$(repository_path_for_label "$label")" || exit 2
      git -C "$repository" ls-files -co --exclude-standard -z -- "$relative" |
        while IFS= read -r -d '' file; do
          absolute="$repository/$file"
          if [[ -L "$absolute" ]]; then
            kind='symlink'
            digest="$(printf '%s' "$(readlink "$absolute")" | sha256_stream)"
            executable=0
          elif [[ -f "$absolute" ]]; then
            kind='file'
            digest="$(git -C "$repository" hash-object --no-filters "$file")"
            if [[ -x "$absolute" ]]; then executable=1; else executable=0; fi
          else
            kind='missing'
            digest='missing'
            executable=0
          fi
          printf '%s\0%s\0%s\0%s\0%s\0' \
            "$label" "$file" "$kind" "$digest" "$executable"
        done
    done < <(verification_section_inputs "$section")
  } | sha256_stream
}

tool_version_or_missing() {
  if command -v "$1" >/dev/null 2>&1; then
    "$@" 2>/dev/null || printf 'unavailable\n'
  else
    printf 'missing\n'
  fi
}

verification_common_toolchain_material() {
  printf 'kernel='; uname -srm 2>/dev/null || true
  printf 'bash='; bash --version 2>/dev/null | head -n 1 || true
  printf 'git='; git --version 2>/dev/null || true
}

verification_section_toolchain_sha256() {
  local section="$1"
  {
    verification_common_toolchain_material
    printf 'section=%s\n' "$section"
    case "$section" in
      advisories)
        tool_version_or_missing node --version
        tool_version_or_missing npm --version
        tool_version_or_missing curl --version
        tool_version_or_missing jq --version
        tool_version_or_missing mise --version
        tool_version_or_missing mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- elixir --version
        tool_version_or_missing mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- mix --version
        ;;
      static)
        tool_version_or_missing actionlint -version
        tool_version_or_missing shellcheck --version
        tool_version_or_missing gitleaks version
        tool_version_or_missing node --version
        tool_version_or_missing npm --version
        ;;
      security | browser-capacity | hcce | bot-orchestrator | dialog | photomnemonic | spoke)
        tool_version_or_missing node --version
        tool_version_or_missing npm --version
        ;;
      recovery | h5)
        tool_version_or_missing node --version
        tool_version_or_missing jq --version
        ;;
      coturn)
        tool_version_or_missing shellcheck --version
        ;;
      reticulum)
        tool_version_or_missing mise --version
        tool_version_or_missing mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- elixir --version
        tool_version_or_missing mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- mix --version
        ;;
      composition)
        tool_version_or_missing node --version
        tool_version_or_missing npm --version
        ;;
      hubs)
        tool_version_or_missing node --version
        tool_version_or_missing npm --version
        ;;
      *) return 2 ;;
    esac
  } | sha256_stream
}

verification_common_harness_material() {
  printf 'schema=%s\n' "$VERIFY_RECEIPT_SCHEMA"
  printf 'audit_max_age_semantics=seconds\n'
  printf 'section_harness_algorithm=declared-functions-v1\n'
  declare -f \
    ensure_private_evidence_dir \
    default_verification_evidence_dir \
    known_verification_processes_are_absent \
    portable_file_mode \
    portable_file_owner \
    receipt_has_exact_keys \
    receipt_is_current \
    receipt_value \
    repository_path_for_label \
    run_recorded_section \
    run_section_set \
    section_receipt_path \
    section_was_recorded_as_failed \
    sha256_file \
    sha256_stream \
    tool_version_or_missing \
    verification_common_harness_material \
    verification_common_toolchain_material \
    verification_section_harness_sha256 \
    verification_section_input_sha256 \
    verification_section_toolchain_sha256 \
    write_pass_receipt
}

verification_section_harness_material() {
  local section="$1"
  verification_common_harness_material
  printf 'section=%s\n' "$section"
  verification_section_inputs "$section"
  case "$section" in
    advisories) declare -f require_command run_advisories ;;
    static) declare -f require_command run_static ;;
    security) declare -f run_security ;;
    recovery) declare -f run_recovery ;;
    hubs) declare -f run_hubs ;;
    browser-capacity) declare -f run_browser_capacity ;;
    h5) declare -f run_h5 ;;
    hcce) declare -f run_hcce_fixture run_hcce ;;
    bot-orchestrator) declare -f run_bot_orchestrator ;;
    dialog) declare -f run_dialog ;;
    photomnemonic) declare -f run_photomnemonic ;;
    coturn) declare -f run_coturn ;;
    spoke) declare -f run_spoke ;;
    reticulum)
      printf 'reticulum_db_credentials_sha256=%s\n' \
        "$(printf '%s' "$VERIFY_RETICULUM_TEST_DB_CREDENTIALS" | sha256_stream)"
      declare -f require_command run_reticulum
      ;;
    composition) declare -f run_hcce_fixture run_composition ;;
    *) return 2 ;;
  esac
}

verification_section_harness_sha256() {
  verification_section_harness_material "$1" | sha256_stream
}

default_verification_evidence_dir() {
  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}"
  case "$cache_root" in
    /*) ;;
    *) return 2 ;;
  esac
  printf '%s\n' "$cache_root/yenhubs/project-verification"
}

ensure_private_evidence_dir() {
  local requested="$1" mode owner
  if [[ -z "$requested" ]]; then
    requested="$(default_verification_evidence_dir)" || {
      printf 'The default verification evidence directory is unavailable.\n' >&2
      return 2
    }
  fi
  case "$requested" in
    /*) ;;
    *)
      printf 'The verification evidence directory must be absolute.\n' >&2
      return 2
      ;;
  esac
  case "$requested/" in
    "$ROOT_DIR/"*)
      printf 'The verification evidence directory must be outside the checkout.\n' >&2
      return 2
      ;;
  esac
  if [[ ! -e "$requested" ]]; then
    mkdir -p "$requested"
    chmod 700 "$requested"
  fi
  [[ -d "$requested" && ! -L "$requested" ]] || {
    printf 'The verification evidence path must be a real directory.\n' >&2
    return 2
  }
  mode="$(portable_file_mode "$requested")"
  owner="$(portable_file_owner "$requested")"
  [[ "$mode" == 700 && "$owner" == "$(id -u)" ]] || {
    printf 'The verification evidence directory must be owned by this user and mode 0700.\n' >&2
    return 2
  }
  VERIFY_EVIDENCE_DIR="$requested"
  export VERIFY_EVIDENCE_DIR
  printf 'Verification evidence directory: %s\n' "$VERIFY_EVIDENCE_DIR"
}

receipt_value() {
  local receipt="$1" key="$2"
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print }' "$receipt"
}

receipt_has_exact_keys() {
  local receipt="$1" keys
  [[ "$(wc -l <"$receipt" | tr -d '[:space:]')" == 13 ]] || return 1
  [[ "$(cut -d= -f1 "$receipt" | LC_ALL=C sort | uniq -d | wc -l | tr -d '[:space:]')" == 0 ]] || return 1
  keys="$(cut -d= -f1 "$receipt" | LC_ALL=C sort | tr '\n' ' ')"
  [[ "$keys" == 'cleanup cloud_head finished_epoch harness_sha256 hubs_head input_sha256 log_sha256 root_head schema section started_epoch status toolchain_sha256 ' ]]
}

section_receipt_path() {
  printf '%s/%s/%s.receipt\n' "$VERIFY_EVIDENCE_DIR" "$1" "$2"
}

receipt_is_current() {
  local section="$1" receipt="$2" expected_input="$3"
  local finished now max_age log_path
  [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
  [[ "$(portable_file_mode "$receipt")" == 600 ]] || return 1
  [[ "$(portable_file_owner "$receipt")" == "$(id -u)" ]] || return 1
  receipt_has_exact_keys "$receipt" || return 1
  [[ "$(receipt_value "$receipt" schema)" == "$VERIFY_RECEIPT_SCHEMA" ]] || return 1
  [[ "$(receipt_value "$receipt" section)" == "$section" ]] || return 1
  [[ "$(receipt_value "$receipt" input_sha256)" == "$expected_input" ]] || return 1
  [[ "$(receipt_value "$receipt" harness_sha256)" == "$(verification_section_harness_sha256 "$section")" ]] || return 1
  [[ "$(receipt_value "$receipt" toolchain_sha256)" == "$(verification_section_toolchain_sha256 "$section")" ]] || return 1
  [[ "$(receipt_value "$receipt" status)" == passed ]] || return 1
  [[ "$(receipt_value "$receipt" cleanup)" == passed ]] || return 1
  log_path="${receipt%.receipt}.log"
  [[ -f "$log_path" && ! -L "$log_path" ]] || return 1
  [[ "$(portable_file_mode "$log_path")" == 600 ]] || return 1
  [[ "$(receipt_value "$receipt" log_sha256)" == "$(sha256_file "$log_path")" ]] || return 1
  if [[ "$section" == advisories ]]; then
    finished="$(receipt_value "$receipt" finished_epoch)"
    now="$(date +%s)"
    max_age="$VERIFY_AUDIT_MAX_AGE_SECONDS"
    [[ "$finished" =~ ^[0-9]+$ && "$max_age" =~ ^[1-9][0-9]*$ ]] || return 1
    (( now >= finished && now - finished <= max_age )) || return 1
  fi
}

known_verification_processes_are_absent() {
  local matches
  matches="$(ps -axo pid=,command= | awk -v self="$$" '
    $1 != self &&
    $0 ~ /(watch-checkpoint-writers\.mjs|watch-durable-runner-quiescence\.mjs|test-recovery-safety\.sh|restore-checkpoint\.sh|create-checkpoint\.sh|watch-evidence-process\.test\.js)/ {
      print
    }
  ')"
  [[ -z "$matches" ]] || {
    printf 'Verification left a known project process running.\n' >&2
    return 1
  }
}

write_pass_receipt() {
  local section="$1" input_sha="$2" log_path="$3" started="$4" finished="$5"
  local receipt receipt_dir next
  receipt="$(section_receipt_path "$section" "$input_sha")"
  receipt_dir="${receipt%/*}"
  mkdir -p "$receipt_dir"
  chmod 700 "$receipt_dir"
  next="$receipt.next.$$"
  {
    printf 'schema=%s\n' "$VERIFY_RECEIPT_SCHEMA"
    printf 'section=%s\n' "$section"
    printf 'input_sha256=%s\n' "$input_sha"
    printf 'harness_sha256=%s\n' "$(verification_section_harness_sha256 "$section")"
    printf 'toolchain_sha256=%s\n' "$(verification_section_toolchain_sha256 "$section")"
    printf 'root_head=%s\n' "$(git -C "$ROOT_DIR" rev-parse HEAD)"
    printf 'hubs_head=%s\n' "$(git -C "$ROOT_DIR/hubs" rev-parse HEAD)"
    printf 'cloud_head=%s\n' "$(git -C "$ROOT_DIR/hubs-cloud" rev-parse HEAD)"
    printf 'started_epoch=%s\n' "$started"
    printf 'finished_epoch=%s\n' "$finished"
    printf 'log_sha256=%s\n' "$(sha256_file "$log_path")"
    printf 'status=passed\n'
    printf 'cleanup=passed\n'
  } >"$next"
  chmod 600 "$next"
  mv "$next" "$receipt"
}

run_advisories() {
  local directory
  for directory in \
    "$ROOT_DIR/hubs" \
    "$ROOT_DIR/hubs/admin" \
    "$ROOT_DIR/tests/browser" \
    "$ROOT_DIR/tests/capacity" \
    "$ROOT_DIR/hubs-cloud/community-edition" \
    "$ROOT_DIR/hubs-cloud/community-edition/services/bot-orchestrator" \
    "$ROOT_DIR/hubs-cloud/community-edition/services/dialog" \
    "$ROOT_DIR/hubs-cloud/community-edition/services/photomnemonic"; do
    (cd "$directory" && npm audit --omit=dev --audit-level=high)
  done
  require_command mise
  (
    cd "$ROOT_DIR/hubs-cloud/community-edition/services/reticulum"
    mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
      env MIX_ENV=test mix deps.get --only test --check-locked
    mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
      env MIX_ENV=test bash scripts/verify-cowlib-security-contract.sh
    mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
      env MIX_ENV=test mix hex.audit
  )
}

run_static() {
  local command shell_script
  for command in git actionlint shellcheck gitleaks npm node; do
    require_command "$command"
  done
  "$ROOT_DIR/scripts/verify-gitlinks.sh" "$ROOT_DIR"
  git -C "$ROOT_DIR" diff --check
  git -C "$ROOT_DIR/hubs" diff --check
  git -C "$ROOT_DIR/hubs-cloud" diff --check
  actionlint -shellcheck=shellcheck -color=false "$ROOT_DIR/.github/workflows/"*.yml
  actionlint -shellcheck=shellcheck -color=false "$ROOT_DIR/hubs/.github/workflows/"*.yml
  actionlint -shellcheck=shellcheck -color=false "$ROOT_DIR/hubs-cloud/.github/workflows/"*.yml
  while IFS= read -r -d '' shell_script; do
    shellcheck -x "$shell_script"
  done < <(
    find "$ROOT_DIR/deployment" "$ROOT_DIR/scripts" \
      "$ROOT_DIR/tests/recovery" "$ROOT_DIR/tests/scripts" \
      -type f -name '*.sh' -print0
  )
  shellcheck "$ROOT_DIR/hubs-cloud/community-edition/services/coturn/"*.sh
  shellcheck "$ROOT_DIR/hubs-cloud/community-edition/services/reticulum/scripts/verify-cowlib-security-contract.sh"
  "$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$ROOT_DIR"
  "$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$ROOT_DIR/hubs"
  "$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$ROOT_DIR/hubs-cloud" ".gitleaks.toml"
  "$ROOT_DIR/scripts/audit-upstream.sh" --no-fetch
}

run_security() {
  (cd "$ROOT_DIR/hubs-cloud/community-edition" && npm ci --ignore-scripts --no-audit)
  (cd "$ROOT_DIR/hubs-cloud/community-edition/services/bot-orchestrator" && npm ci --ignore-scripts --no-audit)
  node --test "$ROOT_DIR/tests/recovery/runner-cutover-checkpoint-evidence.test.mjs"
  node --test "$ROOT_DIR/tests/scripts/durable-runner-quiescence-monitor.test.mjs"
  bash "$ROOT_DIR/tests/scripts/verify-project-sections.test.sh"
  "$ROOT_DIR/tests/scripts/security-gates.test.sh"
  "$ROOT_DIR/scripts/test-aud065.sh"
}

run_recovery() {
  "$ROOT_DIR/tests/recovery/test-recovery-safety.sh"
}

run_hubs() {
  (
    cd "$ROOT_DIR/hubs"
    npm ci
    npm test
    npm run build
    cd admin
    npm ci --legacy-peer-deps
    npm test
    npm run build
  )
}

run_browser_capacity() {
  (
    cd "$ROOT_DIR/tests/browser"
    npm ci
    npm run test:unit
    npm run test:sitting -- --list
    npm run test:cold -- --list
    cd "$ROOT_DIR/tests/capacity"
    npm ci
    npm test
    npm run validate
  )
}

run_h5() {
  YENHUBS_RECOVERY_TEST_FOCUS=h5-final "$ROOT_DIR/tests/recovery/test-recovery-safety.sh"
}

run_hcce_fixture() {
  local fixture_dir fixture_manifest
  fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-hcce-fixture.XXXXXX")"
  fixture_manifest="$fixture_dir/hcce.yaml"
  trap 'find "$fixture_dir" -type f -delete; rmdir "$fixture_dir"' RETURN
  (
    cd "$ROOT_DIR/hubs-cloud/community-edition"
    HCCE_INPUT_VALUES_PATH="$ROOT_DIR/hubs-cloud/community-edition/input-values.ci.yaml" \
      HCCE_OUTPUT_PATH="$fixture_manifest" \
      node generate_script/index.js
    HCCE_MANIFEST_PATH="$fixture_manifest" \
      node generate_script/verify-generated-manifest.js
  )
  trap - RETURN
  find "$fixture_dir" -type f -delete
  rmdir "$fixture_dir"
}

run_hcce() {
  (
    cd "$ROOT_DIR/hubs-cloud/community-edition"
    npm ci
    npm run test:generator
    npm run test:apply
  )
  run_hcce_fixture
}

run_bot_orchestrator() {
  (cd "$ROOT_DIR/hubs-cloud/community-edition/services/bot-orchestrator" && npm ci && npm test)
}

run_dialog() {
  (cd "$ROOT_DIR/hubs-cloud/community-edition/services/dialog" && npm ci && npm run lint && npm test)
}

run_photomnemonic() {
  (cd "$ROOT_DIR/hubs-cloud/community-edition/services/photomnemonic" && npm ci && npm run check && npm test)
}

run_coturn() {
  sh "$ROOT_DIR/hubs-cloud/community-edition/services/coturn/test-entrypoint.sh"
}

run_spoke() {
  (
    cd "$ROOT_DIR/hubs-cloud/community-edition/services/spoke"
    PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
      NODE_PATH="$PWD/node_modules" \
      npx -y -p node@16.13.2 -p yarn@1.22.22 -- bash -c '
        set -e
        node -e "if (process.version !== \"v16.13.2\") process.exit(1)"
        yarn --version | grep -Fxq 1.22.22
        yarn install --frozen-lockfile
        yarn lint
        yarn unit-tests
        yarn build
      '
  )
}

run_reticulum() {
  require_command mise
  (
    cd "$ROOT_DIR/hubs-cloud/community-edition/services/reticulum"
    mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- env MIX_ENV=test mix deps.get --only test --check-locked
    mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- env MIX_ENV=test mix format --check-formatted
    mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- env MIX_ENV=test mix compile --warnings-as-errors
    mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
      env MIX_ENV=test DB_HOST=127.0.0.1 \
        DB_CREDENTIALS="$VERIFY_RETICULUM_TEST_DB_CREDENTIALS" mix test
  )
}

run_composition() {
  "$ROOT_DIR/scripts/verify-gitlinks.sh" "$ROOT_DIR"
  git -C "$ROOT_DIR" diff --check
  git -C "$ROOT_DIR/hubs" diff --check
  git -C "$ROOT_DIR/hubs-cloud" diff --check
  run_hcce_fixture
  known_verification_processes_are_absent
}

run_section_body() {
  case "$1" in
    advisories) run_advisories ;;
    static) run_static ;;
    security) run_security ;;
    recovery) run_recovery ;;
    hubs) run_hubs ;;
    browser-capacity) run_browser_capacity ;;
    h5) run_h5 ;;
    hcce) run_hcce ;;
    bot-orchestrator) run_bot_orchestrator ;;
    dialog) run_dialog ;;
    photomnemonic) run_photomnemonic ;;
    coturn) run_coturn ;;
    spoke) run_spoke ;;
    reticulum) run_reticulum ;;
    composition) run_composition ;;
    *) return 2 ;;
  esac
}

run_recorded_section() {
  local section="$1" input_sha receipt section_dir log_path started finished status after_sha pass_log
  input_sha="$(verification_section_input_sha256 "$section")"
  receipt="$(section_receipt_path "$section" "$input_sha")"
  if receipt_is_current "$section" "$receipt" "$input_sha"; then
    printf '\n== %s: REUSED exact receipt ==\n' "$section"
    return 0
  fi
  section_dir="$VERIFY_EVIDENCE_DIR/$section"
  mkdir -p "$section_dir"
  chmod 700 "$section_dir"
  started="$(date +%s)"
  log_path="$section_dir/$input_sha.failed.$started.log"
  : >"$log_path"
  chmod 600 "$log_path"
  printf '\n== %s ==\n' "$section"
  set +e
  (
    set -euo pipefail
    run_section_body "$section"
  ) >"$log_path" 2>&1
  status="$?"
  set -e
  cat "$log_path"
  finished="$(date +%s)"
  if [[ "$status" == 0 ]]; then
    after_sha="$(verification_section_input_sha256 "$section")"
    [[ "$after_sha" == "$input_sha" ]] || {
      printf 'Section inputs changed while %s was running.\n' "$section" >&2
      status=1
    }
  fi
  if [[ "$status" == 0 ]] && ! known_verification_processes_are_absent; then
    status=1
  fi
  if [[ "$status" == 0 ]]; then
    pass_log="$section_dir/$input_sha.log"
    mv "$log_path" "$pass_log"
    write_pass_receipt "$section" "$input_sha" "$pass_log" "$started" "$finished"
    printf 'SECTION PASS: %s\n' "$section"
    return 0
  fi
  printf 'SECTION FAIL: %s (exit %s; log %s)\n' "$section" "$status" "$log_path" >&2
  return 1
}

section_was_recorded_as_failed() {
  local candidate="$1" failed
  shift
  for failed in "$@"; do
    [[ "$candidate" != "$failed" ]] || return 0
  done
  return 1
}

run_section_set() {
  local failed=() section
  for section in "$@"; do
    run_recorded_section "$section" || failed+=("$section")
  done
  printf '\nVerification section summary:\n'
  for section in "$@"; do
    if section_was_recorded_as_failed "$section" "${failed[@]}"; then
      printf '  FAIL  %s\n' "$section"
    else
      printf '  PASS  %s\n' "$section"
    fi
  done
  if (( ${#failed[@]} > 0 )); then
    printf 'Failed sections: %s\n' "${failed[*]}" >&2
    return 1
  fi
}

finalize_verification() {
  local section input_sha receipt failed=()
  for section in "${VERIFY_FULL_SECTIONS[@]}"; do
    input_sha="$(verification_section_input_sha256 "$section")"
    receipt="$(section_receipt_path "$section" "$input_sha")"
    receipt_is_current "$section" "$receipt" "$input_sha" || failed+=("$section")
  done
  if (( ${#failed[@]} > 0 )); then
    printf 'Missing, stale or invalid verification receipts: %s\n' "${failed[*]}" >&2
    return 1
  fi
  "$ROOT_DIR/scripts/verify-gitlinks.sh" "$ROOT_DIR"
  git -C "$ROOT_DIR" diff --check
  git -C "$ROOT_DIR/hubs" diff --check
  git -C "$ROOT_DIR/hubs-cloud" diff --check
  known_verification_processes_are_absent
  printf 'Project verification finalized from exact current section evidence.\n'
}

main() {
  local mode=normal selected_section="" evidence_argument=""
  while (( $# > 0 )); do
    case "$1" in
      --full)
        [[ "$mode" == normal ]] || { usage; return 2; }
        mode=full
        shift
        ;;
      --section)
        [[ "$mode" == normal && $# -ge 2 ]] || { usage; return 2; }
        mode=section
        selected_section="$2"
        shift 2
        ;;
      --finalize)
        [[ "$mode" == normal ]] || { usage; return 2; }
        mode=finalize
        shift
        ;;
      --list-sections)
        [[ "$mode" == normal && $# -eq 1 ]] || { usage; return 2; }
        printf '%s\n' "${VERIFY_FULL_SECTIONS[@]}"
        return 0
        ;;
      --evidence-dir)
        [[ $# -ge 2 && -z "$evidence_argument" ]] || { usage; return 2; }
        evidence_argument="$2"
        shift 2
        ;;
      *) usage; return 2 ;;
    esac
  done
  if [[ "$mode" == section ]] && ! verification_section_is_known "$selected_section"; then
    printf 'Unknown verification section: %s\n' "$selected_section" >&2
    return 2
  fi
  if [[ "$mode" == finalize && -z "$evidence_argument" && -z "$VERIFY_EVIDENCE_DIR" ]]; then
    printf -- '--finalize requires --evidence-dir.\n' >&2
    return 2
  fi
  ensure_private_evidence_dir "${evidence_argument:-$VERIFY_EVIDENCE_DIR}"
  case "$mode" in
    normal) run_section_set "${VERIFY_NORMAL_SECTIONS[@]}" ;;
    full) run_section_set "${VERIFY_FULL_SECTIONS[@]}" ;;
    section) run_section_set "$selected_section" ;;
    finalize) finalize_verification ;;
    *) return 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

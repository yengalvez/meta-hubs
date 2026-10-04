#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/verify-project.sh"

TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-verification-receipts-test.XXXXXX")"
trap 'find "$TEST_TMP_DIR" -type f -delete; find "$TEST_TMP_DIR" -depth -type d -exec rmdir {} \;' EXIT
chmod 700 "$TEST_TMP_DIR"

test_count=0

pass_test() {
  test_count=$((test_count + 1))
  printf 'ok %d - %s\n' "$test_count" "$1"
}

fail_test() {
  test_count=$((test_count + 1))
  printf 'not ok %d - %s\n' "$test_count" "$1" >&2
  exit 1
}

if (ps() { return 97; }; ! known_verification_processes_are_absent >/dev/null 2>&1); then
  pass_test 'failed process enumeration cannot prove verification cleanup'
else
  fail_test 'failed process enumeration cannot prove verification cleanup'
fi

if (ps() { return 0; }; known_verification_processes_are_absent); then
  pass_test 'successful empty process enumeration proves known processes absent'
else
  fail_test 'successful empty process enumeration proves known processes absent'
fi

for driver_shell in "$(command -v bash)" /bin/bash; do
  # shellcheck disable=SC2016 # Fingerprint the isolated driver, not this parent.
  if "$driver_shell" -c 'source "$1"; material="$(verification_common_toolchain_material)"; grep -Fxq "driver_bash=$BASH_VERSION" <<<"$material"' _ "$ROOT_DIR/scripts/verify-project.sh"; then
    pass_test 'toolchain evidence fingerprints the actual driver Bash'
  else
    fail_test 'toolchain evidence fingerprints the actual driver Bash'
  fi
done

# shellcheck disable=SC2016 # All fixture functions run inside the selected Bash.
if /bin/bash -c 'source "$1"; run_recorded_section() { return 0; }; run_section_set dialog' _ "$ROOT_DIR/scripts/verify-project.sh" >"$TEST_TMP_DIR/system-bash-summary.log" 2>&1; then
  pass_test 'all-pass section summary works with the system Bash and nounset'
else
  fail_test 'all-pass section summary works with the system Bash and nounset'
fi

# shellcheck disable=SC2016 # This tests finalizer control flow, not real receipts.
if /bin/bash -c '
  source "$1"
  verification_section_input_sha256() { printf fixture; }
  section_receipt_path() { printf fixture; }
  receipt_is_current() { return 0; }
  known_verification_processes_are_absent() { return 0; }
  finalize_verification
' _ "$ROOT_DIR/scripts/verify-project.sh" >"$TEST_TMP_DIR/system-bash-finalize.log" 2>&1; then
  pass_test 'all-pass finalizer works with the system Bash and nounset'
else
  fail_test 'all-pass finalizer works with the system Bash and nounset'
fi

# shellcheck disable=SC2016 # A conditional caller must not disable the guard.
if bash -c '
  source "$1"
  verification_section_input_sha256() { printf fixture; }
  section_receipt_path() { printf fixture; }
  receipt_is_current() { return 0; }
  known_verification_processes_are_absent() { return 1; }
  if finalize_verification; then exit 1; else exit 0; fi
' _ "$ROOT_DIR/scripts/verify-project.sh" >"$TEST_TMP_DIR/failed-cleanup-finalize.log" 2>&1; then
  pass_test 'the finalizer rejects unproven cleanup even under a conditional caller'
else
  fail_test 'the finalizer rejects unproven cleanup even under a conditional caller'
fi

if (
  # shellcheck disable=SC2030 # The policy is intentionally local to this fixture.
  YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE="fixture-policy"
  export YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE
  # shellcheck disable=SC2329 # Invoked by run_reticulum's command array.
  sandbox-exec() {
    [[ "$1" == -p && "$2" == fixture-policy && "$3" == mise ]] || return 97
    printf 'launch\n' >>"$TEST_TMP_DIR/sandbox-launches.log"
  }
  # shellcheck disable=SC2329 # Guards unwrapped calls through the command array.
  mise() { return 97; }
  run_reticulum
  [[ "$(wc -l <"$TEST_TMP_DIR/sandbox-launches.log" | tr -d ' ')" == 7 ]]
); then
  pass_test 'the three pure Reticulum checks and four Mix stages receive the explicit sandbox policy'
else
  fail_test 'the three pure Reticulum checks and four Mix stages receive the explicit sandbox policy'
fi

if (
  before_ret="$(YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE='' verification_section_harness_sha256 reticulum)"
  before_dialog="$(YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE='' verification_section_harness_sha256 dialog)"
  # shellcheck disable=SC2030,SC2031 # Independent subshell; later fixtures set their own policy.
  export YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE=fixture-policy
  [[ "$before_ret" != "$(verification_section_harness_sha256 reticulum)" &&
     "$before_dialog" == "$(verification_section_harness_sha256 dialog)" ]]
); then
  pass_test 'changing the sandbox policy invalidates only Reticulum harness evidence'
else
  fail_test 'changing the sandbox policy invalidates only Reticulum harness evidence'
fi

# shellcheck disable=SC2016 # Expand $1 only in the isolated Bash process.
default_port_material="$(env -u PGPORT bash -c 'source "$1"; verification_section_harness_material reticulum' _ "$ROOT_DIR/scripts/verify-project.sh")"
if printf '%s\n' "$default_port_material" | grep -Fxq 'reticulum_db_port=5432'; then
  pass_test 'Reticulum receipt binds the default PostgreSQL port'
else
  fail_test 'Reticulum receipt binds the default PostgreSQL port'
fi

if (
  PGPORT=65432
  export PGPORT
  before_ret="$(PGPORT=5432 verification_section_harness_sha256 reticulum)"
  before_dialog="$(PGPORT=5432 verification_section_harness_sha256 dialog)"
  after_ret="$(verification_section_harness_sha256 reticulum)"
  after_dialog="$(verification_section_harness_sha256 dialog)"
  [[ "$before_ret" != "$after_ret" && "$before_dialog" == "$after_dialog" ]]
); then
  pass_test 'a private PostgreSQL port invalidates only Reticulum harness evidence'
else
  fail_test 'a private PostgreSQL port invalidates only Reticulum harness evidence'
fi

for ambient_policy_case in unset present; do
  for port_case in unset 65432; do
    if (
      if [[ "$ambient_policy_case" == unset ]]; then
        unset YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE
      else
        # shellcheck disable=SC2031 # This independent fixture sets its own ambient policy.
        export YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE=unrelated-fixture-policy
      fi
      if [[ "$port_case" == unset ]]; then unset PGPORT; expected_port=5432; else PGPORT="$port_case"; export PGPORT; expected_port="$port_case"; fi
      # This is a command-forwarding unit, not a real Mix/sandbox invocation.
      # An inherited sandbox launcher would escape the in-process mise stub.
      # The separate sandbox test above covers all seven wrapped stages.
      unset YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE
      launches="$TEST_TMP_DIR/port-$ambient_policy_case-$port_case.log"
      : >"$launches"
      # shellcheck disable=SC2329 # Reject an accidental external launcher.
      sandbox-exec() { return 97; }
      # shellcheck disable=SC2329 # Invoked by run_reticulum's command array.
      mise() {
        printf 'launch\n' >>"$launches"
        if [[ "$*" == *'mix test' ]]; then
          [[ "$*" == *"PGPORT=$expected_port"* && "$*" == *'DB_HOST=127.0.0.1'* ]]
        fi
      }
      run_reticulum || exit 1
      [[ "$(wc -l <"$launches" | tr -d ' ')" == 7 ]]
    ); then
      pass_test "Reticulum forwards the exact test port ($port_case; ambient policy $ambient_policy_case)"
    else
      fail_test "Reticulum forwards the exact test port ($port_case; ambient policy $ambient_policy_case)"
    fi
  done
done

for bad_port in '' 0 65536 05432 abc '5432 5433'; do
  if (
    PGPORT="$bad_port"
    export PGPORT
    # shellcheck disable=SC2329 # Invoked only if pre-Mix validation regresses.
    mise() { return 97; }
    set +e
    run_reticulum >/dev/null 2>&1
    result=$?
    [[ "$result" == 2 ]]
  ); then
    pass_test 'invalid PostgreSQL port fails before any Mix stage'
  else
    fail_test 'invalid PostgreSQL port fails before any Mix stage'
  fi
done

expected_sections=$'advisories\nstatic\nsecurity\nrecovery\nhubs\nbrowser-capacity\nh5\nhcce\nbot-orchestrator\ndialog\nphotomnemonic\ncoturn\nspoke\nreticulum\ncomposition'
if [[ "$(printf '%s\n' "${VERIFY_FULL_SECTIONS[@]}")" == "$expected_sections" ]]; then
  pass_test 'section inventory is exact and ordered'
else
  fail_test 'section inventory is exact and ordered'
fi

if verification_section_is_known dialog &&
   verification_section_is_known composition &&
   ! verification_section_is_known unknown; then
  pass_test 'section allowlist rejects unknown names'
else
  fail_test 'section allowlist rejects unknown names'
fi

if [[ "$(verification_section_inputs dialog)" == $'cloud\tcommunity-edition/services/dialog' ]] &&
   ! verification_section_inputs dialog | grep -q 'tests/recovery'; then
  pass_test 'Dialog evidence does not invalidate recovery inputs'
else
  fail_test 'Dialog evidence does not invalidate recovery inputs'
fi

if verification_section_inputs recovery | grep -Fqx $'root\tdeployment' &&
   verification_section_inputs recovery | grep -Fqx $'root\ttests/recovery' &&
   ! verification_section_inputs recovery | grep -q 'services/dialog'; then
  pass_test 'recovery closure is explicit and excludes Dialog'
else
  fail_test 'recovery closure is explicit and excludes Dialog'
fi

if verification_section_inputs advisories |
     grep -Fqx $'cloud\tcommunity-edition/services/reticulum/mix.exs' &&
   verification_section_inputs advisories |
     grep -Fqx $'cloud\tcommunity-edition/services/reticulum/mix.lock' &&
   verification_section_inputs advisories |
     grep -Fqx $'cloud\tcommunity-edition/services/reticulum/scripts/verify-cowlib-security-contract.sh'; then
  pass_test 'expiring advisories evidence owns the Cowlib Git security contract'
else
  fail_test 'expiring advisories evidence owns the Cowlib Git security contract'
fi

verify_creator_chat_input_binding() {
  (
    local expected input before_ret before_dialog changed=''
    expected=$'cloud\tcommunity-edition/services/reticulum\nroot\ttests/runtime/avaturn-chat-event-isolation.test.mjs\nhubs\tpackage.json\nhubs\tpackage-lock.json\nhubs\tbabel.config.js\nhubs\t.browserslistrc\nhubs\tscripts/shim\nhubs\ttest/unit/react-components/use-bot-chat-request.test.js\nhubs\tsrc/react-components/room/useBotChatRequest.js\nhubs\tsrc/utils/hub-channel.js\nhubs\tsrc/utils/bot-chat-lifecycle.js\nhubs\tsrc/utils/configs.js\nhubs\tsrc/utils/i18n.js\nhubs\tsrc/utils/phoenix-utils.js\nhubs\tsrc/utils/waypoint-reservation-coordinator.js\nhubs\tsrc/assets/locales/locale_config.js\nhubs\tsrc/assets/locales/es.json\nhubs\tsrc/assets/images/app-logo.png\nhubs\tsrc/assets/images/app-logo-dark.png\nhubs\tsrc/assets/images/company-logo.png\nhubs\tsrc/assets/images/home-hero-background-unbranded.png\nhubs\tsrc/assets/images/editor-logo.png'
    expected=$'root\ttests/runtime/avaturn-response-projection.test.mjs\nroot\ttests/runtime/avaturn-request-lifecycle.test.mjs\nroot\ttests/runtime/reticulum-ui-socket.exs\nroot\ttests/runtime/reticulum-local.mjs\nroot\ttests/runtime/catalog-dataset.mjs\nroot\ttests/runtime/catalog-seed-restore.mjs\nroot\ttests/runtime/catalog-seed-restore.test.mjs\nroot\ttests/runtime/reticulum-catalog-restore.exs\nroot\tdeployment/import-local-avatars.mjs\n'"$expected"
    [[ "$(verification_section_inputs reticulum)" == "$expected" ]] || return 1
    # Content markers exercise the real closure/fingerprint code without
    # changing any source, receipt, dependency, runtime or database.
    verification_repository_input_material() {
      local marker=original
      [[ "$1"$'\t'"$3" != "$changed" ]] || marker=changed
      printf '%s\0%s\0%s\0' "$1" "$3" "$marker"
    }
    before_ret="$(verification_section_input_sha256 reticulum)"
    before_dialog="$(verification_section_input_sha256 dialog)"
    while IFS= read -r input; do
      changed="$input"
      [[ "$before_ret" != "$(verification_section_input_sha256 reticulum)" &&
         "$before_dialog" == "$(verification_section_input_sha256 dialog)" ]] || return 1
    done <<<"$expected"
  )
}

if verify_creator_chat_input_binding; then
  pass_test 'Reticulum binds the exact cross-source oracle and every Hubs input without invalidating Dialog'
else
  fail_test 'Reticulum binds the exact cross-source oracle and every Hubs input without invalidating Dialog'
fi

verify_section_toolchain_providers() {
  (
    local section target provider definition material index other status shared
    local harness_before=() toolchain_before=()
    # Closed tooling: exercise real providers, footprint and hash algorithms;
    # never execute a tool, section, receipt, cache or runtime fixture here.
    # shellcheck disable=SC2329 # Invoked indirectly by each real provider.
    tool_version_or_missing() { printf '%s\n' "$*"; }
    verification_common_toolchain_material() { printf 'closed-common-toolchain\n'; }
    expected_provider_commands() {
      case "$1" in
        advisories)
          printf '%s\n' 'node --version' 'npm --version' 'curl --version' 'jq --version' 'mise --version' \
            'mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- elixir --version' \
            'mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- mix --version'
          ;;
        static)
          printf '%s\n' 'actionlint -version' 'shellcheck --version' 'gitleaks version' 'node --version' 'npm --version'
          ;;
        security | hubs | browser-capacity | hcce | bot-orchestrator | dialog | photomnemonic | spoke | composition)
          printf '%s\n' 'node --version' 'npm --version'
          ;;
        recovery | h5) printf '%s\n' 'node --version' 'jq --version' ;;
        coturn) printf '%s\n' 'shellcheck --version' ;;
        reticulum)
          printf '%s\n' 'node --version' 'mise --version' \
            'mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- elixir --version' \
            'mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- mix --version'
          ;;
        *) return 2 ;;
      esac
    }
    for section in "${VERIFY_FULL_SECTIONS[@]}"; do
      provider="$(verification_section_toolchain_provider "$section")" || return 1
      [[ "$("$provider")" == "$(expected_provider_commands "$section")" ]] || return 1
      toolchain_before[${#toolchain_before[@]}]="$(verification_section_toolchain_sha256 "$section")"
      [[ "${toolchain_before[${#toolchain_before[@]}-1]}" == "$(
        { verification_common_toolchain_material; printf 'section=%s\n' "$section"; expected_provider_commands "$section"; } | sha256_stream
      )" ]] || return 1
      harness_before[${#harness_before[@]}]="$(verification_section_harness_sha256 "$section")"
      material="$(verification_section_harness_material "$section")" || return 1
      [[ "$material" == *"$(declare -f "$provider")"* &&
         "$material" == *"$(declare -f tool_version_or_missing)"* ]] || return 1
      for other in "${VERIFY_FULL_SECTIONS[@]}"; do
        [[ "$other" == "$section" ]] && continue
        [[ "$material" != *"$(declare -f "$(verification_section_toolchain_provider "$other")")"* ]] || return 1
      done
    done

    # A provider command/source edit affects exactly its own toolchain and
    # harness, including Reticulum; never invalidate Dialog by association.
    for target in "${VERIFY_FULL_SECTIONS[@]}"; do
      provider="$(verification_section_toolchain_provider "$target")" || return 1
      definition="$(declare -f "$provider")" || return 1
      eval "$provider() { tool_version_or_missing section-only-change '$target'; }"
      index=0
      for section in "${VERIFY_FULL_SECTIONS[@]}"; do
        if [[ "$section" == "$target" ]]; then
          [[ "${toolchain_before[index]}" != "$(verification_section_toolchain_sha256 "$section")" &&
             "${harness_before[index]}" != "$(verification_section_harness_sha256 "$section")" ]] || return 1
        else
          [[ "${toolchain_before[index]}" == "$(verification_section_toolchain_sha256 "$section")" &&
             "${harness_before[index]}" == "$(verification_section_harness_sha256 "$section")" ]] || return 1
        fi
        index=$((index + 1))
      done
      eval "$definition"

      # Missing providers fail closed even in a conditional caller, while
      # unrelated sections retain exactly their original footprint/hash.
      unset -f "$provider"
      if verification_section_toolchain_sha256 "$target" >/dev/null; then return 1; else status=$?; fi
      [[ "$status" == 2 ]] || return 1
      if verification_section_harness_sha256 "$target" >/dev/null; then return 1; else status=$?; fi
      [[ "$status" == 2 ]] || return 1
      index=0
      for section in "${VERIFY_FULL_SECTIONS[@]}"; do
        if [[ "$section" != "$target" ]]; then
          [[ "${toolchain_before[index]}" == "$(verification_section_toolchain_sha256 "$section")" &&
             "${harness_before[index]}" == "$(verification_section_harness_sha256 "$section")" ]] || return 1
        fi
        index=$((index + 1))
      done
      eval "$definition"
    done

    # Changes to the dispatcher, hashing algorithm or shared helpers remain
    # common. A no-output code edit must invalidate every harness, even when
    # tool versions/commands happen to produce the same bytes.
    for shared in verification_section_toolchain_provider verification_section_toolchain_sha256 \
      verification_common_toolchain_material tool_version_or_missing; do
      definition="$(declare -f "$shared")" || return 1
      eval "$(printf '%s\n' "$definition" | sed '2s/{/{ : shared_footprint_change;/')"
      index=0
      for section in "${VERIFY_FULL_SECTIONS[@]}"; do
        [[ "${toolchain_before[index]}" == "$(verification_section_toolchain_sha256 "$section")" &&
           "${harness_before[index]}" != "$(verification_section_harness_sha256 "$section")" ]] || return 1
        index=$((index + 1))
      done
      eval "$definition"
    done
    definition="$(declare -f tool_version_or_missing)"
    # shellcheck disable=SC2329 # Invoked indirectly by each real provider.
    tool_version_or_missing() { printf 'changed-version:%s\n' "$*"; }
    index=0
    for section in "${VERIFY_FULL_SECTIONS[@]}"; do
      [[ "${toolchain_before[index]}" != "$(verification_section_toolchain_sha256 "$section")" &&
         "${harness_before[index]}" != "$(verification_section_harness_sha256 "$section")" ]] || return 1
      index=$((index + 1))
    done
    eval "$definition"

    for shared in tool_version_or_missing verification_common_toolchain_material verification_section_toolchain_provider; do
      definition="$(declare -f "$shared")" || return 1
      unset -f "$shared"
      for section in "${VERIFY_FULL_SECTIONS[@]}"; do
        if verification_section_toolchain_sha256 "$section" >/dev/null 2>&1; then return 1; fi
        if verification_section_harness_sha256 "$section" >/dev/null 2>&1; then return 1; fi
      done
      eval "$definition"
    done
    for section in '' unknown reticulum-extra RETICULUM '../reticulum' 'reticulum; true'; do
      if verification_section_toolchain_provider "$section" >/dev/null; then return 1; else status=$?; fi
      [[ "$status" == 2 ]] || return 1
      if verification_section_toolchain_sha256 "$section" >/dev/null; then return 1; else status=$?; fi
      [[ "$status" == 2 ]] || return 1
      if verification_section_harness_sha256 "$section" >/dev/null; then return 1; else status=$?; fi
      [[ "$status" == 2 ]] || return 1
    done
  )
}

if verify_section_toolchain_providers; then
  pass_test 'all original toolchains stay exact; provider edits isolate receipts and shared/missing helpers fail closed'
else
  fail_test 'all original toolchains stay exact; provider edits isolate receipts and shared/missing helpers fail closed'
fi

verify_receipt_fingerprint_consumers() {
  (
    local fixture fault input receipt log_path valid status
    fixture="$(mktemp -d "${TEST_TMP_DIR:-${TMPDIR:-/tmp}}/yenhubs-fingerprint-consumers.XXXXXX")" || return 1
    chmod 700 "$fixture"
    # Standalone focal invocations retain only their owned TEMP fixture. The
    # full test's existing outer TEMP trap owns cleanup when run in that suite.
    printf 'FINGERPRINT_CONSUMER_FIXTURE=%s\n' "$fixture"
    # shellcheck disable=SC2329 # Probed tools are invoked through real providers.
    tool_version_or_missing() { printf '%s\n' "$*"; }
    verification_common_toolchain_material() { printf 'closed-common-toolchain\n'; }
    valid="$(printf 'owned-valid-fingerprint' | sha256_stream)"

    # A valid receipt must still publish and read through conditional callers.
    VERIFY_EVIDENCE_DIR="$fixture/control"
    input="$(printf 'owned-valid-input' | sha256_stream)"
    receipt="$(section_receipt_path dialog "$input")"
    log_path="${receipt%.receipt}.log"
    mkdir -p "${receipt%/*}"
    chmod 700 "$VERIFY_EVIDENCE_DIR" "${receipt%/*}"
    printf 'owned-conditional-receipt-control\n' >"$log_path"
    chmod 600 "$log_path"
    if write_pass_receipt dialog "$input" "$log_path" 1 1; then :; else return 1; fi
    if receipt_is_current dialog "$receipt" "$input"; then :; else return 1; fi

    seed_owned_failed_fingerprint_receipt() {
      local harness toolchain log_hash
      # Deliberately preserve emitted bytes despite failure only to model a
      # legacy/forged receipt. Neither publication consumer is used to seed it.
      if harness="$(verification_section_harness_sha256 dialog)"; then :; else :; fi
      if toolchain="$(verification_section_toolchain_sha256 dialog)"; then :; else :; fi
      if log_hash="$(sha256_file "$log_path")"; then :; else :; fi
      printf '%s\n' "schema=$VERIFY_RECEIPT_SCHEMA" 'section=dialog' "input_sha256=$input" \
        "harness_sha256=$harness" "toolchain_sha256=$toolchain" \
        'root_head=owned-fixture' 'hubs_head=owned-fixture' 'cloud_head=owned-fixture' \
        'started_epoch=1' 'finished_epoch=1' "log_sha256=$log_hash" 'status=passed' 'cleanup=passed' >"$receipt"
      chmod 600 "$receipt"
    }

    for fault in missing-provider failing-common-helper \
      harness-failure harness-malformed harness-empty \
      toolchain-failure toolchain-malformed toolchain-empty \
      log-failure log-malformed log-empty input-malformed; do
      (
        VERIFY_EVIDENCE_DIR="$fixture/$fault"
        input="$(printf 'owned-input-%s' "$fault" | sha256_stream)"
        [[ "$fault" != input-malformed ]] || input=not-a-sha256
        receipt="$(section_receipt_path dialog "$input")"
        log_path="${receipt%.receipt}.log"
        mkdir -p "${receipt%/*}"
        chmod 700 "$VERIFY_EVIDENCE_DIR" "${receipt%/*}"
        printf 'owned-conditional-receipt-fault\n' >"$log_path"
        chmod 600 "$log_path"
        case "$fault" in
          missing-provider) unset -f verification_toolchain_dialog ;;
          failing-common-helper)
            verification_common_toolchain_material() { printf 'partial-common-toolchain\n'; return 2; }
            ;;
          harness-failure) verification_section_harness_sha256() { printf '%s\n' "$valid"; return 2; } ;;
          harness-malformed) verification_section_harness_sha256() { printf 'not-a-sha256\n'; } ;;
          harness-empty) verification_section_harness_sha256() { :; } ;;
          toolchain-failure) verification_section_toolchain_sha256() { printf '%s\n' "$valid"; return 2; } ;;
          toolchain-malformed) verification_section_toolchain_sha256() { printf 'not-a-sha256\n'; } ;;
          toolchain-empty) verification_section_toolchain_sha256() { :; } ;;
          log-failure) sha256_file() { printf '%s\n' "$valid"; return 2; } ;;
          log-malformed) sha256_file() { printf 'not-a-sha256\n'; } ;;
          log-empty) sha256_file() { :; } ;;
        esac
        if write_pass_receipt dialog "$input" "$log_path" 1 1; then return 1; else status=$?; fi
        [[ "$status" == 1 && ! -e "$receipt" && ! -e "$receipt.next.$$" ]] || return 1
        seed_owned_failed_fingerprint_receipt
        # Its failed value equals the producer's emitted bytes: rejecting it
        # must depend on producer status/format, not a coincidental mismatch.
        if receipt_is_current dialog "$receipt" "$input"; then return 1; else status=$?; fi
        [[ "$status" == 1 ]] || return 1
      ) || return 1
    done
  )
}

if verify_receipt_fingerprint_consumers; then
  pass_test 'both conditional receipt consumers reject failed or malformed fingerprints before publication or reuse'
else
  fail_test 'both conditional receipt consumers reject failed or malformed fingerprints before publication or reuse'
fi

if (
  export BASE_ASSETS_PATH=https://assets.example.invalid/hubs/
  export RETICULUM_SERVER=hubs.example.invalid
  npx() {
    [[ -z "${BASE_ASSETS_PATH+x}" && -z "${RETICULUM_SERVER+x}" &&
       "$PUPPETEER_SKIP_DOWNLOAD" == true &&
       "$NODE_PATH" == "$ROOT_DIR/hubs-cloud/community-edition/services/spoke/node_modules" ]]
  }
  run_spoke || exit 1
  [[ "$BASE_ASSETS_PATH" == https://assets.example.invalid/hubs/ &&
     "$RETICULUM_SERVER" == hubs.example.invalid ]]
); then
  pass_test 'Spoke isolates Hubs build variables without changing the parent environment'
else
  fail_test 'Spoke isolates Hubs build variables without changing the parent environment'
fi

dialog_harness_before="$(verification_section_harness_sha256 dialog)"
recovery_harness_before="$(verification_section_harness_sha256 recovery)"
run_recovery() {
  printf 'changed recovery fixture\n' >/dev/null
}
dialog_harness_after="$(verification_section_harness_sha256 dialog)"
recovery_harness_after="$(verification_section_harness_sha256 recovery)"
if [[ "$dialog_harness_before" == "$dialog_harness_after" &&
      "$recovery_harness_before" != "$recovery_harness_after" ]]; then
  pass_test 'a section command change invalidates only its own harness evidence'
else
  fail_test 'a section command change invalidates only its own harness evidence'
fi

dialog_toolchain_before="$(verification_section_toolchain_sha256 dialog)"
reticulum_toolchain_before="$(verification_section_toolchain_sha256 reticulum)"
fake_bin="$TEST_TMP_DIR/fake-bin"
mkdir -m 700 "$fake_bin"
printf '#!/bin/sh\nprintf "v-fixture-node\\n"\n' >"$fake_bin/node"
chmod 700 "$fake_bin/node"
dialog_toolchain_after="$(PATH="$fake_bin:$PATH" verification_section_toolchain_sha256 dialog)"
reticulum_toolchain_after="$(PATH="$fake_bin:$PATH" verification_section_toolchain_sha256 reticulum)"
if [[ "$dialog_toolchain_before" != "$dialog_toolchain_after" &&
      "$reticulum_toolchain_before" != "$reticulum_toolchain_after" ]]; then
  pass_test 'a tool version change invalidates only sections that use that tool'
else
  fail_test 'a tool version change invalidates only sections that use that tool'
fi

private_dir="$TEST_TMP_DIR/private"
mkdir -m 700 "$private_dir"
if (ensure_private_evidence_dir "$private_dir" >/dev/null); then
  pass_test 'private evidence directory is accepted'
else
  fail_test 'private evidence directory is accepted'
fi

default_cache="$TEST_TMP_DIR/default-cache"
expected_default="$default_cache/yenhubs/project-verification"
if (
  VERIFY_EVIDENCE_DIR=''
  XDG_CACHE_HOME="$default_cache"
  export XDG_CACHE_HOME
  ensure_private_evidence_dir '' >/dev/null
  [[ "$VERIFY_EVIDENCE_DIR" == "$expected_default" &&
     "$(portable_file_mode "$VERIFY_EVIDENCE_DIR")" == 700 ]]
) && (
  VERIFY_EVIDENCE_DIR=''
  XDG_CACHE_HOME="$default_cache"
  export XDG_CACHE_HOME
  ensure_private_evidence_dir '' >/dev/null
  [[ "$VERIFY_EVIDENCE_DIR" == "$expected_default" ]]
); then
  pass_test 'implicit evidence uses one stable private cache across invocations'
else
  fail_test 'implicit evidence uses one stable private cache across invocations'
fi

public_dir="$TEST_TMP_DIR/public"
mkdir -m 755 "$public_dir"
if (ensure_private_evidence_dir "$public_dir" >/dev/null 2>&1); then
  fail_test 'non-private evidence directory is rejected'
else
  pass_test 'non-private evidence directory is rejected'
fi

inside_checkout="$ROOT_DIR/.verification-evidence-forbidden"
if (ensure_private_evidence_dir "$inside_checkout" >/dev/null 2>&1); then
  fail_test 'evidence inside the checkout is rejected before creation'
elif [[ ! -e "$inside_checkout" ]]; then
  pass_test 'evidence inside the checkout is rejected before creation'
else
  fail_test 'evidence inside the checkout is rejected before creation'
fi

VERIFY_EVIDENCE_DIR="$private_dir"
export VERIFY_EVIDENCE_DIR
section=dialog
input_sha="$(verification_section_input_sha256 "$section")"
section_dir="$VERIFY_EVIDENCE_DIR/$section"
mkdir -m 700 "$section_dir"
log_path="$section_dir/$input_sha.log"
printf 'fixture verification log\n' >"$log_path"
chmod 600 "$log_path"
now="$(date +%s)"
write_pass_receipt "$section" "$input_sha" "$log_path" "$now" "$now"
receipt="$(section_receipt_path "$section" "$input_sha")"

if receipt_is_current "$section" "$receipt" "$input_sha"; then
  pass_test 'exact content-bound receipt is accepted'
else
  fail_test 'exact content-bound receipt is accepted'
fi

printf 'tamper\n' >>"$log_path"
if receipt_is_current "$section" "$receipt" "$input_sha"; then
  fail_test 'tampered receipt log is rejected'
else
  pass_test 'tampered receipt log is rejected'
fi

printf 'fixture verification log\n' >"$log_path"
if receipt_is_current "$section" "$receipt" "$input_sha"; then
  pass_test 'restored exact log revalidates the receipt'
else
  fail_test 'restored exact log revalidates the receipt'
fi

receipt_next="$receipt.invalid"
awk '
  /^input_sha256=/ { print "input_sha256=" substr($0, 14) "0"; next }
  { print }
' "$receipt" >"$receipt_next"
chmod 600 "$receipt_next"
if receipt_is_current "$section" "$receipt_next" "$input_sha"; then
  fail_test 'wrong input fingerprint is rejected'
else
  pass_test 'wrong input fingerprint is rejected'
fi

if [[ "$(verification_section_input_sha256 dialog)" == "$input_sha" ]]; then
  pass_test 'section input fingerprint is deterministic'
else
  fail_test 'section input fingerprint is deterministic'
fi

if [[ "$(uname -s)" == Darwin ]]; then
  expected_local_db_credentials="$(id -un)"
else
  expected_local_db_credentials=postgres
fi
detected_local_db_credentials="$(
  # shellcheck disable=SC2016 # Variables expand in the isolated Bash process.
  env -u YENHUBS_RETICULUM_TEST_DB_CREDENTIALS bash -c '
    source "$1"
    printf "%s\\n" "$VERIFY_RETICULUM_TEST_DB_CREDENTIALS"
  ' _ "$ROOT_DIR/scripts/verify-project.sh"
)"
if [[ "$detected_local_db_credentials" == "$expected_local_db_credentials" ]]; then
  pass_test 'Reticulum defaults to the platform local PostgreSQL role'
else
  fail_test 'Reticulum defaults to the platform local PostgreSQL role'
fi

explicit_db_credentials="$(
  # shellcheck disable=SC2016 # Variables expand in the isolated Bash process.
  YENHUBS_RETICULUM_TEST_DB_CREDENTIALS=fixture-db-role bash -c '
    source "$1"
    printf "%s\\n" "$VERIFY_RETICULUM_TEST_DB_CREDENTIALS"
  ' _ "$ROOT_DIR/scripts/verify-project.sh"
)"
if [[ "$explicit_db_credentials" == fixture-db-role ]]; then
  pass_test 'explicit Reticulum PostgreSQL credentials override the platform default'
else
  fail_test 'explicit Reticulum PostgreSQL credentials override the platform default'
fi

printf '%d verify-project section tests passed\n' "$test_count"

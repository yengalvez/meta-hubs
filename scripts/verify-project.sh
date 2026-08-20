#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FULL=false

if [[ "${1:-}" == "--full" ]]; then
  FULL=true
elif [[ $# -ne 0 ]]; then
  printf 'Usage: scripts/verify-project.sh [--full]\n' >&2
  exit 2
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

for command in git actionlint shellcheck gitleaks npm node; do
  require_command "$command"
done

printf '== Git and static checks ==\n'
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
(
  cd "$ROOT_DIR/hubs-cloud/community-edition"
  npm ci --ignore-scripts --no-audit
)
(
  cd "$ROOT_DIR/hubs-cloud/community-edition/services/bot-orchestrator"
  npm ci --ignore-scripts --no-audit
)
node --test "$ROOT_DIR/tests/recovery/runner-cutover-checkpoint-evidence.test.mjs"
node --test "$ROOT_DIR/tests/scripts/durable-runner-quiescence-monitor.test.mjs"
"$ROOT_DIR/tests/scripts/security-gates.test.sh"
"$ROOT_DIR/tests/recovery/test-recovery-safety.sh"
"$ROOT_DIR/scripts/test-aud065.sh"
"$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$ROOT_DIR"
"$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$ROOT_DIR/hubs"
"$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$ROOT_DIR/hubs-cloud" ".gitleaks.toml"
"$ROOT_DIR/scripts/audit-upstream.sh" --no-fetch

if [[ "$FULL" != true ]]; then
  printf '\nStatic verification passed. Use --full for all test/build suites.\n'
  exit 0
fi

printf '\n== Hubs client ==\n'
(
  cd "$ROOT_DIR/hubs"
  npm ci
  npm audit --omit=dev --audit-level=high
  npm test
  npm run build
  cd admin
  npm ci --legacy-peer-deps
  npm audit --omit=dev --audit-level=high
  npm test
  npm run build
)

printf '\n== Root browser and capacity harnesses ==\n'
(
  cd "$ROOT_DIR/tests/browser"
  npm ci
  npm audit --omit=dev --audit-level=high
  npm run test:unit
  npm run test:sitting -- --list
  npm run test:cold -- --list

  cd "$ROOT_DIR/tests/capacity"
  npm ci
  npm audit --omit=dev --audit-level=high
  npm test
  npm run validate
)

printf '\n== H5 freeze and cold-reactivation recovery gates ==\n'
YENHUBS_RECOVERY_TEST_FOCUS=h5-final \
  "$ROOT_DIR/tests/recovery/test-recovery-safety.sh"

printf '\n== Hubs CE Node services ==\n'
(
  cd "$ROOT_DIR/hubs-cloud/community-edition"
  npm ci
  npm audit --omit=dev --audit-level=high
  npm run test:generator
  npm run test:apply
  fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-hcce-fixture.XXXXXX")"
  fixture_manifest="$fixture_dir/hcce.yaml"
  trap 'find "$fixture_dir" -type f -delete; rmdir "$fixture_dir"' EXIT
  HCCE_INPUT_VALUES_PATH="$PWD/input-values.ci.yaml" \
    HCCE_OUTPUT_PATH="$fixture_manifest" node generate_script/index.js
  HCCE_MANIFEST_PATH="$fixture_manifest" node generate_script/verify-generated-manifest.js

  for service in bot-orchestrator dialog photomnemonic; do
    cd "$ROOT_DIR/hubs-cloud/community-edition/services/$service"
    npm ci
    npm audit --omit=dev --audit-level=high
    case "$service" in
      bot-orchestrator)
        npm test
        ;;
      dialog)
        npm run lint
        npm test
        ;;
      photomnemonic)
        npm run check
        npm test
        ;;
    esac
  done

  sh "$ROOT_DIR/hubs-cloud/community-edition/services/coturn/test-entrypoint.sh"
)

printf '\n== Spoke ==\n'
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

printf '\n== Reticulum ==\n'
require_command mise
(
  cd "$ROOT_DIR/hubs-cloud/community-edition/services/reticulum"
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test mix deps.get
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test mix format --check-formatted
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test mix compile --warnings-as-errors
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test mix hex.audit
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test DB_HOST=127.0.0.1 DB_CREDENTIALS=postgres mix test
)

printf '\nFull project verification passed.\n'

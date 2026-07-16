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

scan_worktree() {
  local repo="$1"
  local config="${2:-}"
  local tmp
  local args=(detect --no-git --redact)

  tmp="$(mktemp -d /tmp/yenhubs-gitleaks.XXXXXX)"
  while IFS= read -r -d '' path; do
    if [[ -f "$repo/$path" || -L "$repo/$path" ]]; then
      mkdir -p "$tmp/$(dirname "$path")"
      cp -P "$repo/$path" "$tmp/$path"
      [[ -f "$tmp/$path" ]] && chmod u+r "$tmp/$path"
    fi
  done < <(git -C "$repo" ls-files -z --cached --others --exclude-standard)
  args+=(--source "$tmp")
  if [[ -n "$config" ]]; then
    args+=(--config "$repo/$config")
  fi
  gitleaks "${args[@]}"
  find "$tmp" -type f -delete
  find "$tmp" -depth -type d -empty -delete
}

for command in git actionlint shellcheck gitleaks npm node; do
  require_command "$command"
done

printf '== Git and static checks ==\n'
git -C "$ROOT_DIR" diff --check
git -C "$ROOT_DIR/hubs" diff --check
git -C "$ROOT_DIR/hubs-cloud" diff --check
actionlint -shellcheck=shellcheck -color=false "$ROOT_DIR/.github/workflows/"*.yml
actionlint -shellcheck=shellcheck -color=false "$ROOT_DIR/hubs/.github/workflows/"*.yml
actionlint -shellcheck=shellcheck -color=false "$ROOT_DIR/hubs-cloud/.github/workflows/"*.yml
shellcheck "$ROOT_DIR/deployment/"*.sh
shellcheck "$ROOT_DIR/scripts/"*.sh
shellcheck "$ROOT_DIR/hubs-cloud/community-edition/services/coturn/"*.sh
scan_worktree "$ROOT_DIR"
scan_worktree "$ROOT_DIR/hubs"
scan_worktree "$ROOT_DIR/hubs-cloud" ".gitleaks.toml"
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

printf '\n== Hubs CE Node services ==\n'
(
  cd "$ROOT_DIR/hubs-cloud/community-edition"
  npm ci
  npm audit --omit=dev --audit-level=high
  npm run gen-hcce

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
    npx -y -p node@16.13.2 -p yarn@1.22.22 -- bash -c '
      set -e
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
    env MIX_ENV=test mix format --check-formatted
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test mix compile --warnings-as-errors
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test mix hex.audit
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test DB_HOST=127.0.0.1 DB_CREDENTIALS=postgres mix test
)

printf '\nFull project verification passed.\n'

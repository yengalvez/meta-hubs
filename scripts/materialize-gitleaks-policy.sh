#!/usr/bin/env bash

# Materialize Gitleaks policy only from an explicitly trusted root revision.
# When that revision predates the policy files, emit a conservative bootstrap
# mode that uses Gitleaks defaults and no candidate-owned allowlist/baseline.

set -euo pipefail
umask 077

if [[ $# -ne 3 ]]; then
  printf 'Usage: %s REPOSITORY TRUSTED_REVISION OUTPUT_DIRECTORY\n' "$0" >&2
  exit 2
fi

repository="$1"
trusted_revision="$2"
output_directory="$3"

if ! repository="$(git -C "$repository" rev-parse --show-toplevel 2>/dev/null)" ||
   ! git -C "$repository" cat-file -e "${trusted_revision}^{commit}" 2>/dev/null; then
  printf 'The explicitly trusted policy revision is unavailable.\n' >&2
  exit 1
fi
if [[ -e "$output_directory" || -L "$output_directory" ]]; then
  printf 'Policy output directory must not already exist.\n' >&2
  exit 1
fi
mkdir -m 0700 "$output_directory"

emit_bootstrap_defaults() {
  local bootstrap_config="$output_directory/bootstrap-default.toml"
  printf '%s\n' \
    'title = "YenHubs conservative first-policy bootstrap"' \
    '[extend]' \
    'useDefault = true' >"$bootstrap_config"
  chmod 0600 "$bootstrap_config"
  printf '%s\n' \
    'GITLEAKS_POLICY_MODE=bootstrap-default' \
    "GITLEAKS_ROOT_CONFIG=$bootstrap_config" \
    "GITLEAKS_CLOUD_CONFIG=$bootstrap_config" \
    'GITLEAKS_SUBMODULE_BASELINES='
}

root_policy_mode="$(git -C "$repository" ls-tree "$trusted_revision" -- \
  scripts/gitleaks-root.toml | awk 'NR == 1 {print $1}')"
baseline_mode="$(git -C "$repository" ls-tree "$trusted_revision" -- \
  scripts/gitleaks-submodule-baselines.tsv | awk 'NR == 1 {print $1}')"
cloud_entry="$(git -C "$repository" ls-tree "$trusted_revision" -- hubs-cloud)"
cloud_mode="$(awk 'NR == 1 {print $1}' <<<"$cloud_entry")"
cloud_revision="$(awk 'NR == 1 {print $3}' <<<"$cloud_entry")"

if [[ "$root_policy_mode" != 100644 || "$baseline_mode" != 100644 ||
      "$cloud_mode" != 160000 || ! "$cloud_revision" =~ ^[a-fA-F0-9]{40}$ ||
      ! -e "$repository/hubs-cloud/.git" ]] ||
   ! git -C "$repository/hubs-cloud" cat-file -e "${cloud_revision}^{commit}" 2>/dev/null ||
   [[ "$(git -C "$repository/hubs-cloud" ls-tree "$cloud_revision" -- \
     .gitleaks.toml | awk 'NR == 1 {print $1}')" != 100644 ]]; then
  printf 'Trusted revision predates the complete policy; using Gitleaks defaults without candidate allowlists.\n' >&2
  emit_bootstrap_defaults
  exit 0
fi

git -C "$repository" show \
  "$trusted_revision:scripts/gitleaks-root.toml" >"$output_directory/root.toml"
git -C "$repository" show \
  "$trusted_revision:scripts/gitleaks-submodule-baselines.tsv" \
  >"$output_directory/submodule-baselines.tsv"
git -C "$repository/hubs-cloud" show \
  "$cloud_revision:.gitleaks.toml" >"$output_directory/hubs-cloud.toml"
chmod 0600 "$output_directory"/*

printf '%s\n' \
  'GITLEAKS_POLICY_MODE=trusted-base' \
  "GITLEAKS_ROOT_CONFIG=$output_directory/root.toml" \
  "GITLEAKS_CLOUD_CONFIG=$output_directory/hubs-cloud.toml" \
  "GITLEAKS_SUBMODULE_BASELINES=$output_directory/submodule-baselines.tsv"

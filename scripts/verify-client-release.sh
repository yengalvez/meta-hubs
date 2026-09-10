#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/verify-project.sh"

if [[ $# != 3 || ! "$3" =~ ^(check|run)$ ]]; then
  printf 'Usage: verify-client-release.sh DEPLOYED_HUBS_SHA CANDIDATE_HUBS_SHA check|run\n' >&2
  exit 2
fi
node "$ROOT_DIR/scripts/client-release-scope.mjs" "$ROOT_DIR/hubs" "$1" "$2"
ensure_private_evidence_dir "$VERIFY_EVIDENCE_DIR"
sections=(advisories hubs browser-capacity composition)
if [[ "$3" == run ]]; then
  run_section_set "${sections[@]}"
fi
for section in "${sections[@]}"; do
  input_sha="$(verification_section_input_sha256 "$section")"
  receipt="$(section_receipt_path "$section" "$input_sha")"
  receipt_is_current "$section" "$receipt" "$input_sha" || {
    printf 'Missing current client-release evidence: %s\n' "$section" >&2
    exit 1
  }
done
git -C "$ROOT_DIR/hubs" diff --check
"$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$ROOT_DIR/hubs"
node --test "$ROOT_DIR/tests/scripts/client-release-scope.test.mjs"
bash "$ROOT_DIR/tests/scripts/verify-process-scope.test.sh"
bash "$ROOT_DIR/tests/scripts/verify-section-failure.test.sh"
node --test "$ROOT_DIR/hubs-cloud/community-edition/apply/client-image-only.test.js" \
  "$ROOT_DIR/hubs-cloud/community-edition/apply/client-image-only-driver.test.js"
printf 'Visual client source verified. NOT deployment approval: require live image provenance, image-only guard, rollback digest and cold-browser acceptance.\n'

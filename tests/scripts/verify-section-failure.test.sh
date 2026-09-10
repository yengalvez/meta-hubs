#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/verify-project.sh"
ROOT_DIR="$ROOT_DIR/tests/scripts/fixtures/failing-section"
if output="$(run_section_in_fresh_shell hubs)"; then
  printf 'FAIL: early failure was hidden by later success\n' >&2
  exit 1
fi
[[ "$output" != *incorrect-later-success* ]]
printf 'ok - early section failure survives an errexit-disabled caller\n'
[[ "$(run_section_in_fresh_shell composition)" == successful-section ]]
printf 'ok - genuinely successful section remains successful\n'

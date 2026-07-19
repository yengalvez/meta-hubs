#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# Keep the AUD-065 acceptance inventory in one place so the local project gate
# and GitHub Actions cannot silently diverge.  Tests run sequentially because
# several private-file fixtures deliberately exercise filesystem race cuts.
"$ROOT_DIR/tests/recovery/test-aud065-operation-lock.sh"
"$ROOT_DIR/tests/recovery/test-aud065-pgsql-barrier.sh"
"$ROOT_DIR/tests/recovery/test-process-local-db-rotation.sh"
"$ROOT_DIR/tests/recovery/test-process-local-db-rotation-postgres.sh"
"$ROOT_DIR/tests/recovery/test-process-local-rotation-coordinator.sh"

node "$ROOT_DIR/tests/scripts/process-local-rotation.test.mjs"
node "$ROOT_DIR/tests/scripts/process-local-rotation-operation.test.mjs"
node "$ROOT_DIR/tests/scripts/process-local-source-transition.test.mjs"
node "$ROOT_DIR/tests/scripts/prepare-process-local-rotation.test.mjs"
node "$ROOT_DIR/tests/scripts/materialize-process-local-replacements.test.mjs"
node "$ROOT_DIR/tests/scripts/private-artifact-publication.test.mjs"
node "$ROOT_DIR/tests/scripts/project-process-local-values.test.mjs"
node "$ROOT_DIR/tests/scripts/bot-image-pull-config.test.mjs"
node "$ROOT_DIR/tests/scripts/capture-process-local-baseline.test.mjs"
node "$ROOT_DIR/tests/scripts/redacted-rollout-contract.test.mjs"

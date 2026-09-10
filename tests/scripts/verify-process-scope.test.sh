#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/verify-project.sh"
ROOT_DIR=/fixture/current
output='12345 bash /fixture/other/tests/recovery/test-recovery-safety.sh'
cwd=/fixture/other
alive=0
ps() { printf '%s\n' "$output"; }
verification_process_workdir() { printf '%s\n' "$cwd"; }
kill() { return "$alive"; }
known_verification_processes_are_absent
printf 'ok - unrelated checkout recovery remains independent\n'
output='12345 bash /fixture/current/tests/recovery/test-recovery-safety.sh'
if known_verification_processes_are_absent 2>/dev/null; then exit 1; fi
printf 'ok - absolute command in current checkout rejected\n'
output='12345 bash tests/recovery/test-recovery-safety.sh'
cwd=/fixture/current/tests
if known_verification_processes_are_absent 2>/dev/null; then exit 1; fi
printf 'ok - relative command attributed by working directory\n'
cwd=''
if known_verification_processes_are_absent 2>/dev/null; then exit 1; fi
printf 'ok - live process with unknown ownership fails closed\n'
alive=1
known_verification_processes_are_absent
printf 'ok - process that exited during observation is absent\n'

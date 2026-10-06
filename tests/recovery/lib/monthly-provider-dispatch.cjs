const fs = require("node:fs");
const path = require("node:path");

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// The established Lease fixture keys its WATCH -> GET handoff by PPID. A
// Node spawnSync fallback inserts a different parent on every API call and
// leaves orphaned handoffs. Dispatch protected calls with exec, not a child.
// Every route is still a closed local fake; this never resolves a real client.
function installMonthlyProviderFixture(bin, adapterPath) {
  const body = fs.readFileSync(adapterPath);
  for (const program of ["kubectl", "doctl"]) {
    fs.renameSync(path.join(bin, program), path.join(bin, program + "-legacy"));
    fs.writeFileSync(path.join(bin, program + "-monthly"),
      "#!" + process.execPath + "\n" + body, { mode: 0o700 });
    const shim = `#!/usr/bin/env bash
set -euo pipefail
bin="$(dirname "$0")"
program="$(basename "$0")"
case "$program" in
  kubectl)
    # Only the new monthly worker's exact source reads/flush are handled by
    # Node. WATCH, Lease, fences, mutations and all other protected calls retain
    # their original parent identity in the established fake.
    case "$*" in
      "--context fixture-context --request-timeout=30s get namespace hcce -o json"|\
      "--context fixture-context --request-timeout=30s -n hcce get pvc pgsql-pvc ret-pvc -o json"|\
      "--context fixture-context --request-timeout=30s get pv pv-database pv-media -o json"|\
      "--context fixture-context --request-timeout=30s -n hcce get pod pgsql-0 -o json"|\
      "--context fixture-context --request-timeout=30s -n hcce exec pgsql-0 -c pgsql -- sh -ec sync") ;;
      *)
        for arg in "$@"; do
          if [[ "$arg" == --request-timeout=* ]]; then
            exec "$bin/kubectl-legacy" "$@"
          fi
        done
        ;;
    esac
    ;;
  doctl)
    case "\${1:-} \${2:-} \${3:-}" in
      "compute volume get"|"compute volume snapshot"|"compute snapshot list"|"compute snapshot get") ;;
      *) exec "$bin/doctl-legacy" "$@" ;;
    esac
    ;;
  *) exit 98 ;;
esac
exec ${shellQuote(process.execPath)} "$bin/$program-monthly" "$@"
`;
    fs.writeFileSync(path.join(bin, program), shim, { mode: 0o700 });
  }
}

module.exports = { installMonthlyProviderFixture };

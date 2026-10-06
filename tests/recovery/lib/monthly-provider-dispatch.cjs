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
    for arg in "$@"; do
      if [[ "$arg" == --request-timeout=* ]]; then
        exec "$bin/kubectl-legacy" "$@"
      fi
    done
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

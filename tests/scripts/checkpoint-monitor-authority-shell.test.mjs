import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const library = fileURLToPath(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url));
const harness = String.raw`
set -eu
source "$1"
fixture="$2" kind="$3"
EXPECTED_KUBE_CONTEXT=fixture-context NAMESPACE=hcce
RECOVERY_NAMESPACE_UID=namespace-uid
RECOVERY_OPERATION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RECOVERY_OPERATION_OWNER=checkpoint-backup
RECOVERY_OPERATION_LOCK_NAME=fixture-lock RECOVERY_OPERATION_LOCK_UID=lock-uid
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=lock-rv
RECOVERY_SERIALIZATION_LEASE_NAME=fixture-lease RECOVERY_SERIALIZATION_LEASE_UID=lease-uid
RECOVERY_SERIALIZATION_LEASE_HOLDER=fixture-holder
unset RECOVERY_BACKUP_AUTHORITY_KEYRING RECOVERY_BACKUP_AUTHORITY_KEY_ID
keyring="$fixture/not-an-opened-keyring"
key_id=12345678-1234-4abc-8def-1234567890ab
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
pid=$$ identity="$(recovery_process_start_identity "$$")"
contract="$fixture/contract" baseline="$fixture/baseline" control="$fixture/control"
stop="$fixture/stop" failure="$fixture/failure" ready="$fixture/ready"
progress="$fixture/progress" final="$fixture/final"
authority_path="$(recovery_monitor_authority_path "$ready")"
node -e 'const fs=require("node:fs"); for(const p of process.argv.slice(1)) fs.writeFileSync(p,"{}\n",{mode:0o600});' \
  "$contract" "$baseline" "$control" "$stop" "$failure" "$progress" "$final"
baseline_sha="$(recovery_sha256_digest "$baseline")"
construct() {
  if [[ "$kind" == checkpoint-writer-monitor ]]; then
    recovery_checkpoint_writer_monitor_authority_json "$contract" "$sha" "$baseline" \
      "$stop" "$failure" "$ready" "$progress" "$final" "$pid" "$identity" \
      durable-v2 checkpoint-backup
  else
    recovery_durable_runner_monitor_authority_json "$baseline" "$sha" "$control" "$sha" \
      "$stop" "$failure" "$ready" "$progress" "$final" "$pid" "$identity" \
      "$sha" checkpoint-backup
  fi
}
publish() {
  node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1],process.argv[2]+"\n",{mode:0o600}); fs.chmodSync(process.argv[1],0o600);' \
    "$authority_path" "$1"
  authority_sha="$(recovery_sha256_digest "$authority_path")"
  if [[ "$kind" == checkpoint-writer-monitor ]]; then
    ready_text="ready:$baseline_sha:$authority_sha"
  else
    ready_text="ready:$sha:$sha:$sha:$authority_sha"
  fi
  node -e 'require("node:fs").writeFileSync(process.argv[1],process.argv[2]+"\n",{mode:0o600});' "$ready" "$ready_text"
}
check() {
  local status=0
  recovery_monitor_authority_common_is_exact "$authority_path" "$authority_sha" "$kind" \
    "$pid" "$identity" "$failure" "$ready" "$progress" || status=$?
  printf '%s\t%s\n' "$1" "$status"
}
exact() {
  local status=0
  if [[ "$kind" == checkpoint-writer-monitor ]]; then
    recovery_checkpoint_writer_monitor_authority_is_exact "$authority_path" "$authority_sha" \
      "$contract" "$sha" "$baseline" "$stop" "$failure" "$ready" "$progress" \
      "$final" "$pid" "$identity" durable-v2 checkpoint-backup || status=$?
  else
    recovery_durable_runner_monitor_authority_is_exact "$authority_path" "$authority_sha" \
      "$baseline" "$sha" "$control" "$sha" "$stop" "$failure" "$ready" "$progress" \
      "$final" "$pid" "$identity" "$sha" checkpoint-backup || status=$?
  fi
  printf '%s\t%s\n' "$1" "$status"
}
unsigned="$(construct)"
publish "$unsigned"
check unsigned-common
exact unsigned-exact
RECOVERY_BACKUP_AUTHORITY_KEYRING="$keyring" RECOVERY_BACKUP_AUTHORITY_KEY_ID="$key_id"
signed="$(construct)"
publish "$signed"
check signed-common
exact signed-exact
for mutation in keyring key-id extra-inner extra-outer missing-binding wrong-identity; do
  case "$mutation" in
    keyring) changed="$(jq -cS '.backup_authority.keyring_path += "-other"' <<<"$signed")" ;;
    key-id) changed="$(jq -cS '.backup_authority.key_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"' <<<"$signed")" ;;
    extra-inner) changed="$(jq -cS '.backup_authority.extra=true' <<<"$signed")" ;;
    extra-outer) changed="$(jq -cS '.extra=true' <<<"$signed")" ;;
    missing-binding) changed="$unsigned" ;;
    wrong-identity) changed="$(jq -cS '.start_identity += "-not-current"' <<<"$signed")" ;;
  esac
  publish "$changed"
  check "$mutation"
done
publish "$signed"
RECOVERY_BACKUP_AUTHORITY_KEY_ID=
publish "$(construct)"
check half-selector
RECOVERY_BACKUP_AUTHORITY_KEY_ID="$key_id" RECOVERY_BACKUP_AUTHORITY_KEYRING=
publish "$(construct)"
check half-keyring
RECOVERY_BACKUP_AUTHORITY_KEYRING="$keyring"
RECOVERY_BACKUP_AUTHORITY_KEY_ID=not-a-key-id
publish "$(construct)"
check invalid-key-id
RECOVERY_BACKUP_AUTHORITY_KEY_ID="$key_id" RECOVERY_BACKUP_AUTHORITY_KEYRING=relative/keyring
publish "$(construct)"
check relative-keyring
RECOVERY_BACKUP_AUTHORITY_KEYRING="$keyring" RECOVERY_OPERATION_OWNER=checkpoint-restore
restore_signed="$(jq -cS '.operation_owner="checkpoint-restore"' <<<"$signed")"
publish "$restore_signed"
check signed-restore
RECOVERY_OPERATION_OWNER=checkpoint-backup
publish "$signed"
unset RECOVERY_BACKUP_AUTHORITY_KEYRING RECOVERY_BACKUP_AUTHORITY_KEY_ID
check unsolicited-binding
RECOVERY_BACKUP_AUTHORITY_KEYRING="$keyring" RECOVERY_BACKUP_AUTHORITY_KEY_ID="$key_id"
publish "$signed"
authority_sha=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
check wrong-file-hash
publish "$signed"
node -e 'require("node:fs").chmodSync(process.argv[1],0o644);' "$authority_path"
check public-file
publish "$signed"
node -e 'require("node:fs").writeFileSync(process.argv[1],"ready:wrong\n");' "$ready"
check wrong-ready
publish "$signed"
if [[ "$kind" == checkpoint-writer-monitor ]]; then
  node -e 'require("node:fs").writeFileSync(process.argv[1],"changed baseline\n");' "$baseline"
  check wrong-baseline
fi
`;

for (const kind of ["checkpoint-writer-monitor", "durable-runner-quiescence-monitor"]) {
  test(`${kind}: the real shell boundary accepts exact signed/unsigned authority and rejects drift`, t => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "yenhubs-shell-authority-"));
    chmodSync(directory, 0o700);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // The library deliberately rejects Bash <4.1. A missing supported shell,
    // Python identity reader, Node or jq fails this regression, never skips it.
    const result = spawnSync(process.env.YENHUBS_TEST_BASH || "bash", ["-c", harness, "_", library, directory, kind], {
      encoding: "utf8", timeout: 30000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const outcomes = Object.fromEntries(result.stdout.trim().split("\n").map(line => {
      const [label, status] = line.split("\t");
      assert.match(status, /^[0-9]+$/);
      return [label, Number(status)];
    }));
    for (const label of ["unsigned-common", "unsigned-exact", "signed-common", "signed-exact"]) {
      assert.equal(outcomes[label], 0, `${label}: ${JSON.stringify(outcomes)}`);
    }
    for (const label of ["keyring", "key-id", "extra-inner", "extra-outer", "missing-binding", "wrong-identity",
      "half-selector", "half-keyring", "invalid-key-id", "relative-keyring", "signed-restore", "unsolicited-binding", "wrong-file-hash",
      "public-file", "wrong-ready", ...(kind === "checkpoint-writer-monitor" ? ["wrong-baseline"] : [])]) {
      assert.equal(outcomes[label], 1, `${label} must fail closed`);
    }
  });
}

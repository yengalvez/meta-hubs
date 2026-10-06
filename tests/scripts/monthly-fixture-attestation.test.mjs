import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lib = fileURLToPath(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url));
async function attest(overrides = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-attestation-fixture-")));
  await writeFile(join(parent, "kubectl"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("current-context")) process.stdout.write(process.env.OBSERVED_CONTEXT);
else if (args.includes("namespace")) process.stdout.write(process.env.OBSERVED_NAMESPACE_UID);
else if (args.includes("pvc")) process.stdout.write(process.env.OBSERVED_PVC_UID);
else process.exit(90);
`, { mode: 0o700 });
  const env = { PATH: parent + ":" + dirname(process.execPath) + ":/opt/homebrew/bin:/usr/bin:/bin",
    YENHUBS_RECOVERY_TEST_MODE: "local-fixture", EXPECTED_KUBE_CONTEXT: "fixture-context", NAMESPACE: "hcce",
    EXPECTED_NAMESPACE_UID: "fixture-uid", EXPECTED_RET_PVC_UID: "fixture-pvc-uid",
    OBSERVED_CONTEXT: "fixture-context", OBSERVED_NAMESPACE_UID: "fixture-uid", OBSERVED_PVC_UID: "fixture-pvc-uid", ...overrides };
  const result = spawnSync("bash", ["-c", 'source "$1"; recovery_require_local_fixture_attestation', "_", lib],
    { env, encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error);
  return result.status;
}
const native = { YENHUBS_RECOVERY_TEST_NATIVE_MONTHLY: "1", EXPECTED_NAMESPACE_UID: id(1),
  EXPECTED_RET_PVC_UID: id(6), OBSERVED_NAMESPACE_UID: id(1), OBSERVED_PVC_UID: id(6) };
test("legacy attestation remains exact", async () => assert.equal(await attest(), 0));
test("native fixture admits only its explicit fixed pair with matching observations", async () => assert.equal(await attest(native), 0));
test("native UUID fixture is denied without its explicit flag", async () => assert.equal(await attest({ ...native, YENHUBS_RECOVERY_TEST_NATIVE_MONTHLY: "0" }), 1));
test("native flag never broadens the legacy pair", async () => assert.equal(await attest({ YENHUBS_RECOVERY_TEST_NATIVE_MONTHLY: "1" }), 1));
test("native fixture rejects another context or namespace", async () => {
  for (const override of [{ EXPECTED_KUBE_CONTEXT: "production" }, { NAMESPACE: "other" }, { YENHUBS_RECOVERY_TEST_MODE: "wrong" }]) {
    assert.equal(await attest({ ...native, ...override }), 1);
  }
});
test("native fixture rejects wrong expected or live UIDs and live context", async () => {
  for (const override of [{ EXPECTED_NAMESPACE_UID: id(99) }, { EXPECTED_RET_PVC_UID: id(99) },
    { OBSERVED_NAMESPACE_UID: id(99) }, { OBSERVED_PVC_UID: id(99) }, { OBSERVED_CONTEXT: "production" }]) {
    assert.equal(await attest({ ...native, ...override }), 1);
  }
});
test("unknown native fixture flags fail closed", async () => assert.equal(await attest({ ...native, YENHUBS_RECOVERY_TEST_NATIVE_MONTHLY: "yes" }), 1));

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Exercise the actual generated fake-kubectl argument parser without running
// the recovery suite, creating resources or accepting any API mutation.
const suite = fs.readFileSync(new URL("../recovery/test-recovery-safety.sh", import.meta.url), "utf8");
const prefix = suite.split('cat >"$TMP_DIR/bin/kubectl" <<\'STUB\'\n')[1]?.split('LEASE_FIXTURE_LOCK_DIR=')[0];
assert.ok(prefix?.includes('joined="$*"'), "exact stub parser found");
function parse(args) {
  const result = spawnSync("bash", ["-c", prefix + '\nprintf "%s\\n%s\\n" "$request_timeout" "$joined"\n', "stub", ...args], {
    encoding: "utf8", env: { ...process.env, KUBECTL_LOG: "/dev/null", STUB_LOCAL_INPUT_BINDING_LOG: "" }
  });
  return { status: result.status, lines: result.stdout.trim().split("\n") };
}
test("renewal read and replace keep the terminal 3-second override", () => {
  for (const verb of [
    ["get", "lease", "yenhubs-operation-serialization", "-n", "hcce", "-o", "json"],
    ["replace", "-f", "-", "-o", "json"]
  ]) {
    const result = parse(["--context", "fixture-context", "--request-timeout=45s", ...verb, "--request-timeout=3s"]);
    assert.deepEqual(result, { status: 0, lines: ["--request-timeout=3s", verb.join(" ")] });
  }
});
test("receipt GET aliases and namespace prefixes map to the same fake read", () => {
  for (const [kind, name, canonical] of [
    ["lease", "yenhubs-operation-serialization", "lease"],
    ["deployment", "reticulum", "deployment"],
    ["cm", "yenhubs-recovery-operation-lock", "configmap"]
  ]) {
    const result = parse(["--context", "fixture-context", "--request-timeout=20s", "-n", "hcce", "get", kind, name, "-o", "json"]);
    assert.deepEqual(result, { status: 0, lines: ["--request-timeout=20s", `get ${canonical} ${name} -n hcce -o json`] });
  }
});
test("receipt cluster-scope reads preserve their exact command", () => {
  const result = parse(["--context", "fixture-context", "--request-timeout=20s", "get", "validatingadmissionpolicy", "recovery-operation-pod-fence.yenhubs.org", "-o", "json"]);
  assert.deepEqual(result, { status: 0, lines: ["--request-timeout=20s", "get validatingadmissionpolicy recovery-operation-pod-fence.yenhubs.org -o json"] });
});
test("unsupported timeout and unsupported receipt resource still fail", () => {
  assert.equal(parse(["--request-timeout=99s", "get", "pods"]).status, 89);
  assert.equal(parse(["--request-timeout=20s", "-n", "hcce", "get", "unknown", "x", "-o", "json"]).status, 89);
});


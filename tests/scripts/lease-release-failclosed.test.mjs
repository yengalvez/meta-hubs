import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const library = readFileSync(join(root, "deployment/lib/recovery-safety.sh"), "utf8");
const shell = process.env.YENHUBS_TEST_BASH || "bash";
function fn(name) {
  const start = library.indexOf(`${name}() {\n`);
  assert.notEqual(start, -1, `production function ${name}`);
  const end = library.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `production function boundary ${name}`);
  return library.slice(start, end + 3);
}

// Exercise the exact production function and its real Lease validators, not a
// copied implementation. Extraction deliberately keeps this narrow contract
// runnable on Bash 3.2; sourcing the whole library requires Bash >= 4.1.
const production = [
  "recovery_rfc3339_epoch", "recovery_serialization_lease_json_is_valid",
  "recovery_owned_serialization_lease_json_is_exact",
  "recovery_start_operation_serialization_heartbeat", "recovery_release_operation_serialization"
].map(fn).join("\n");
const fields = [
  "RECOVERY_SERIALIZATION_LEASE_REQUIRED", "RECOVERY_SERIALIZATION_LEASE_HOLDER",
  "RECOVERY_SERIALIZATION_LEASE_UID", "RECOVERY_SERIALIZATION_ADOPTED",
  "RECOVERY_SERIALIZATION_HEARTBEAT_PID", "RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY",
  "RECOVERY_SERIALIZATION_HEARTBEAT_STOP", "RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE",
  "RECOVERY_SERIALIZATION_HEARTBEAT_STOPPED_CLEANLY", "RECOVERY_SERIALIZATION_PARENT_PID",
  "RECOVERY_SERIALIZATION_PARENT_START_IDENTITY", "RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID",
  "RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY"
];
const holder = "root-recovery:01234567-89ab-4cde-8f01-23456789abcd";

function run({ pid = "424242", start = "fixture-heartbeat-start", identity = true,
  numericPidLive = true, waitStatus = 0, failure = "", failureDuringWait = "",
  required = "1", adopted = "0", mutateLease, response = "valid",
  firstRemoteFailure = "", failureBeforeRetry = "", mutateLeaseBeforeRetry,
  invalidStart = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "yenhubs-lease-release-")));
  const paths = Object.fromEntries(["lease", "replace", "remote", "events", "stop", "failure", "once", "retry_lease"]
    .map(name => [name, join(directory, name)]));
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", ".000000Z");
  const lease = {
    apiVersion: "coordination.k8s.io/v1", kind: "Lease",
    metadata: { name: "yenhubs-operation-serialization", namespace: "hcce",
      uid: "fixture-lease-uid", resourceVersion: "73",
      labels: { "yenhubs.org/operation-serialization": "deployment-recovery" } },
    spec: { holderIdentity: holder, leaseDurationSeconds: 120, acquireTime: now,
      renewTime: now, leaseTransitions: 9 }
  };
  mutateLease?.(lease);
  const retryLease = structuredClone(lease);
  mutateLeaseBeforeRetry?.(retryLease);
  const before = {
    RECOVERY_SERIALIZATION_LEASE_REQUIRED: required,
    RECOVERY_SERIALIZATION_LEASE_HOLDER: holder,
    RECOVERY_SERIALIZATION_LEASE_UID: "fixture-lease-uid",
    RECOVERY_SERIALIZATION_ADOPTED: adopted,
    RECOVERY_SERIALIZATION_HEARTBEAT_PID: pid,
    RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY: start,
    RECOVERY_SERIALIZATION_HEARTBEAT_STOP: paths.stop,
    RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE: paths.failure,
    RECOVERY_SERIALIZATION_HEARTBEAT_STOPPED_CLEANLY: invalidStart ? "1" : "0",
    RECOVERY_SERIALIZATION_PARENT_PID: "515151",
    RECOVERY_SERIALIZATION_PARENT_START_IDENTITY: "fixture-parent-start",
    RECOVERY_SERIALIZATION_ADOPTED_PARENT_PID: "",
    RECOVERY_SERIALIZATION_ADOPTED_PARENT_START_IDENTITY: ""
  };
  try {
    for (const [name, path] of Object.entries(paths)) {
      writeFileSync(path, name === "lease" ? JSON.stringify(lease) : name === "retry_lease" ? JSON.stringify(retryLease) : name === "failure" ? failure : "",
        { mode: 0o600 });
    }
    const script = `set -euo pipefail
${production}
NAMESPACE=hcce
RECOVERY_SERIALIZATION_LEASE_NAME=yenhubs-operation-serialization
${fields.map(name => `${name}="$${name}"`).join("\n")}
recovery_process_identity_is_live() {
  printf 'identity\\t%s\\t%s\\n' "$1" "$2" >>"$TEST_EVENTS"
  [[ "$1" == 424242 && "$2" == fixture-heartbeat-start && "$TEST_IDENTITY" == 1 ]]
}
# No real PID lookup, signal, child process or join occurs in this fixture.
kill() {
  printf 'kill\\t%s\\n' "$*" >>"$TEST_EVENTS"
  case "$*" in
    '-TERM 424242') return 0 ;;
    '-0 424242') [[ "$TEST_NUMERIC_PID_LIVE" == 1 ]] ;;
    *) return 97 ;;
  esac
}
wait() {
  printf 'wait\\t%s\\n' "$*" >>"$TEST_EVENTS"
  [[ "$*" == 424242 ]] || return 97
  if [[ -n "$TEST_FAILURE_DURING_WAIT" ]]; then
    printf '%s' "$TEST_FAILURE_DURING_WAIT" >"$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
  fi
  return "$TEST_WAIT_STATUS"
}
recovery_kubectl() {
  printf '%s\\n' "$*" >>"$TEST_REMOTE"
  printf 'remote\\t%s\\n' "$*" >>"$TEST_EVENTS"
  case "$*" in
    'get lease yenhubs-operation-serialization -n hcce -o json')
      if [[ "$TEST_FIRST_REMOTE_FAILURE" == get && ! -s "$TEST_ONCE" ]]; then
        printf 'failed\\n' >"$TEST_ONCE"
        return 37
      fi
      command cat "$TEST_LEASE" ;;
    'replace -f - -o json')
      command cat >"$TEST_REPLACE"
      if [[ "$TEST_FIRST_REMOTE_FAILURE" == replace && ! -s "$TEST_ONCE" ]]; then
        printf 'failed\\n' >"$TEST_ONCE"
        return 37
      fi
      case "$TEST_RESPONSE" in
        valid) jq '.metadata.resourceVersion = "74"' "$TEST_REPLACE" ;;
        wrong-uid) jq '.metadata.resourceVersion = "74" | .metadata.uid = "other-lease-uid"' "$TEST_REPLACE" ;;
        wrong-transitions) jq '.metadata.resourceVersion = "74" | .spec.leaseTransitions += 1' "$TEST_REPLACE" ;;
        *) return 97 ;;
      esac ;;
    *) return 97 ;;
  esac
}
snapshot() {
  local prefix="$1" field
  printf '%sstatus\\t%s\\n' "$prefix" "$status"
  for field in ${fields.join(" ")}; do
    printf '%s%s\\t%s\\n' "$prefix" "$field" "\${!field}"
  done
}
if [[ "$TEST_INVALID_START" == 1 ]]; then
  RECOVERY_LEASE_HEARTBEAT_SECONDS=0
  if recovery_start_operation_serialization_heartbeat; then status=0; else status=$?; fi
else
  if recovery_release_operation_serialization; then status=0; else status=$?; fi
  if [[ -n "$TEST_FIRST_REMOTE_FAILURE" ]]; then
    snapshot first_
    if [[ -n "$TEST_FAILURE_BEFORE_RETRY" ]]; then
      printf '%s' "$TEST_FAILURE_BEFORE_RETRY" >"$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE"
    fi
    if [[ "$TEST_MUTATE_LEASE_BEFORE_RETRY" == 1 ]]; then
      command cat "$TEST_RETRY_LEASE" >"$TEST_LEASE"
    fi
    if recovery_release_operation_serialization; then status=0; else status=$?; fi
  fi
fi
snapshot ''
`;
    // Do not inherit shell startup files, exported functions/options or any
    // credential/config environment. The API stub is a closed local fixture.
    const result = spawnSync(shell, ["--noprofile", "--norc", "-c", script], {
      cwd: root, encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC",
        ...before, TEST_IDENTITY: identity ? "1" : "0",
        TEST_NUMERIC_PID_LIVE: numericPidLive ? "1" : "0", TEST_WAIT_STATUS: String(waitStatus),
        TEST_FAILURE_DURING_WAIT: failureDuringWait, TEST_RESPONSE: response,
        TEST_FIRST_REMOTE_FAILURE: firstRemoteFailure, TEST_FAILURE_BEFORE_RETRY: failureBeforeRetry,
        TEST_MUTATE_LEASE_BEFORE_RETRY: mutateLeaseBeforeRetry ? "1" : "0", TEST_INVALID_START: invalidStart ? "1" : "0",
        ...Object.fromEntries(Object.entries(paths).map(([name, path]) => [`TEST_${name.toUpperCase()}`, path])) }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `fixture must finish and report release status: ${result.stderr}`);
    assert.equal(result.stderr, "", "no fixture/validator error may masquerade as fail-closed success");
    const report = Object.fromEntries(result.stdout.split("\n").filter(Boolean).map(line => {
      const tab = line.indexOf("\t");
      assert.ok(tab > 0, `unexpected fixture output: ${line}`);
      return [line.slice(0, tab), line.slice(tab + 1)];
    }));
    const status = Number(report.status);
    const firstStatus = firstRemoteFailure ? Number(report.first_status) : undefined;
    const firstState = firstRemoteFailure ? Object.fromEntries(fields.map(field => [field, report[`first_${field}`]])) : undefined;
    const state = Object.fromEntries(fields.map(field => [field, report[field]]));
    return { status, firstStatus, firstState, state, before, lease,
      remote: readFileSync(paths.remote, "utf8").split("\n").filter(Boolean),
      events: readFileSync(paths.events, "utf8").split("\n").filter(Boolean),
      replacement: readFileSync(paths.replace, "utf8"),
      stopExists: existsSync(paths.stop), failureExists: existsSync(paths.failure),
      failure: existsSync(paths.failure) ? readFileSync(paths.failure, "utf8") : undefined };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertBlocked(result, { noTerm = false, noWait = false } = {}) {
  // Check every observable even when current production returns an error late:
  // nonzero alone cannot prove that the Lease was not remotely released.
  assert.deepEqual({ status: result.status, remote: result.remote, replacement: result.replacement,
    state: result.state, stopExists: result.stopExists, failureExists: result.failureExists },
  { status: 1, remote: [], replacement: "", state: result.before, stopExists: true, failureExists: true });
  if (noTerm) assert.ok(!result.events.some(event => event.startsWith("kill\t-TERM")), "ambiguous PID must not receive TERM");
  if (noWait) assert.ok(!result.events.some(event => event.startsWith("wait\t")), "ambiguous live PID must not be joined");
}

test("ambiguous live heartbeat identity blocks release before any remote GET/replace without signalling", () => {
  assertBlocked(run({ start: "wrong-start", identity: false }), { noTerm: true, noWait: true });
});

test("a failed heartbeat join preserves authority and blocks every remote call", () => {
  const result = run({ waitStatus: 37 });
  assertBlocked(result);
  assert.ok(result.events.includes("wait\t424242"), "test must actually exercise the join failure");
});

test("an already-exited heartbeat with a failed join cannot authorize release", () => {
  assertBlocked(run({ identity: false, numericPidLive: false, waitStatus: 37 }), { noTerm: true });
});

for (const failure of ["lease_lost\n", "unknown heartbeat failure\n"]) {
  test(`nonempty heartbeat failure blocks release despite a clean join: ${JSON.stringify(failure)}`, () => {
    const result = run({ failure });
    assertBlocked(result);
    assert.equal(result.failure, failure, "failure evidence must remain intact");
  });
}

test("failure written during the heartbeat join is checked before remote release", () => {
  const result = run({ failureDuringWait: "lease_lost\n" });
  assertBlocked(result);
  assert.equal(result.failure, "lease_lost\n");
});

for (const [name, pid, start] of [
  ["both heartbeat fields empty", "", ""],
  ["missing start identity", "424242", ""],
  ["missing PID", "", "fixture-heartbeat-start"],
  ["nonnumeric PID", "not-a-pid", "fixture-heartbeat-start"],
  ["zero PID", "0", "fixture-heartbeat-start"]
]) {
  test(`${name} cannot fabricate a clean heartbeat-stop capability`, () => {
    assertBlocked(run({ pid, start }), { noTerm: true });
  });
}

test("a prior failure marker with empty heartbeat fields cannot authorize release", () => {
  assertBlocked(run({ pid: "", start: "", failure: "lease_lost\n" }), { noTerm: true, noWait: true });
});

for (const [name, options] of [
  ["identified live heartbeat", {}],
  ["already-exited heartbeat joined successfully", { identity: false, numericPidLive: false }]
]) {
  test(`clean ${name} releases exactly the owned UID/RV/transitions`, () => {
    const result = run(options);
    assert.equal(result.status, 0);
    assert.deepEqual(result.remote, ["get lease yenhubs-operation-serialization -n hcce -o json", "replace -f - -o json"]);
    assert.deepEqual(JSON.parse(result.replacement), {
      apiVersion: result.lease.apiVersion, kind: result.lease.kind, metadata: result.lease.metadata,
      spec: { leaseDurationSeconds: 120, leaseTransitions: 9 }
    }, "release CAS must preserve the exact live UID, resourceVersion and transitions");
    const joinIndex = result.events.indexOf("wait\t424242");
    const remoteIndex = result.events.findIndex(event => event.startsWith("remote\t"));
    assert.ok(joinIndex >= 0 && remoteIndex > joinIndex,
      "clean join must precede the first remote call");
    for (const field of ["RECOVERY_SERIALIZATION_LEASE_HOLDER", "RECOVERY_SERIALIZATION_LEASE_UID",
      "RECOVERY_SERIALIZATION_HEARTBEAT_PID", "RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY"])
      assert.equal(result.state[field], "");
    assert.equal(result.state.RECOVERY_SERIALIZATION_LEASE_REQUIRED, "0");
    assert.equal(result.state.RECOVERY_SERIALIZATION_HEARTBEAT_STOPPED_CLEANLY, "0");
    assert.equal(result.stopExists, false);
    assert.equal(result.failureExists, false);
  });
}

function assertCleanStopRetained(result) {
  assert.equal(result.firstStatus, 1);
  assert.deepEqual(result.firstState, { ...result.before,
    RECOVERY_SERIALIZATION_HEARTBEAT_PID: "", RECOVERY_SERIALIZATION_HEARTBEAT_START_IDENTITY: "",
    RECOVERY_SERIALIZATION_HEARTBEAT_STOPPED_CLEANLY: "1" });
  assert.equal(result.events.filter(event => event === "wait\t424242").length, 1,
    "reentry must not join the retired numeric PID again");
  assert.equal(result.events.filter(event => event === "kill\t-TERM 424242").length, 1,
    "reentry must not signal the retired numeric PID again");
}

for (const firstRemoteFailure of ["get", "replace"]) {
  test(`a clean-stop capability permits exact release reentry after a failed ${firstRemoteFailure}`, () => {
    const result = run({ firstRemoteFailure });
    assertCleanStopRetained(result);
    assert.equal(result.status, 0);
    const get = "get lease yenhubs-operation-serialization -n hcce -o json";
    const replace = "replace -f - -o json";
    assert.deepEqual(result.remote, firstRemoteFailure === "get" ? [get, get, replace] : [get, replace, get, replace]);
    assert.deepEqual(JSON.parse(result.replacement), {
      apiVersion: result.lease.apiVersion, kind: result.lease.kind, metadata: result.lease.metadata,
      spec: { leaseDurationSeconds: 120, leaseTransitions: 9 }
    });
    assert.equal(result.state.RECOVERY_SERIALIZATION_LEASE_REQUIRED, "0");
    assert.equal(result.state.RECOVERY_SERIALIZATION_HEARTBEAT_STOPPED_CLEANLY, "0");
  });
}

test("clean-stop reentry rechecks a later failure marker before any new remote call", () => {
  const result = run({ firstRemoteFailure: "get", failureBeforeRetry: "lease_lost\n" });
  assertCleanStopRetained(result);
  assert.equal(result.status, 1);
  assert.deepEqual(result.remote, ["get lease yenhubs-operation-serialization -n hcce -o json"]);
  assert.equal(result.replacement, "");
  assert.deepEqual(result.state, result.firstState);
  assert.equal(result.failure, "lease_lost\n");
  assert.equal(result.stopExists, true);
  assert.equal(result.failureExists, true);
});

test("clean-stop reentry revalidates the live Lease UID before replace", () => {
  const result = run({ firstRemoteFailure: "get", mutateLeaseBeforeRetry: lease => { lease.metadata.uid = "other-lease-uid"; } });
  assertCleanStopRetained(result);
  assert.equal(result.status, 1);
  const get = "get lease yenhubs-operation-serialization -n hcce -o json";
  assert.deepEqual(result.remote, [get, get]);
  assert.equal(result.replacement, "");
  assert.deepEqual(result.state, result.firstState);
});

test("starting a heartbeat invalidates a prior clean-stop capability before any launch", () => {
  const result = run({ invalidStart: true });
  assert.equal(result.status, 2, "invalid interval must stop before files/process creation");
  assert.deepEqual(result.state, { ...result.before, RECOVERY_SERIALIZATION_HEARTBEAT_STOPPED_CLEANLY: "0" });
  assert.deepEqual(result.remote, []);
  assert.deepEqual(result.events, []);
});

for (const [name, mutateLease] of [
  ["foreign UID", lease => { lease.metadata.uid = "other-lease-uid"; }],
  ["foreign holder", lease => { lease.spec.holderIdentity = "cloud-apply:01234567-89ab-4cde-8f01-23456789abcd"; }],
  ["stale renewal", lease => { lease.spec.renewTime = "2020-01-01T00:00:00.000000Z"; }],
  ["future renewal", lease => { lease.spec.renewTime = "2099-01-01T00:00:00.000000Z"; }]
]) {
  test(`clean join still refuses release of a Lease with ${name}`, () => {
    const result = run({ mutateLease });
    assert.equal(result.status, 1);
    assert.deepEqual(result.remote, ["get lease yenhubs-operation-serialization -n hcce -o json"]);
    assert.equal(result.replacement, "");
    for (const field of ["RECOVERY_SERIALIZATION_LEASE_REQUIRED", "RECOVERY_SERIALIZATION_LEASE_HOLDER", "RECOVERY_SERIALIZATION_LEASE_UID"])
      assert.equal(result.state[field], result.before[field]);
  });
}

for (const response of ["wrong-uid", "wrong-transitions"]) {
  test(`a ${response} replace response cannot clear local Lease authority`, () => {
    const result = run({ response });
    assert.equal(result.status, 1);
    assert.equal(result.remote.length, 2);
    for (const field of ["RECOVERY_SERIALIZATION_LEASE_REQUIRED", "RECOVERY_SERIALIZATION_LEASE_HOLDER", "RECOVERY_SERIALIZATION_LEASE_UID"])
      assert.equal(result.state[field], result.before[field]);
  });
}

for (const [name, options, status] of [
  ["no owned Lease", { required: "0" }, 0],
  ["an adopted parent Lease", { adopted: "1" }, 2]
]) {
  test(`${name} does not signal, join, read, replace or change capabilities`, () => {
    const result = run(options);
    assert.equal(result.status, status);
    assert.deepEqual(result.state, result.before);
    assert.deepEqual(result.remote, []);
    assert.deepEqual(result.events, []);
  });
}

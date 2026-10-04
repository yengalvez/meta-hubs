import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const suite = readFileSync(join(root, "tests/recovery/test-recovery-safety.sh"), "utf8");
function extractStub(source) {
  const fixture = source.split('cat >"$TMP_DIR/bin/kubectl" <<\'STUB\'\n')[1]?.split("\nSTUB\n")[0];
  assert.ok(fixture, "actual generated kubectl fixture found");
  return fixture;
}
const stub = extractStub(suite);
const baselineRevision = "7ba94129d7d11e369b519a2529cdef65c11458eb";
const baselineSource = spawnSync("git", ["show", `${baselineRevision}:tests/recovery/test-recovery-safety.sh`], {
  cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024
});
assert.equal(baselineSource.status, 0, "frozen pre-policy-fast-path baseline must be available");
const baselineStub = extractStub(baselineSource.stdout);
const parserEnd = stub.indexOf('joined="$*"\n') + 'joined="$*"\n'.length;
const bodyStart = stub.indexOf("LEASE_FIXTURE_LOCK_DIR=");
assert.ok(parserEnd > 0 && bodyStart >= parserEnd, "existing parser and full dispatch boundaries");
const baselineParserEnd = baselineStub.indexOf('joined="$*"\n') + 'joined="$*"\n'.length;
const baselineBodyStart = baselineStub.indexOf("LEASE_FIXTURE_LOCK_DIR=");
assert.ok(baselineParserEnd > 0 && baselineBodyStart >= baselineParserEnd, "frozen baseline dispatch boundaries");
const fullDispatch = baselineStub.slice(0, baselineParserEnd) + baselineStub.slice(baselineBodyStart);
const tripwire = stub.slice(0, bodyStart) + 'printf "FULL_FIXTURE_BODY_EVALUATED\\n" >&2\nexit 97\n' + stub.slice(bodyStart);

const directory = mkdtempSync(join(tmpdir(), "yenhubs-namespace-fast-"));
chmodSync(directory, 0o700);
test.after(() => rmSync(directory, { recursive: true, force: true }));
const scripts = {};
for (const [name, contents] of Object.entries({ candidate: stub, baseline: baselineStub, full: fullDispatch, tripwire })) {
  scripts[name] = join(directory, `${name}.sh`);
  writeFileSync(scripts[name], contents, { mode: 0o700 });
}

function fixture(value = { apiVersion: "v1", kind: "Namespace", metadata: { name: "hcce", uid: "fixture-uid", resourceVersion: "rv-1" } }, namespace = "hcce") {
  const path = join(directory, `namespace-${namespace}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
}

function run(script = "candidate", namespace = "hcce", overrides = {}, args, encoding = "utf8") {
  const env = { ...process.env, KUBECTL_LOG: "/dev/null", STUB_LOCAL_INPUT_BINDING_LOG: "", STUB_STATE_DIR: directory,
    RUNNER_EVIDENCE_LIVE_DIR: directory, STUB_MODE: "", STUB_MONITOR_WATCH_PACE: "0", ...overrides };
  delete env.BASH_ENV;
  delete env.ENV;
  const result = spawnSync(scripts[script], args ?? ["--context", "fixture-context", "--request-timeout=45s", "get", "--raw", `/api/v1/namespaces/${namespace}`], {
    env, encoding
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function equivalent(namespace = "hcce", overrides = {}) {
  const candidate = run("candidate", namespace, overrides);
  assert.deepEqual(candidate, run("full", namespace, overrides));
  return candidate;
}

test("default namespace reads exit before evaluating the large fixture body", () => {
  for (const namespace of ["hcce", "hcce-bot-runners"]) {
    fixture({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, uid: "fixture-uid", resourceVersion: "rv-1" } }, namespace);
    const result = run("tripwire", namespace);
    assert.equal(result.status, 0, "read must not evaluate the full fixture dispatch");
    assert.equal(JSON.parse(result.stdout).metadata.labels["kubernetes.io/metadata.name"], namespace);
    assert.doesNotMatch(result.stderr, /FULL_FIXTURE_BODY_EVALUATED/);
  }
});

test("ordinary output bytes and status match the existing full dispatch", () => {
  for (const labels of [undefined, null, {}, { other: "preserved" }, { "kubernetes.io/metadata.name": "stale" }]) {
    fixture({ apiVersion: "v1", kind: "Namespace", metadata: { name: "hcce", uid: "fixture-uid", resourceVersion: "rv-1", labels } });
    const result = equivalent();
    assert.equal(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.metadata.labels["kubernetes.io/metadata.name"], "hcce");
    if (labels?.other) assert.equal(value.metadata.labels.other, labels.other);
  }
});

test("each read observes fresh identity, version and labels without changing the input", () => {
  for (let version = 1; version <= 3; version++) {
    const path = fixture({ apiVersion: "v1", kind: "Namespace", metadata: { name: "hcce", uid: `fixture-uid-${version}`, resourceVersion: `rv-${version}`, labels: { other: `label-${version}` } } });
    const before = readFileSync(path, "utf8");
    const result = equivalent();
    assert.equal(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.metadata.uid, `fixture-uid-${version}`);
    assert.equal(value.metadata.resourceVersion, `rv-${version}`);
    assert.equal(value.metadata.labels.other, `label-${version}`);
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("malformed payloads retain the old JSON failure codes and diagnostics", () => {
  for (const payload of ["{invalid", "[]", '"not an object"', { metadata: { name: "hcce", labels: "wrong type" } }]) {
    fixture(payload);
    const result = equivalent();
    assert.notEqual(result.status, 0);
  }
});

test("missing input remains failure with the same status and diagnostics", () => {
  fixture();
  const result = equivalent("hcce", { RUNNER_EVIDENCE_LIVE_DIR: join(directory, "does-not-exist") });
  assert.notEqual(result.status, 0);
});

test("logging and input-binding provenance are preserved", () => {
  fixture();
  const log = join(directory, "calls.log");
  const binding = join(directory, "binding.log");
  writeFileSync(log, "", { mode: 0o600 });
  writeFileSync(binding, "", { mode: 0o600 });
  const result = run("candidate", "hcce", { KUBECTL_LOG: log, STUB_LOCAL_INPUT_BINDING_LOG: binding,
    HCCE_MANIFEST_PATH: "fixture-manifest", PROCESS_LOCAL_CUTOVER_KEY_PATH: "fixture-key-path" });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(log, "utf8"), "--context fixture-context --request-timeout=45s get --raw /api/v1/namespaces/hcce\n");
  assert.equal(readFileSync(binding, "utf8"), "fixture-manifest\tfixture-key-path\n");
});

test("every nonempty fault mode retains the full fixture dispatch", () => {
  fixture();
  for (const mode of ["checkpoint-writer-fence-global-deadline", "checkpoint-active-fence-read-failure", "restore-lock-deletion-timestamp", "unknown-fixture-mode", " "]) {
    const result = run("tripwire", "hcce", { STUB_MODE: mode });
    assert.equal(result.status, 97);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "FULL_FIXTURE_BODY_EVALUATED\n");
    assert.equal(equivalent("hcce", { STUB_MODE: mode }).status, 0);
  }
});

test("watch, named lists, other resources and nonexact argument shapes retain full dispatch", () => {
  for (const args of [
    ["get", "--raw", "/api/v1/namespaces/hcce?watch=true&timeoutSeconds=2"],
    ["get", "--raw", "/api/v1/namespaces?fieldSelector=metadata.name%3Dhcce"],
    ["get", "namespace", "hcce", "-o", "json"],
    ["get", "--raw", "/api/v1/namespaces/other"],
    ["get", "--raw", "/api/v1/namespaces/hcce", "--extra"]
  ]) {
    const result = run("tripwire", "hcce", {}, ["--context", "fixture-context", "--request-timeout=45s", ...args]);
    assert.equal(result.status, 97);
    assert.equal(result.stderr, "FULL_FIXTURE_BODY_EVALUATED\n");
  }
});

test("unsupported timeout still fails in the original parser before dispatch", () => {
  fixture();
  const result = run("tripwire", "hcce", {}, ["--context", "fixture-context", "--request-timeout=99s", "get", "--raw", "/api/v1/namespaces/hcce"]);
  assert.equal(result.status, 89);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("named LIST and ordinary WATCH still use their old response contracts", () => {
  fixture();
  for (const path of [
    "/api/v1/namespaces?fieldSelector=metadata.name%3Dhcce",
    "/api/v1/namespaces?fieldSelector=metadata.name%3Dhcce&resourceVersion=namespace-rv-hcce&watch=true&timeoutSeconds=2"
  ]) {
    const args = ["--context", "fixture-context", "--request-timeout=45s", "get", "--raw", path];
    const result = run("candidate", "hcce", {}, args);
    assert.deepEqual(result, run("full", "hcce", {}, args));
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length > 0);
  }
});

const policyCollection = "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies";
const policyName = "recovery-operation-pod-fence.yenhubs.org";
const policyPath = `${policyCollection}/${policyName}`;
const policyInput = join(directory, "recovery-policy.json");
const policyArguments = ["--context", "fixture-context", "--request-timeout=45s", "get", "--raw", policyPath];

function policyFixture(value = readFileSync(join(root, "tests/recovery/fixtures/recovery-operation-pod-fence-policy.json")), replace = false) {
  const path = replace ? `${policyInput}.replacement` : policyInput;
  writeFileSync(path, value, { mode: 0o600 });
  if (replace) renameSync(path, policyInput);
  return policyInput;
}

function runPolicy(script = "candidate", overrides = {}, args = policyArguments) {
  return run(script, "hcce", { RECOVERY_OPERATION_FENCE_POLICY_FIXTURE: policyInput, ...overrides }, args, null);
}

function equivalentPolicy(overrides = {}, args = policyArguments) {
  const candidate = runPolicy("candidate", overrides, args);
  assert.deepEqual(candidate, runPolicy("baseline", overrides, args));
  return candidate;
}

test("default exact raw policy reads exit before evaluating the large fixture body", () => {
  policyFixture();
  const result = runPolicy("tripwire");
  assert.equal(result.status, 0, "policy read must not evaluate the full fixture dispatch");
  assert.deepEqual(result.stdout, readFileSync(policyInput));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
});

test("raw policy output and status match frozen baseline bytes, including invalid JSON", () => {
  for (const bytes of [
    readFileSync(join(root, "tests/recovery/fixtures/recovery-operation-pod-fence-policy.json")),
    Buffer.alloc(0), Buffer.from("{invalid\n"), Buffer.from("[]\r\n"), Buffer.from('"not an object"'),
    Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x00, 0xff, 0x7d, 0x0a, 0x0a])
  ]) {
    policyFixture(bytes);
    const result = equivalentPolicy();
    assert.equal(result.status, 0, "raw cat must not parse or rewrite policy bytes");
    assert.deepEqual(result.stdout, bytes);
    assert.deepEqual(result.stderr, Buffer.alloc(0));
    assert.deepEqual(readFileSync(policyInput), bytes);
  }
});

test("raw policy reads observe an atomically replaced input on each call", () => {
  for (let version = 1; version <= 3; version++) {
    const bytes = Buffer.from(`{\"metadata\":{\"uid\":\"policy-${version}\",\"resourceVersion\":\"rv-${version}\"}}\n`);
    policyFixture(bytes, true);
    const result = equivalentPolicy();
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, bytes);
    assert.deepEqual(readFileSync(policyInput), bytes);
  }
});

test("missing raw policy input retains byte-exact cat diagnostics and failure status", () => {
  const result = equivalentPolicy({ RECOVERY_OPERATION_FENCE_POLICY_FIXTURE: join(directory, "absent-policy.json") });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.stdout, Buffer.alloc(0));
  assert.ok(result.stderr.length > 0);
});

test("raw policy logging, input provenance and state remain identical to frozen baseline", () => {
  policyFixture();
  const results = {};
  for (const script of ["baseline", "candidate"]) {
    const state = mkdtempSync(join(directory, `policy-${script}-state-`));
    writeFileSync(join(state, "sentinel"), "unchanged", { mode: 0o600 });
    const log = join(directory, `policy-${script}-calls.log`);
    const binding = join(directory, `policy-${script}-binding.log`);
    writeFileSync(log, "", { mode: 0o600 });
    writeFileSync(binding, "", { mode: 0o600 });
    const overrides = { STUB_STATE_DIR: state, KUBECTL_LOG: log, STUB_LOCAL_INPUT_BINDING_LOG: binding,
      HCCE_MANIFEST_PATH: "fixture-manifest", PROCESS_LOCAL_CUTOVER_KEY_PATH: "fixture-key-path" };
    const success = runPolicy(script, overrides);
    const failure = runPolicy(script, { ...overrides, RECOVERY_OPERATION_FENCE_POLICY_FIXTURE: join(directory, "absent-policy.json") });
    results[script] = { success, failure, log: readFileSync(log), binding: readFileSync(binding),
      files: readdirSync(state).sort(), sentinel: readFileSync(join(state, "sentinel")) };
  }
  assert.deepEqual(results.candidate, results.baseline);
  assert.equal(results.candidate.success.status, 0);
  assert.notEqual(results.candidate.failure.status, 0);
  assert.deepEqual(results.candidate.files, ["sentinel"], "raw read creates no counters, markers or cached state");
  assert.equal(results.candidate.sentinel.toString(), "unchanged");
  assert.equal(results.candidate.log.toString(), `${policyArguments.join(" ")}\n`.repeat(2));
  assert.equal(results.candidate.binding.toString(), "fixture-manifest\tfixture-key-path\n".repeat(2));
});

test("every nonempty policy fault mode retains full fixture dispatch", () => {
  policyFixture();
  for (const mode of ["checkpoint-writer-fence-policy-missing", "checkpoint-writer-fence-policy-timeout",
    "checkpoint-active-fence-read-failure", "checkpoint-writer-fence-policy-drift-second-boundary-read",
    "unknown-fixture-mode", "0", "false", " "]) {
    const result = runPolicy("tripwire", { STUB_MODE: mode });
    assert.equal(result.status, 97);
    assert.deepEqual(result.stdout, Buffer.alloc(0));
    assert.equal(result.stderr.toString(), "FULL_FIXTURE_BODY_EVALUATED\n");
    assert.equal(equivalentPolicy({ STUB_MODE: mode }).status, 0);
  }
});

test("named policy reads, LIST/WATCH, bindings, Leases and extra arguments retain full dispatch", () => {
  for (const args of [
    ["get", "validatingadmissionpolicy", policyName, "-o", "json"],
    ["get", "--raw", policyCollection],
    ["get", "--raw", `${policyCollection}?fieldSelector=metadata.name%3D${policyName}`],
    ["get", "--raw", `${policyCollection}?fieldSelector=metadata.name%3D${policyName}&resourceVersion=rv-1&watch=true&timeoutSeconds=2`],
    ["get", "--raw", `${policyPath}?watch=true&timeoutSeconds=2`],
    ["get", "--raw", `/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/${policyName}`],
    ["get", "--raw", "/apis/coordination.k8s.io/v1/namespaces/hcce/leases/yenhubs-operation-serialization"],
    ["get", "--raw", policyPath, "--extra"],
    ["get", "--raw", policyPath, ""],
    ["get --raw", policyPath],
    ["get", `--raw ${policyPath}`]
  ]) {
    const result = runPolicy("tripwire", {}, ["--context", "fixture-context", "--request-timeout=45s", ...args]);
    assert.equal(result.status, 97, JSON.stringify(args));
    assert.equal(result.stderr.toString(), "FULL_FIXTURE_BODY_EVALUATED\n");
  }
});

test("named policy counters and second-boundary drift retain frozen baseline behavior", () => {
  policyFixture();
  const mode = "checkpoint-writer-fence-policy-drift-second-boundary-read";
  const args = ["--context", "fixture-context", "--request-timeout=45s", "get", "validatingadmissionpolicy", policyName, "-o", "json"];
  const results = {};
  for (const script of ["baseline", "candidate"]) {
    const state = mkdtempSync(join(directory, `policy-${script}-named-state-`));
    const responses = [runPolicy(script, { STUB_STATE_DIR: state, STUB_MODE: mode }, args),
      runPolicy(script, { STUB_STATE_DIR: state, STUB_MODE: mode }, args)];
    results[script] = { responses, state: readdirSync(state).sort().map(name => [name, readFileSync(join(state, name))]) };
  }
  assert.deepEqual(results.candidate, results.baseline);
  assert.deepEqual(results.candidate.responses.map(result => result.status), [0, 0]);
  assert.deepEqual(results.candidate.responses.map(result => JSON.parse(result.stdout).metadata.resourceVersion),
    ["recovery-operation-fence-policy-rv-1", "recovery-operation-fence-policy-rv-2"]);
  assert.deepEqual(results.candidate.state, [
    [`recovery-operation-fence-policy-count-${mode}`, Buffer.from("2")],
    ["recovery-operation-fence-policy-queried", Buffer.alloc(0)]
  ]);
});

test("policy named LIST and ordinary WATCH preserve frozen baseline response contracts", () => {
  policyFixture();
  for (const path of [
    `${policyCollection}?fieldSelector=metadata.name%3D${policyName}`,
    `${policyCollection}?fieldSelector=metadata.name%3D${policyName}&resourceVersion=recovery-operation-fence-policy-rv-1&watch=true&timeoutSeconds=2`
  ]) {
    const result = equivalentPolicy({}, ["--context", "fixture-context", "--request-timeout=45s", "get", "--raw", path]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length > 0);
  }
});

test("policy fast path retains the original unsupported-timeout parser failure", () => {
  policyFixture();
  const args = ["--context", "fixture-context", "--request-timeout=99s", "get", "--raw", policyPath];
  const result = runPolicy("tripwire", {}, args);
  assert.equal(result.status, 89);
  assert.deepEqual(result.stdout, Buffer.alloc(0));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  assert.deepEqual(equivalentPolicy({}, args), result);
});

if (process.env.YENHUBS_POLICY_READ_BENCHMARK === "1") {
  test("opt-in local paired policy read benchmark preserves every response", () => {
    policyFixture();
    const elapsed = { baseline: [], candidate: [] };
    for (let sample = 0; sample < 30; sample++) {
      const outputs = {};
      for (const script of sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        const started = performance.now();
        outputs[script] = runPolicy(script);
        elapsed[script].push(performance.now() - started);
        assert.equal(outputs[script].status, 0);
      }
      assert.deepEqual(outputs.candidate, outputs.baseline);
    }
    for (const [script, samples] of Object.entries(elapsed)) {
      const sorted = [...samples].sort((a, b) => a - b);
      console.log("RECOVERY_POLICY_READ_BENCHMARK " + JSON.stringify({ script, baseline_revision: baselineRevision,
        samples: samples.length, median_ms: (sorted[14] + sorted[15]) / 2, p95_ms: sorted[28],
        total_ms: samples.reduce((sum, value) => sum + value, 0) }));
    }
  });
}

if (process.env.YENHUBS_NAMESPACE_READ_BENCHMARK === "1") {
  test("opt-in local paired read benchmark preserves every response", () => {
    fixture();
    const elapsed = { full: [], candidate: [] };
    for (let sample = 0; sample < 30; sample++) {
      const outputs = {};
      for (const script of sample % 2 === 0 ? ["full", "candidate"] : ["candidate", "full"]) {
        const started = performance.now();
        outputs[script] = run(script);
        elapsed[script].push(performance.now() - started);
        assert.equal(outputs[script].status, 0);
      }
      assert.deepEqual(outputs.candidate, outputs.full);
    }
    for (const [script, samples] of Object.entries(elapsed)) {
      const sorted = [...samples].sort((a, b) => a - b);
      console.log("NAMESPACE_READ_BENCHMARK " + JSON.stringify({ script, samples: samples.length,
        median_ms: (sorted[14] + sorted[15]) / 2, p95_ms: sorted[28],
        total_ms: samples.reduce((sum, value) => sum + value, 0) }));
    }
  });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const suite = readFileSync(join(root, "tests/recovery/test-recovery-safety.sh"), "utf8");
const stub = suite.split('cat >"$TMP_DIR/bin/kubectl" <<\'STUB\'\n')[1]?.split("\nSTUB\n")[0];
assert.ok(stub, "actual generated kubectl fixture found");
const parserEnd = stub.indexOf('joined="$*"\n') + 'joined="$*"\n'.length;
const bodyStart = stub.indexOf("LEASE_FIXTURE_LOCK_DIR=");
assert.ok(parserEnd > 0 && bodyStart >= parserEnd, "existing parser and full dispatch boundaries");
const fullDispatch = stub.slice(0, parserEnd) + stub.slice(bodyStart);
const tripwire = stub.slice(0, bodyStart) + 'printf "FULL_FIXTURE_BODY_EVALUATED\\n" >&2\nexit 97\n' + stub.slice(bodyStart);

const directory = mkdtempSync(join(tmpdir(), "yenhubs-namespace-fast-"));
chmodSync(directory, 0o700);
test.after(() => rmSync(directory, { recursive: true, force: true }));
const scripts = {};
for (const [name, contents] of Object.entries({ candidate: stub, full: fullDispatch, tripwire })) {
  scripts[name] = join(directory, `${name}.sh`);
  writeFileSync(scripts[name], contents, { mode: 0o700 });
}

function fixture(value = { apiVersion: "v1", kind: "Namespace", metadata: { name: "hcce", uid: "fixture-uid", resourceVersion: "rv-1" } }, namespace = "hcce") {
  const path = join(directory, `namespace-${namespace}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
}

function run(script = "candidate", namespace = "hcce", overrides = {}, args) {
  const env = { ...process.env, KUBECTL_LOG: "/dev/null", STUB_LOCAL_INPUT_BINDING_LOG: "", STUB_STATE_DIR: directory,
    RUNNER_EVIDENCE_LIVE_DIR: directory, STUB_MODE: "", STUB_MONITOR_WATCH_PACE: "0", ...overrides };
  delete env.BASH_ENV;
  delete env.ENV;
  const result = spawnSync(scripts[script], args ?? ["--context", "fixture-context", "--request-timeout=45s", "get", "--raw", `/api/v1/namespaces/${namespace}`], {
    env, encoding: "utf8"
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

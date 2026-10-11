import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateMonthlyNativeManifest } from "../../deployment/monthly-native-bundle.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function replaceOnce(text, anchor, replacement) {
  assert.equal(text.split(anchor).length, 2, "fixture reuse anchor must be unique");
  return text.replace(anchor, replacement);
}

async function coordinatorFixture(mode) {
  const evidence = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-coordinator-fixture-")));
  let harness = await readFile(join(root, "tests/recovery/test-recovery-safety.sh"), "utf8");
  // Reuse the established durable fixture with syntactically real UUIDs. Only
  // its local test copy changes: production scripts and identity guards do not.
  for (const [old, value] of [["fixture-uid", id(1)], ["fixture-pvc-uid", id(6)],
    ["target-pgsql-pvc-uid", id(2)], ["pgsql-pod-uid", id(5)]]) harness = harness.replaceAll(old, value);
  harness = replaceOnce(harness,
    'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"',
    `ROOT_DIR=${JSON.stringify(root)}`);
  // Source/runtime methods may only resolve the two closed fixture programs.
  harness = replaceOnce(harness, 'export PATH="$TMP_DIR/bin:$PATH"', String.raw`
node - "$TMP_DIR/bin" "$MONTHLY_FIXTURE_ADAPTER" "$MONTHLY_FIXTURE_DISPATCH" <<'MONTHLY_ADAPTER'
require(process.argv[4]).installMonthlyProviderFixture(process.argv[2], process.argv[3]);
MONTHLY_ADAPTER
export PATH="$TMP_DIR/bin:$PATH"`);
  // Stop at the original focus dispatch: setup, real control-plane fixture,
  // pause/fence/monitors/joins/resume are unchanged. No other suites are run.
  harness = replaceOnce(harness,
    'if [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-durable ]]; then', String.raw`
if [[ "\${YENHUBS_RECOVERY_TEST_FOCUS:-}" == monthly-native ]]; then
  [[ "$FAIL_COUNT" -eq 0 ]] || { printf 'Native fixture setup failed; no capture attempted.\n' >&2; exit 1; }
  reset_stub
  seed_recovery_operation_fence_binding_state dormant
  mkdir "$TMP_DIR/monthly-journals"
  # Live SQL contract queries return a null dump hash. The shared harness also
  # uses a bound SQL-file contract for offline tests; do not reuse that artifact
  # as the live database response or weaken the worker's unbound-contract guard.
  jq '.sql_dump_sha256 = null' "$DATABASE_CONTRACT" >"$TMP_DIR/monthly-live-contract.json"
  chmod 600 "$TMP_DIR/monthly-live-contract.json"
  # Default legacy WATCH fixtures emit one bookmark and exit0 immediately.
  # Terminal overlap must instead be live through the owned SIGTERM join.
  # Reuse the original strict live fixture; never accept code0 as that signal.
  native_status=0
  if env ALLOW_CHECKPOINT_DOWNTIME=1 EXPECTED_KUBE_CONTEXT=fixture-context \
    EXPECTED_NAMESPACE_UID=MONTHLY_NAMESPACE_UID EXPECTED_RET_PVC_UID=MONTHLY_MEDIA_UID \
    VALUES_FILE="$VALUES_FIXTURE" STUB_DEPLOYMENTS_JSON="$KUBERNETES_DEPLOYMENTS_JSON" \
    STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable \
    STUB_MODE=checkpoint-writer-terminal-live \
    YENHUBS_WATCH_TEST_REQUIRE_LIVE_TERMINAL=1 \
    STUB_MONITOR_WATCH_PACE=1 RECOVERY_STREAM_POLL_SECONDS=1 \
    STUB_DB_CONTRACT="$TMP_DIR/monthly-live-contract.json" \
    CHECKPOINT_BACKEND=native-monthly CHECKPOINT_FORMAT=native-monthly-v1 \
    MONTHLY_INSTANCE_ID=fixture MONTHLY_REGION=ams3 \
    MONTHLY_JOURNAL_ROOT="$TMP_DIR/monthly-journals" \
    "$ROOT_DIR/deployment/create-monthly-snapshot.sh" "$TMP_DIR/monthly-output" \
    >"$MONTHLY_FIXTURE_EVIDENCE/native-command.log" 2>&1; then
    native_status=0
  else native_status=$?; fi
  node - "$MONTHLY_FIXTURE_EVIDENCE/report.json" "$TMP_DIR" "$native_status" <<'MONTHLY_REPORT'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({ fixture: process.argv[3], nativeStatus: Number(process.argv[4]) }), { mode: 0o600 });
MONTHLY_REPORT
  exit "$native_status"
fi
if [[ "\${YENHUBS_RECOVERY_TEST_FOCUS:-}" == checkpoint-durable ]]; then`
      .replaceAll("\\${", "${").replace("MONTHLY_NAMESPACE_UID", id(1)).replace("MONTHLY_MEDIA_UID", id(6)));
  const script = join(evidence, "harness.sh");
  await writeFile(script, harness, { mode: 0o700 });
  const env = { PATH: dirname(process.execPath) + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: evidence, TMPDIR: evidence, YENHUBS_RECOVERY_TEST_KEEP_TMP: "1",
    YENHUBS_RECOVERY_TEST_NATIVE_MONTHLY: "1",
    YENHUBS_RECOVERY_TEST_FOCUS: "monthly-native", MONTHLY_FIXTURE_CASE: mode,
    MONTHLY_FIXTURE_EVIDENCE: evidence, MONTHLY_FIXTURE_ADAPTER: join(root, "tests/recovery/lib/monthly-provider-fixture.cjs"),
    MONTHLY_FIXTURE_DISPATCH: join(root, "tests/recovery/lib/monthly-provider-dispatch.cjs") };
  const began = performance.now();
  let result;
  try { result = { ...(await run("bash", [script], { cwd: root, env, timeout: 1200000, maxBuffer: 4 * 1024 * 1024 })), code: 0 }; }
  catch (error) { result = error; }
  await writeFile(join(evidence, "harness-output.log"), String(result.stdout ?? "") + String(result.stderr ?? ""), { mode: 0o600 });
  const report = JSON.parse(await readFile(join(evidence, "report.json"), "utf8"));
  assert.ok(!String(result.stdout ?? "").includes("not ok "), `fixture setup had failures; evidence ${evidence}/harness-output.log`);
  assert.equal(result.code, report.nativeStatus, `original native status mismatch; evidence ${evidence}`);
  assert.equal(report.nativeStatus, mode === "stable" ? 0 : 1, `unexpected coordinator status; evidence ${evidence}/native-command.log`);
  const state = join(report.fixture, "stub-state");
  const calls = (await readFile(join(state, "monthly-provider-calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const journalNames = await readdir(join(report.fixture, "monthly-journals"));
  assert.equal(journalNames.length, 1, `one attempt only; evidence ${evidence}`);
  const events = (await readFile(join(report.fixture, "monthly-journals", journalNames[0], "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  for (const writer of ["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"]) {
    assert.equal(await readFile(join(state, "replicas-" + writer), "utf8"), "1", `writer not resumed: ${writer}; ${evidence}`);
  }
  assert.equal(await stat(join(state, "restore-lock.yaml")).then(() => true, e => e.code !== "ENOENT"), false);
  const lease = JSON.parse(await readFile(join(state, "serialization-lease.json"), "utf8"));
  assert.equal(lease.spec.holderIdentity ?? "", "", `Lease not released; ${evidence}`);
  assert.equal(await readFile(join(state, "recovery-operation-fence-binding-state"), "utf8"), "dormant");
  assert.equal(calls.filter(v => v.event === "sync").length, 1);
  assert.deepEqual(calls.filter(v => v.event === "snapshot-post").map(v => v.role), ["database", "media"]);
  return { evidence, report, calls, events, milliseconds: Math.round(performance.now() - began) };
}

let stableFixtureAccepted = false;
test("native monthly coordinator publishes fourteen bound artifacts after protected joins and resumes all writers", async t => {
  const f = await coordinatorFixture("stable");
  assert.equal(f.report.nativeStatus, 0, `native coordinator failed; evidence ${f.evidence}`);
  const output = join(f.report.fixture, "monthly-output");
  const names = await readdir(output);
  assert.equal(names.length, 15); // fourteen artifacts and the hash manifest
  assert.ok(!names.includes(".yenhubs-incomplete"));
  const metadata = JSON.parse(await readFile(join(output, "checkpoint-metadata.json"), "utf8"));
  const validation = await validateMonthlyNativeManifest(output, metadata.stamp);
  assert.equal(validation.artifacts, 14);
  assert.equal(validation.state, "capture-only-not-restore-accepted");
  assert.equal(f.events.at(-1).event, "pair-captured");
  stableFixtureAccepted = true;
  t.diagnostic(JSON.stringify({ state: "SIMULATED_COORDINATOR_PASS", nativeExit: 0,
    milliseconds: f.milliseconds, evidence: f.evidence, actualCaptureAccepted: false }));
});

test("a failed media snapshot is not published or retried and the native coordinator resumes all writers", async t => {
  if (!stableFixtureAccepted) { t.skip("positive fixture failed; diagnose before another coordinator attempt"); return; }
  const f = await coordinatorFixture("fail-media");
  assert.equal(f.report.nativeStatus, 1, `expected original failure; evidence ${f.evidence}`);
  const output = join(f.report.fixture, "monthly-output");
  const names = await readdir(output).catch(e => e.code === "ENOENT" ? [] : Promise.reject(e));
  assert.ok(!names.includes("SHA256SUMS"), `partial accepted; evidence ${f.evidence}`);
  assert.equal(f.events.at(-1).event, "incomplete");
  assert.equal(f.events.at(-1).observedSnapshots.database.id, "101");
  assert.ok(!f.events.some(v => v.event === "pair-captured"));
  t.diagnostic(JSON.stringify({ state: "SIMULATED_FAILURE_RECOVERED", nativeExit: 1,
    milliseconds: f.milliseconds, evidence: f.evidence, actualCaptureAccepted: false }));
});

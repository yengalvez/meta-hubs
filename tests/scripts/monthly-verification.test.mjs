import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { inspectMonthlyCandidate, monthlyVerificationScope, monthlyVerificationInputs,
  monthlyVerificationArguments, runMonthlyNativeCheck, validateMonthlyCheckReceipt,
  readMonthlyVerification, runMonthlyVerification } from "../../deployment/monthly-verification.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const fixtureAttemptSha256 = digest("ONLY FIXTURE: immutable attempt");
const code = { root: "a".repeat(40), hubs: "b".repeat(40), cloud: "c".repeat(40) };
const makeCandidate = () => ({ schema: "yenhubs-monthly-candidate-v1", clean: true, code: { ...code },
  inputs: Object.fromEntries(monthlyVerificationInputs.map(path => [path, digest("ONLY FIXTURE: " + path)])) });
const retired = () => ({ schema: "yenhubs-monthly-test-process-retirement-v1", coverage: "observed-lineage",
  absenceVerified: true, observationUnproven: false, registered: 1, termSent: 0, killSent: 0, remaining: [] });
const nativePass = check => ({ nativeExitCode: 0, signal: null, nativeCloseObserved: true,
  processRetirement: retired(), timedOut: false, interrupted: false,
  outputLimitExceeded: false, launchFailed: false, durationMilliseconds: 1, stderr: "",
  stdout: "TAP version 13\n" + (check.requiredDiagnostics ?? []).map(value =>
    "# " + JSON.stringify({ ...value, actualCaptureAccepted: false }) + "\n").join("") +
    `# tests ${check.expectedTests ?? 3}\n# pass ${check.expectedTests ?? 3}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n` });
const makeReceipt = check => ({ schema: "yenhubs-monthly-check-v1", id: check.id,
  attemptSha256: fixtureAttemptSha256, arguments: monthlyVerificationArguments(check), result: nativePass(check) });
async function fixture() {
  const evidenceDirectory = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-verification-fixture-")));
  const candidate = makeCandidate(), calls = [], controls = {};
  let inspected = 0;
  const inspect = async () => {
    inspected++;
    if (controls.dirty) throw Error("monthly_verification_source_dirty");
    const value = structuredClone(candidate);
    if (controls.changed && inspected > 1) value.inputs[monthlyVerificationInputs[0]] = "0".repeat(64);
    return value;
  };
  const run = async check => { calls.push(check.id); return { ...nativePass(check), ...controls.result }; };
  return { evidenceDirectory, candidate, calls, controls,
    run: () => runMonthlyVerification({ evidenceDirectory, inspect, run }) };
}

test("the closed monthly selection contains native integration and no general/H5 command", () => {
  assert.deepEqual(monthlyVerificationScope.checks.map(check => check.id),
    ["monthly-components", "monthly-provider-dispatch", "monthly-native-coordinator"]);
  const tests = monthlyVerificationScope.checks.flatMap(check => check.tests);
  assert.ok(tests.includes("tests/scripts/monthly-snapshot-entrypoint.test.mjs"));
  assert.ok(tests.includes("tests/scripts/monthly-native-routing.test.mjs"));
  assert.ok(tests.includes("tests/recovery/monthly-native-coordinator.test.mjs"));
  assert.equal(new Set(tests).size, tests.length);
  assert.ok(monthlyVerificationInputs.includes("deployment/lib/recovery-safety.sh"));
  assert.ok(monthlyVerificationInputs.includes("deployment/backup-retdb.sh"));
  assert.ok(monthlyVerificationInputs.includes("tests/recovery/test-recovery-safety.sh"));
  for (const check of monthlyVerificationScope.checks) {
    assert.doesNotMatch(monthlyVerificationArguments(check).join(" "), /verify-project|test-recovery-safety|h5-|--full/);
  }
});

test("proof joins exact native receipts and readback, with no self-referential receipt hash", async () => {
  const f = await fixture(), reference = await f.run();
  assert.equal((await readMonthlyVerification(reference, f.candidate)).state, "verified-not-restore-accepted");
  const bytes = await readFile(reference.evidencePath), proof = JSON.parse(bytes);
  assert.equal(reference.evidenceSha256, digest(bytes));
  assert.equal(proof.evidenceSha256, undefined);
  assert.equal(proof.checks.length, 3);
  const attemptBytes = await readFile(join(f.evidenceDirectory, "attempt.json")), attempt = JSON.parse(attemptBytes);
  assert.equal(proof.attemptSha256, digest(attemptBytes));
  assert.deepEqual(attempt.candidate, proof.candidate); assert.deepEqual(attempt.runtime, proof.runtime);
  assert.equal(attempt.scopeSha256, proof.scopeSha256); assert.equal(attempt.scope, proof.scope);
  for (const check of proof.checks) {
    const receipt = JSON.parse(await readFile(join(f.evidenceDirectory, check.id + ".json")));
    assert.equal(receipt.attemptSha256, proof.attemptSha256);
  }
  assert.deepEqual(f.calls, monthlyVerificationScope.checks.map(check => check.id));
  await assert.rejects(f.run(), /monthly_verification_attempt_exists/);
  assert.equal(f.calls.length, 3);
});

for (const result of [{ nativeExitCode: 1 }, { nativeExitCode: null, signal: "SIGTERM" }, { nativeCloseObserved: false }, { timedOut: true },
  { interrupted: true }, { outputLimitExceeded: true }, { launchFailed: true }, { signal: "SIGKILL" }]) {
  test("native rejection cannot publish or retry a proof: " + JSON.stringify(result), async () => {
    const f = await fixture(); f.controls.result = result;
    await assert.rejects(f.run(), /monthly_verification_native_check_failed/);
    assert.deepEqual(f.calls, ["monthly-components"]);
    assert.ok(!(await readdir(f.evidenceDirectory)).includes("monthly-verification.json"));
    const receipt = JSON.parse(await readFile(join(f.evidenceDirectory, "monthly-components.json")));
    for (const key of Object.keys(result)) assert.equal(receipt.result[key], result[key]);
    await assert.rejects(f.run(), /monthly_verification_attempt_exists/);
    assert.equal(f.calls.length, 1);
  });
}

test("dirty or changed candidate inputs never produce admission proof", async () => {
  const dirty = await fixture(); dirty.controls.dirty = true;
  await assert.rejects(dirty.run(), /monthly_verification_source_dirty/);
  assert.deepEqual(dirty.calls, []); assert.deepEqual(await readdir(dirty.evidenceDirectory), []);
  const changed = await fixture(); changed.controls.changed = true;
  await assert.rejects(changed.run(), /monthly_verification_candidate_changed/);
  assert.ok(!(await readdir(changed.evidenceDirectory)).includes("monthly-verification.json"));
});

test("missing, tampered or stale proof and native receipts are rejected", async () => {
  const f = await fixture(), reference = await f.run();
  await assert.rejects(readMonthlyVerification({ ...reference, evidencePath: join(f.evidenceDirectory, "missing.json") }, f.candidate), { code: "ENOENT" });
  await assert.rejects(readMonthlyVerification({ ...reference, evidenceSha256: "0".repeat(64) }, f.candidate), /evidence_changed/);
  const stale = structuredClone(f.candidate); stale.code.cloud = "d".repeat(40);
  await assert.rejects(readMonthlyVerification(reference, stale), /proof_stale_or_invalid/);
  const changed = structuredClone(f.candidate); changed.inputs[monthlyVerificationInputs[0]] = "0".repeat(64);
  await assert.rejects(readMonthlyVerification(reference, changed), /proof_stale_or_invalid/);
  const first = join(f.evidenceDirectory, "monthly-components.json"), original = await readFile(first);
  await writeFile(first, "{}\n", { mode: 0o600 });
  await assert.rejects(readMonthlyVerification(reference, f.candidate), /check_changed/);
  await writeFile(first, original, { mode: 0o600 });
  await rename(first, first + ".saved");
  await assert.rejects(readMonthlyVerification(reference, f.candidate), { code: "ENOENT" });
});

test("rehashing a failed or incomplete native result cannot make it accepted", async () => {
  const f = await fixture(), reference = await f.run(), proof = JSON.parse(await readFile(reference.evidencePath));
  const path = join(f.evidenceDirectory, "monthly-components.json"), receipt = JSON.parse(await readFile(path));
  receipt.result.nativeExitCode = 9;
  const bytes = Buffer.from(JSON.stringify(receipt)); await writeFile(path, bytes);
  proof.checks[0].evidenceSha256 = digest(bytes);
  const proofBytes = Buffer.from(JSON.stringify(proof)); await writeFile(reference.evidencePath, proofBytes);
  await assert.rejects(readMonthlyVerification({ ...reference, evidenceSha256: digest(proofBytes) }, f.candidate), /native_check_failed/);
});

test("receipts from another candidate cannot be spliced by rehashing only the top-level proof", async () => {
  const a = await fixture(), b = await fixture();
  b.candidate.code.root = "d".repeat(40);
  b.candidate.inputs[monthlyVerificationInputs[0]] = digest("ONLY FIXTURE: another candidate");
  const referenceA = await a.run(); await b.run();
  const proof = JSON.parse(await readFile(referenceA.evidencePath));
  const foreignBytes = await readFile(join(b.evidenceDirectory, "monthly-components.json"));
  await writeFile(join(a.evidenceDirectory, "monthly-components.json"), foreignBytes);
  proof.checks[0].evidenceSha256 = digest(foreignBytes);
  const bytes = Buffer.from(JSON.stringify(proof)); await writeFile(referenceA.evidencePath, bytes);
  await assert.rejects(readMonthlyVerification({ ...referenceA, evidenceSha256: digest(bytes) }, a.candidate),
    /monthly_verification_check_attempt_mismatch/);
});

test("reassigning the top-level candidate and hash cannot reassign its original attempt", async () => {
  const f = await fixture(), reference = await f.run(), proof = JSON.parse(await readFile(reference.evidencePath));
  const reassigned = structuredClone(f.candidate); reassigned.code.cloud = "d".repeat(40);
  proof.candidate = reassigned;
  const bytes = Buffer.from(JSON.stringify(proof)); await writeFile(reference.evidencePath, bytes);
  await assert.rejects(readMonthlyVerification({ ...reference, evidenceSha256: digest(bytes) }, reassigned),
    /monthly_verification_attempt_stale_or_invalid/);
});

test("a missing or altered attempt is rejected independently of the native receipts", async () => {
  for (const change of ["missing", "altered"]) {
    const f = await fixture(), reference = await f.run(), path = join(f.evidenceDirectory, "attempt.json");
    if (change === "missing") await rename(path, path + ".saved");
    else await writeFile(path, "{}\n");
    await assert.rejects(readMonthlyVerification(reference, f.candidate),
      change === "missing" ? { code: "ENOENT" } : /monthly_verification_attempt_changed/);
  }
});

test("rehashing an altered attempt cannot borrow receipts or change its validated runtime/scope", async () => {
  for (const change of ["candidate", "runtime", "scope"]) {
    const f = await fixture(), reference = await f.run(), proof = JSON.parse(await readFile(reference.evidencePath));
    const path = join(f.evidenceDirectory, "attempt.json"), attempt = JSON.parse(await readFile(path));
    let candidate = f.candidate;
    if (change === "candidate") {
      candidate = structuredClone(f.candidate); candidate.code.hubs = "e".repeat(40);
      attempt.candidate = candidate; proof.candidate = candidate;
    } else if (change === "runtime") attempt.runtime.node = "v0.0.0";
    else attempt.scope = "unrelated";
    const attemptBytes = Buffer.from(JSON.stringify(attempt)); await writeFile(path, attemptBytes);
    proof.attemptSha256 = digest(attemptBytes);
    const bytes = Buffer.from(JSON.stringify(proof)); await writeFile(reference.evidencePath, bytes);
    await assert.rejects(readMonthlyVerification({ ...reference, evidenceSha256: digest(bytes) }, candidate),
      change === "candidate" ? /monthly_verification_check_attempt_mismatch/ : /monthly_verification_attempt_stale_or_invalid/);
  }
});

test("a check requires an explicit matching immutable-attempt hash", () => {
  const check = monthlyVerificationScope.checks[0], receipt = makeReceipt(check);
  assert.throws(() => validateMonthlyCheckReceipt(receipt, check), /check_attempt_mismatch/);
  assert.throws(() => validateMonthlyCheckReceipt(receipt, check, "f".repeat(64)), /check_attempt_mismatch/);
  delete receipt.attemptSha256;
  assert.throws(() => validateMonthlyCheckReceipt(receipt, check, fixtureAttemptSha256), /check_attempt_mismatch/);
});

test("native zero cannot hide a skipped suite, filtered command or missing coordinator case", () => {
  const check = monthlyVerificationScope.checks[0];
  for (const counter of ["fail", "cancelled", "skipped", "todo"]) {
    const receipt = makeReceipt(check); receipt.result.stdout = receipt.result.stdout.replace(`# ${counter} 0`, `# ${counter} 1`);
    assert.throws(() => validateMonthlyCheckReceipt(receipt, check, fixtureAttemptSha256), /tap_unproven/);
  }
  const filtered = makeReceipt(check); filtered.arguments.push("--test-name-pattern=irrelevant");
  assert.throws(() => validateMonthlyCheckReceipt(filtered, check, fixtureAttemptSha256), /native_check_failed/);
  const coordinator = monthlyVerificationScope.checks.at(-1), receipt = makeReceipt(coordinator);
  receipt.result.stdout = receipt.result.stdout.replace(/^# \{.+SIMULATED_FAILURE_RECOVERED.+\}\n/m, "");
  assert.throws(() => validateMonthlyCheckReceipt(receipt, coordinator, fixtureAttemptSha256), /coordinator_unproven/);
});

test("native launcher waits for close, preserves late output and scrubs ambient selectors", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const check = monthlyVerificationScope.checks[0]; let finished = false;
  const pending = runMonthlyNativeCheck(check, { evidenceDirectory: "/fixture",
    own: () => ({ ready: Promise.resolve(), retire: async () => retired(), close() {} }), launch(program, args, options) {
    assert.equal(program, process.execPath); assert.deepEqual(args, monthlyVerificationArguments(check));
    assert.equal(options.detached, true);
    assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH", "TMPDIR", "TZ"]);
    return child;
  } }).then(result => { finished = true; return result; });
  child.stdout.write("before-exit\n"); child.emit("exit", 0, null);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  child.stdout.write("after-exit\n"); child.emit("close", 0, null);
  const result = await pending;
  assert.equal(result.nativeExitCode, 0); assert.equal(result.signal, null);
  assert.equal(result.stdout, "before-exit\nafter-exit\n");
});

test("a timed-out native child cannot become accepted even if it closes zero", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const result = await runMonthlyNativeCheck({ ...monthlyVerificationScope.checks[0], timeoutMilliseconds: 5 },
    { evidenceDirectory: "/fixture", launch: () => child, own: () => ({ ready: Promise.resolve(),
      async retire() { child.emit("close", 0, null); return retired(); }, close() {} }) });
  assert.equal(result.nativeExitCode, 0); assert.equal(result.timedOut, true);
});

test("parent close cannot cancel retirement or publish before detached descendants are checked", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let completeCleanup, resolved = false;
  const cleanup = new Promise(resolve => { completeCleanup = resolve; });
  const pending = runMonthlyNativeCheck(monthlyVerificationScope.checks[0], { evidenceDirectory: "/fixture",
    launch: () => child, own: () => ({ ready: Promise.resolve(), retire: () => cleanup, close() {} })
  }).then(result => { resolved = true; return result; });
  child.emit("close", 0, null);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  completeCleanup({ ...retired(), absenceVerified: false, observationUnproven: true });
  const result = await pending;
  assert.equal(result.nativeCloseObserved, true);
  const receipt = makeReceipt(monthlyVerificationScope.checks[0]);
  receipt.result = { ...receipt.result, processRetirement: result.processRetirement };
  assert.throws(() => validateMonthlyCheckReceipt(receipt, monthlyVerificationScope.checks[0], receipt.attemptSha256),
    /process_retirement_unproven/);
});

test("failed retirement without native close remains unknown, never exit zero", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const result = await runMonthlyNativeCheck({ ...monthlyVerificationScope.checks[0], timeoutMilliseconds: 5 }, {
    evidenceDirectory: "/fixture", launch: () => child, own: () => ({ ready: Promise.resolve(),
      retire: async () => ({ ...retired(), absenceVerified: false }), close() {} }) });
  assert.equal(result.nativeExitCode, null); assert.equal(result.nativeCloseObserved, false);
  assert.equal(result.timedOut, true); assert.equal(result.processRetirement.absenceVerified, false);
});

test("candidate inspection binds initialized clean subrepos, root gitlinks and actual HEAD blobs", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-candidate-fixture-")));
  const controls = {};
  const content = path => Buffer.from("ONLY FIXTURE: " + path);
  const git = async (repository, args) => {
    const suffix = relative(directory, repository), name = suffix === "hubs-cloud" ? "cloud" : suffix || "root";
    if (args[0] === "rev-parse") return (args[1] === "HEAD" ? code[name] : repository) + "\n";
    if (args[0] === "status") return controls.dirty === name ? " M a-file\n" : "";
    if (args[1] === "-r") return args.slice(args.indexOf("--") + 1).map(path => {
      const bytes = content(suffix ? suffix + "/" + path : path);
      return `100644 blob ${createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")}\t${path}\0`;
    }).join("");
    const path = args.at(-1), pin = path === "hubs" ? code.hubs : code.cloud;
    return `160000 commit ${controls.pin ? "f".repeat(40) : pin}\t${path}\n`;
  };
  const read = async path => ({ bytes: content(relative(directory, path) + (controls.content ? "changed" : "")), executable: false });
  const candidate = await inspectMonthlyCandidate(directory, { git, read });
  assert.deepEqual(candidate.code, code); assert.equal(Object.keys(candidate.inputs).length, monthlyVerificationInputs.length);
  for (const name of ["root", "hubs", "cloud"]) {
    controls.dirty = name;
    await assert.rejects(inspectMonthlyCandidate(directory, { git, read }), /source_dirty/);
  }
  controls.dirty = false; controls.pin = true;
  await assert.rejects(inspectMonthlyCandidate(directory, { git, read }), /subrepo_pin_changed/);
  controls.pin = false; controls.content = true;
  await assert.rejects(inspectMonthlyCandidate(directory, { git, read }), /input_not_at_head/);
});

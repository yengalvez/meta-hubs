import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, mkdir, writeFile, readFile, chmod, symlink, open, lstat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { nativeMonthlyArtifacts, minimalMonthlyArtifacts, writeMonthlyRuntimeArchive } from "../../deployment/monthly-native-bundle.mjs";
import { inspectPublishedMonthlyPoint, captureMonthlyForExport, buildSnapshotExportPlan,
  requireClonePVCBinding, exportMonthlySnapshotPoint } from "../../deployment/monthly-snapshot-export.mjs";
import { nativeSnapshotExportProvider, runExportNative } from "../../deployment/monthly-snapshot-export-provider.mjs";
import { openPortablePoint } from "../../deployment/monthly-portable-point.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const image = "docker.io/mozillareality/postgres@sha256:" + "d".repeat(64);
const execute = promisify(execFile);
const captureEnvironment = { CHECKPOINT_BACKEND: "native-monthly", CHECKPOINT_FORMAT: "native-monthly-v1",
  ALLOW_CHECKPOINT_DOWNTIME: "1", MONTHLY_INSTANCE_ID: "fixture-instance", EXPECTED_KUBE_CONTEXT: "fixture",
  EXPECTED_NAMESPACE_UID: id(1), EXPECTED_RET_PVC_UID: id(6) };
const diagnosticPaths = completion => ({ intent: completion + ".intent", stdout: completion + ".capture.stdout",
  stderr: completion + ".capture.stderr", diagnostic: completion + ".capture.json" });
async function readCaptureDiagnostics(completion) {
  const paths = diagnosticPaths(completion);
  for (const path of Object.values(paths)) {
    const stat = await lstat(path);
    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.uid, process.getuid()); assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o777, 0o600);
  }
  const intentBytes = await readFile(paths.intent), intent = JSON.parse(intentBytes);
  const diagnostic = JSON.parse(await readFile(paths.diagnostic));
  assert.equal(diagnostic.schema, "yenhubs-monthly-capture-diagnostic-v1");
  assert.equal(diagnostic.state, "native-result-recorded-not-capture-accepted");
  assert.equal(diagnostic.captureAttemptId, intent.captureAttemptId);
  assert.equal(diagnostic.intentSha256, sha(intentBytes));
  assert.equal(diagnostic.checkpointDirectory, intent.directory);
  assert.equal(diagnostic.completionPath, completion); assert.equal(diagnostic.intentPath, paths.intent);
  assert.deepEqual(intent.diagnosticPaths, paths);
  assert.ok(Number.isFinite(Date.parse(diagnostic.invokedAt)) && Number.isFinite(Date.parse(diagnostic.settledAt)));
  assert.ok(Number.isSafeInteger(diagnostic.durationMilliseconds) && diagnostic.durationMilliseconds >= 0);
  const stdout = await readFile(paths.stdout), stderr = await readFile(paths.stderr);
  for (const [name, bytes] of Object.entries({ stdout, stderr })) {
    assert.equal(diagnostic[name].path, paths[name]); assert.equal(diagnostic[name].storedBytes, bytes.length);
    assert.equal(diagnostic[name].sha256, sha(bytes)); assert.ok(bytes.length <= diagnostic.outputLimitBytes);
  }
  return { intent, diagnostic, stdout, stderr };
}
async function fixture({ minimal = false, billableGiB = 1 } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-export-fixture-")));
  await chmod(parent, 0o700);
  const directory = join(parent, "capture"); await mkdir(directory, { mode: 0o700 });
  const source = { schema: "yenhubs-monthly-source-v1", state: "inventory-not-captured", context: "fixture",
    instanceId: "fixture-instance", region: "ams3", namespace: { name: "fixture", uid: id(1) },
    volumes: { database: { volumeId: id(2), pvcUid: id(3), pvUid: id(4), sizeGiB: 10, mountPath: "/var/lib/postgresql/data" },
      media: { volumeId: id(5), pvcUid: id(6), pvUid: id(7), sizeGiB: 10 } },
    postgres: { major: "12", dataPath: "/var/lib/postgresql/data", walPath: "/var/lib/postgresql/data/pg_wal",
      tablespaceEntries: 0, sameWalFilesystem: true, fsync: "on", fullPageWrites: "on", syncAvailable: true } };
  const contract = { schema_version: 2, sql_dump_sha256: null, fixtureNotProduction: true };
  const pair = { schema: "yenhubs-native-monthly-pair-v1", state: "captured-not-restore-accepted",
    instanceId: source.instanceId, context: source.context, region: source.region, namespace: source.namespace,
    operationId: "a".repeat(32), month: "2026-10", postgres: source.postgres, startedAt: "2026-10-06T12:00:01.500Z",
    capturedAt: "2026-10-06T12:00:03.100Z", durationMilliseconds: 1600, databaseContractSha256: sha(JSON.stringify(contract)),
    acceptance: { parentTerminalJoin: false, writersResumed: false, portableExport: false,
      isolatedDigitalOceanRestore: false, isolatedDriveRestore: false }, snapshots: {} };
  for (const [i, role] of ["database", "media"].entries()) pair.snapshots[role] = {
    id: id(10 + i), name: `fixture-instance-2026-10-${role}`, volumeId: source.volumes[role].volumeId,
    region: "ams3", minimumDiskGiB: 10, billableGiB, createdAt: "2026-10-06T12:00:02Z"
  };
  const metadata = { schema_version: 3, runtime_generation: "durable-v2", operation_id: pair.operationId,
    kube_context: pair.context, namespace: source.namespace.name, namespace_uid: source.namespace.uid,
    ret_pvc_uid: source.volumes.media.pvcUid, stamp: "20261006-120000", writer_quiescence: {
      required: true, started_at_utc: "2026-10-06T12:00:00Z", completed_at_utc: "2026-10-06T12:00:04Z" } };
  const images = { deployments: [{ name: "pgsql", containers: [{ name: "pgsql", image }] }] };
  if (minimal) Object.assign(metadata,{schema_version:5,runtime_generation:"minimal-snapshot-v1",
    recovery:{servicesResumed:true,deferredRecoveryDisarmed:true}});
  const content = { "monthly-source.json": source, "native-pair.json": pair, "database-contract.json": contract,
    "checkpoint-metadata.json": metadata, "deployment-images.json": images };
  const paths = ["values", "manifest", "key"].map(name => join(parent, name));
  for (const path of paths) await writeFile(path, "PUBLIC-FIXTURE-NOT-REAL-CONFIG", { mode: 0o600 });
  await writeMonthlyRuntimeArchive({ output: join(directory, "runtime.tar.gz"), valuesPath: paths[0],
    manifestPath: paths[1], keyPath: paths[2], journalRoot: parent });
  const sums = [];
  for (const name of minimal ? minimalMonthlyArtifacts : nativeMonthlyArtifacts) {
    if (name !== "runtime.tar.gz") await writeFile(join(directory, name), JSON.stringify(content[name] ?? {}), { mode: 0o600 });
    sums.push(`${sha(await readFile(join(directory, name)))}  ${name}`);
  }
  await writeFile(join(directory, "SHA256SUMS"), sums.join("\n") + "\n", { mode: 0o600 });
  const point = await inspectPublishedMonthlyPoint(directory);
  const completionPath = join(parent, "completion.json");
  await writeFile(completionPath, JSON.stringify({ schema: "yenhubs-monthly-capture-completion-v1",
    state: "native-command-complete-not-restore-accepted", directory, nativeExitCode: 0,
    instanceId: pair.instanceId, month: pair.month, operationId: pair.operationId,
    manifestSha256: point.manifestSha256, stdoutSha256: "c".repeat(64) }), { mode: 0o600 });
  const plan = buildSnapshotExportPlan(point);
  return { parent, directory, completionPath, point, plan };
}
const events = () => ({ entries: [], async append(value) { this.entries.push(value); } });

test("published point requires 14 exact hashes and a matching native completion receipt", async () => {
  const f = await fixture();
  assert.equal((await inspectPublishedMonthlyPoint(f.directory, f.completionPath)).manifestSha256, f.point.manifestSha256);
});
for (const marker of [".yenhubs-incomplete", "INCOMPLETE", "retdb.sql.gz", "unexpected.json"]) {
  test(`refuses publication with ${marker}`, async () => {
    const f = await fixture(); await writeFile(join(f.directory, marker), "fixture", { mode: 0o600 });
    await assert.rejects(inspectPublishedMonthlyPoint(f.directory, f.completionPath), /incomplete_or_extra/);
  });
}
test("a missing or nonzero original exit is not inferred from a completed pair", async () => {
  const f = await fixture();
  await assert.rejects(inspectPublishedMonthlyPoint(f.directory, join(f.parent, "absent.json")));
  const receipt = JSON.parse(await readFile(f.completionPath)); receipt.nativeExitCode = 1;
  await writeFile(f.completionPath, JSON.stringify(receipt));
  await assert.rejects(inspectPublishedMonthlyPoint(f.directory, f.completionPath), /original_capture_exit_unproven/);
});
test("a foreign completion receipt and changed evidence fail before clone preparation", async () => {
  const f = await fixture(); const receipt = JSON.parse(await readFile(f.completionPath)); receipt.month = "2026-09";
  await writeFile(f.completionPath, JSON.stringify(receipt));
  await assert.rejects(inspectPublishedMonthlyPoint(f.directory, f.completionPath), /original_capture_exit_unproven/);
  await writeFile(join(f.directory, "database-contract.json"), "altered");
  await assert.rejects(inspectPublishedMonthlyPoint(f.directory, f.completionPath));
});
test("public or linked evidence cannot be accepted", async () => {
  const f = await fixture(); await chmod(f.completionPath, 0o644);
  await assert.rejects(inspectPublishedMonthlyPoint(f.directory, f.completionPath), /not_private/);
  await symlink(f.directory, join(f.parent, "linked"));
  await assert.rejects(inspectPublishedMonthlyPoint(join(f.parent, "linked")), /not_private/);
});
test("native capture helper privately records its ORIGINAL successful invocation only, without repeating it", async t => {
  const f = await fixture(); let calls = 0;
  const environment = captureEnvironment;
  const stdout = `Native monthly pair published: ${f.directory} (writers resumed; export and isolated recovery NOT yet accepted)\n`;
  const stderr = "PRIVATE-FIXTURE-SUCCESS-NOT-A-REAL-SECRET";
  const run = (program, args, options) => {
    calls++; assert.ok(program.endsWith("/deployment/create-monthly-snapshot.sh")); assert.deepEqual(args, [f.directory]);
    assert.equal(options.env, environment);
    assert.equal(options.encoding, "buffer"); assert.equal(options.maxBuffer, 1024 * 1024);
    return execute(process.execPath, ["-e", "process.stdout.write(process.argv[1]);process.stderr.write(process.argv[2])", stdout, stderr],
      { ...options, env: {} });
  };
  const completionPath = join(f.parent, "new-completion.json");
  const args = { checkpointDirectory: f.directory, completionPath, environment, run };
  const receipt = await captureMonthlyForExport(args);
  assert.equal(receipt.nativeExitCode, 0);
  assert.deepEqual(Object.keys(receipt).sort(), ["schema", "state", "directory", "nativeExitCode", "instanceId", "month",
    "operationId", "manifestSha256", "stdoutSha256"].sort());
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE-FIXTURE|recovery_stream/);
  const saved = await readCaptureDiagnostics(completionPath);
  assert.equal(saved.stdout.toString(), stdout); assert.equal(saved.stderr.toString(), stderr);
  assert.equal(saved.diagnostic.executionOutcome, "resolved"); assert.equal(saved.diagnostic.nativeExitCode, 0);
  assert.equal(saved.diagnostic.nativeSignal, null); assert.equal(saved.diagnostic.nativeKilled, false);
  assert.equal(saved.diagnostic.stdout.available, true); assert.equal(saved.diagnostic.stdout.truncated, false);
  assert.equal(saved.diagnostic.stdioLimitExceeded, false);
  await assert.rejects(captureMonthlyForExport(args), { code: "EEXIST" }); assert.equal(calls, 1);
  t.diagnostic("fictional native capture: exit 0; private stdout/stderr retained; public receipt unchanged");
});
test("failed/ambiguous capture preserves private output and only sanitized native-close evidence in errors", async () => {
  const f = await fixture();
  for (const [index, evidence] of [{ code: 23 }, { signal: "SIGTERM", killed: true },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true },
    { code: "DO-NOT-LEAK", signal: "DO-NOT-LEAK" }].entries()) {
    const completionPath = join(f.parent, `failed-completion-${index}.json`); let calls = 0;
    const args = { checkpointDirectory: f.directory, completionPath,
      environment: { CHECKPOINT_BACKEND: "native-monthly", CHECKPOINT_FORMAT: "native-monthly-v1",
        ALLOW_CHECKPOINT_DOWNTIME: "1", MONTHLY_INSTANCE_ID: "fixture-instance" },
      run: async program => {
        calls++; assert.ok(program.endsWith("/deployment/create-monthly-snapshot.sh"));
        throw Object.assign(new Error("DO-NOT-LEAK-PROVIDER-BODY"), evidence, {
          stdout: `Native monthly pair published: ${f.directory} (writers resumed; export and isolated recovery NOT yet accepted)\n`,
          stderr: "DO-NOT-LEAK-SECRET"
        });
      } };
    await assert.rejects(captureMonthlyForExport(args), error => {
      assert.equal(error.message, "export_capture_failed_or_ambiguous");
      assert.equal(error.nativeExitCode, evidence.code === 23 ? 23 : null);
      assert.equal(error.nativeSignal, evidence.signal === "SIGTERM" ? "SIGTERM" : null);
      assert.equal(error.nativeKilled, typeof evidence.killed === "boolean" ? evidence.killed : null);
      assert.equal(error.cause, undefined); assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined);
      assert.doesNotMatch(JSON.stringify(error), /DO-NOT-LEAK/);
      return true;
    });
    const saved = await readCaptureDiagnostics(completionPath);
    assert.equal(saved.diagnostic.executionOutcome, "rejected");
    assert.equal(saved.diagnostic.nativeExitCode, evidence.code === 23 ? 23 : null);
    assert.equal(saved.diagnostic.nativeSignal, evidence.signal === "SIGTERM" ? "SIGTERM" : null);
    assert.equal(saved.diagnostic.nativeKilled, typeof evidence.killed === "boolean" ? evidence.killed : null);
    assert.equal(saved.diagnostic.stdioLimitExceeded, evidence.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    assert.equal(saved.stderr.toString(), "DO-NOT-LEAK-SECRET");
    assert.match(saved.stdout.toString(), /^Native monthly pair published:/);
    assert.doesNotMatch(JSON.stringify(saved.diagnostic), /DO-NOT-LEAK/);
    await assert.rejects(readFile(completionPath), { code: "ENOENT" });
    await assert.rejects(captureMonthlyForExport(args), { code: "EEXIST" });
    assert.equal(calls, 1);
  }
});

test("real local execFile exit 23 and signal preserve original bytes and recovery diagnostics privately", async t => {
  const f = await fixture();
  const stdout = Buffer.from([0, 255, 254, 65, 10]);
  const stderr = Buffer.from("recovery_stream_stage:running\nrecovery_stream_status:1\nrecovery_stream_detail:guard-stale:0\nFICTIONAL-SECRET-NOT-FOR-ERRORS\n");
  const consoleCalls = [];
  t.mock.method(console, "error", (...args) => consoleCalls.push(args));
  t.mock.method(console, "log", (...args) => consoleCalls.push(args));
  for (const [label, ending, code, signal] of [["exit", "process.exit(23)", 23, null],
    ["signal", 'process.kill(process.pid,"SIGTERM")', null, "SIGTERM"]]) {
    const completionPath = join(f.parent, `native-${label}.json`); let original, calls = 0;
    const run = (_program, _args, options) => {
      calls++;
      const command = `const fs=require("node:fs");fs.writeSync(1,Buffer.from(process.argv[1],"base64"));` +
        `fs.writeSync(2,Buffer.from(process.argv[2],"base64"));${ending}`;
      const pending = execute(process.execPath, ["-e", command, stdout.toString("base64"), stderr.toString("base64")], { ...options, env: {} });
      pending.catch(error => { original = error; });
      return pending;
    };
    await assert.rejects(captureMonthlyForExport({ checkpointDirectory: f.directory, completionPath,
      environment: captureEnvironment, run }), error => {
      assert.equal(error.message, "export_capture_failed_or_ambiguous");
      assert.equal(error.nativeExitCode, code); assert.equal(error.nativeSignal, signal); assert.equal(error.nativeKilled, false);
      assert.equal(error.cause, undefined); assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /FICTIONAL-SECRET|recovery_stream/);
      return true;
    });
    assert.equal(original.code, code); assert.equal(original.signal, signal); assert.equal(original.killed, false);
    assert.deepEqual(original.stdout, stdout); assert.deepEqual(original.stderr, stderr);
    const saved = await readCaptureDiagnostics(completionPath);
    assert.deepEqual(saved.stdout, original.stdout); assert.deepEqual(saved.stderr, original.stderr);
    assert.equal(saved.diagnostic.nativeExitCode, original.code); assert.equal(saved.diagnostic.nativeSignal, original.signal);
    assert.equal(saved.diagnostic.nativeKilled, original.killed);
    assert.equal(saved.diagnostic.stdout.observedBytes, stdout.length); assert.equal(saved.diagnostic.stderr.observedBytes, stderr.length);
    await assert.rejects(readFile(completionPath), { code: "ENOENT" }); assert.equal(calls, 1);
    t.diagnostic(JSON.stringify({ fixture: label, nativeExitCode: original.code, nativeSignal: original.signal,
      stdoutBytes: saved.stdout.length, stderrBytes: saved.stderr.length }));
  }
  assert.deepEqual(consoleCalls, []);
});

test("bounded capture logs distinguish a retained prefix from unknown original output", async () => {
  const f = await fixture(), limit = 1024 * 1024;
  for (const [label, output] of [["bounded", { stdout: Buffer.alloc(limit + 19, 65), stderr: Buffer.alloc(limit + 31, 66) }],
    ["unknown", {}]]) {
    const completionPath = join(f.parent, label + ".json");
    await assert.rejects(captureMonthlyForExport({ checkpointDirectory: f.directory, completionPath,
      environment: captureEnvironment, run: async () => { throw Object.assign(new Error("PRIVATE-DETAIL"), output); } }), error => {
      assert.equal(error.nativeExitCode, null); assert.equal(error.nativeSignal, null); assert.equal(error.nativeKilled, null);
      return error.message === "export_capture_failed_or_ambiguous";
    });
    const saved = await readCaptureDiagnostics(completionPath);
    for (const name of ["stdout", "stderr"]) {
      assert.equal(saved.diagnostic[name].available, label === "bounded");
      assert.equal(saved.diagnostic[name].observedBytes, output[name]?.length ?? null);
      assert.equal(saved.diagnostic[name].storedBytes, label === "bounded" ? limit : 0);
      assert.equal(saved.diagnostic[name].truncated, label === "bounded" ? true : null);
      if (label === "bounded") assert.deepEqual(saved[name], output[name].subarray(0, limit));
    }
  }
});

test("any preexisting capture evidence blocks execution without overwriting even the intent", async () => {
  const f = await fixture(); let calls = 0;
  for (const [index, selected] of ["completion", "intent", "stdout", "stderr", "diagnostic"].entries()) {
    const completionPath = join(f.parent, `existing-${index}.json`);
    const paths = { completion: completionPath, ...diagnosticPaths(completionPath) };
    const original = Buffer.from("EXISTING-PRIVATE-FIXTURE-" + selected);
    await writeFile(paths[selected], original, { flag: "wx", mode: 0o600 });
    await assert.rejects(captureMonthlyForExport({ checkpointDirectory: f.directory, completionPath,
      environment: captureEnvironment, run: async () => { calls++; throw Error("MUST-NOT-RUN"); } }), { code: "EEXIST" });
    assert.deepEqual(await readFile(paths[selected]), original);
    for (const [name, path] of Object.entries(paths)) if (name !== selected) await assert.rejects(lstat(path), { code: "ENOENT" });
  }
  assert.equal(calls, 0);
});

test("capture evidence refuses a public or linked parent directory before invoking the command", async () => {
  const f = await fixture(); let calls = 0;
  const publicParent = join(f.parent, "public"); await mkdir(publicParent, { mode: 0o755 }); await chmod(publicParent, 0o755);
  const linkedParent = join(f.parent, "linked"); await symlink(f.parent, linkedParent);
  for (const parent of [publicParent, linkedParent]) {
    await assert.rejects(captureMonthlyForExport({ checkpointDirectory: f.directory, completionPath: join(parent, "completion.json"),
      environment: captureEnvironment, run: async () => { calls++; throw Error("MUST-NOT-RUN"); } }), /export_directory_not_private/);
  }
  assert.equal(calls, 0);
});

test("changed reserved file or directory identity fails closed without writing a replacement", async () => {
  for (const change of ["file", "directory"]) {
    const f = await fixture(); const completionPath = join(f.parent, "identity.json"), paths = diagnosticPaths(completionPath);
    const replacement = Buffer.from("FOREIGN-REPLACEMENT-FIXTURE"); let calls = 0;
    const run = async () => {
      calls++;
      if (change === "file") {
        await rename(paths.stderr, paths.stderr + ".original");
        await writeFile(paths.stderr, replacement, { flag: "wx", mode: 0o600 });
      } else {
        await rename(f.parent, f.parent + ".original"); await mkdir(f.parent, { mode: 0o700 });
        await writeFile(paths.stderr, replacement, { flag: "wx", mode: 0o600 });
      }
      throw Object.assign(new Error("DO-NOT-LEAK"), { code: 23, stdout: "PRIVATE-STDOUT", stderr: "PRIVATE-STDERR" });
    };
    await assert.rejects(captureMonthlyForExport({ checkpointDirectory: f.directory, completionPath,
      environment: captureEnvironment, run }), error => error.message === "export_capture_diagnostic_unavailable" && error.nativeExitCode === 23);
    assert.deepEqual(await readFile(paths.stderr), replacement); assert.equal(calls, 1);
    await assert.rejects(readFile(completionPath), { code: "ENOENT" });
    const originalIntent = change === "file" ? paths.intent : join(f.parent + ".original", "identity.json.intent");
    assert.equal(JSON.parse(await readFile(originalIntent)).schema, "yenhubs-monthly-capture-intent-v1");
  }
});

test("diagnostic write failure retains the claimed attempt, does not leak the disk error and cannot retry", async t => {
  const f = await fixture();
  const handle = await open(join(f.parent, "prototype-fixture"), "wx", 0o600);
  const prototype = Object.getPrototypeOf(handle), originalWrite = prototype.writeFile; await handle.close();
  t.mock.method(prototype, "writeFile", function (bytes, ...args) {
    if (Buffer.isBuffer(bytes) && bytes.toString().startsWith('{"schema":"yenhubs-monthly-capture-diagnostic-v1"')) {
      throw new Error("DO-NOT-LEAK-DISK-DETAIL");
    }
    return originalWrite.call(this, bytes, ...args);
  });
  for (const code of [23, 0]) {
    const completionPath = join(f.parent, `disk-failure-${code}.json`); let calls = 0;
    const stdout = code ? "PRIVATE-OUT" : `Native monthly pair published: ${f.directory} (writers resumed; export and isolated recovery NOT yet accepted)\n`;
    const args = { checkpointDirectory: f.directory, completionPath, environment: captureEnvironment,
      run: async () => {
        calls++;
        if (code) throw Object.assign(new Error("PRIVATE-ERROR"), { code, stdout, stderr: "PRIVATE-ERR" });
        return { stdout, stderr: "PRIVATE-ERR" };
      } };
    await assert.rejects(captureMonthlyForExport(args), error => {
      assert.equal(error.message, "export_capture_diagnostic_unavailable"); assert.equal(error.nativeExitCode, code);
      assert.equal(error.cause, undefined); assert.doesNotMatch(error.stack + JSON.stringify(error), /PRIVATE|DO-NOT-LEAK/); return true;
    });
    assert.equal((await readFile(diagnosticPaths(completionPath).stdout)).toString(), stdout);
    assert.equal((await readFile(diagnosticPaths(completionPath).stderr)).toString(), "PRIVATE-ERR");
    assert.equal((await readFile(diagnosticPaths(completionPath).diagnostic)).length, 0);
    await assert.rejects(readFile(completionPath), { code: "ENOENT" });
    await assert.rejects(captureMonthlyForExport(args), { code: "EEXIST" }); assert.equal(calls, 1);
  }
});
test("legacy, conflicting or missing monthly selectors stop before intent and native execution", async () => {
  const f = await fixture(); let calls = 0;
  const selectors = [
    ...[undefined, "", "legacy", "durable-v2", "freeze-bundle-v1", "freeze-bundle-v2"].map(CHECKPOINT_FORMAT => ({ CHECKPOINT_FORMAT })),
    ...[undefined, "", "legacy", "sql"].map(CHECKPOINT_BACKEND => ({ CHECKPOINT_BACKEND }))
  ];
  for (const [index, selection] of selectors.entries()) {
    const completionPath = join(f.parent, `rejected-format-${index}.json`);
    await assert.rejects(captureMonthlyForExport({ checkpointDirectory: f.directory, completionPath,
      environment: { CHECKPOINT_BACKEND: "native-monthly", CHECKPOINT_FORMAT: "native-monthly-v1",
        ALLOW_CHECKPOINT_DOWNTIME: "1", MONTHLY_INSTANCE_ID: "fixture-instance", ...selection },
      run: async () => { calls++; throw Error("MUST-NOT-RUN"); } }), /export_capture_arguments_invalid/);
    await assert.rejects(readFile(completionPath + ".intent"), { code: "ENOENT" });
    await assert.rejects(readFile(completionPath), { code: "ENOENT" });
  }
  assert.equal(calls, 0);
});
test("generated CSI imports retain original snapshots and never mount live claims", async () => {
  const { plan, point } = await fixture(); assert.equal(plan.objects.length, 9);
  assert.equal(plan.state, "prepared-not-executed"); assert.ok(plan.estimatedTemporaryUSD < 0.01);
  for (const content of plan.objects.filter(o => o.kind === "VolumeSnapshotContent")) {
    assert.equal(content.spec.deletionPolicy, "Retain"); assert.ok(!content.spec.source.volumeHandle);
    assert.ok(Object.values(point.pair.snapshots).some(s => s.id === content.spec.source.snapshotHandle));
  }
  const pod = plan.objects.find(o => o.kind === "Pod");
  assert.equal(pod.spec.automountServiceAccountToken, false); assert.equal(pod.spec.restartPolicy, "Never");
  assert.equal(pod.spec.activeDeadlineSeconds, 3600); assert.ok(!pod.spec.hostPath && !pod.spec.hostNetwork);
  assert.deepEqual(pod.spec.volumes.filter(v => v.persistentVolumeClaim).map(v => v.persistentVolumeClaim.claimName), ["database", "media"]);
  assert.equal(pod.spec.containers[1].volumeMounts.find(v => v.name === "media").readOnly, true);
  assert.ok(pod.spec.containers.every(c => c.image === image));
  const policy = plan.objects.find(o => o.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.egress, []); assert.deepEqual(policy.spec.ingress, []);
});
test("different PostgreSQL majors, mutable images, oversized budget and shell-like usernames are refused", async () => {
  const { point } = await fixture();
  const pg = structuredClone(point); pg.source.postgres.major = "14";
  assert.throws(() => buildSnapshotExportPlan(pg), /layout_unsupported/);
  const tag = structuredClone(point); tag.images.deployments[0].containers[0].image = "postgres:12";
  assert.throws(() => buildSnapshotExportPlan(tag), /image_unpinned/);
  assert.throws(() => buildSnapshotExportPlan(point, { maximumHours: 2 }), /budget_invalid/);
  assert.throws(() => buildSnapshotExportPlan(point, { maximumTemporaryUSD: 2 }), /budget_invalid/);
  assert.throws(() => buildSnapshotExportPlan(point, { databaseUser: "postgres; touch /other" }), /binding_invalid/);
});
function cloneBinding(plan, role) {
  const pvc = structuredClone(plan.objects.find(o => o.kind === "PersistentVolumeClaim" && o.metadata.name === role));
  pvc.metadata.uid = id(role === "database" ? 31 : 32); pvc.metadata.resourceVersion = "1";
  pvc.spec.volumeName = "clone-" + role; pvc.status = { phase: "Bound" };
  const pv = { metadata: { name: pvc.spec.volumeName, uid: id(role === "database" ? 41 : 42) }, status: { phase: "Bound" },
    spec: { claimRef: { name: role, namespace: plan.namespace, uid: pvc.metadata.uid }, persistentVolumeReclaimPolicy: "Delete",
      csi: { driver: "dobs.csi.digitalocean.com", volumeHandle: id(role === "database" ? 51 : 52) } } };
  return { pvc, pv };
}
test("clone binding proves distinct native disk/claim UIDs and rejects any original volume", async () => {
  const { plan } = await fixture(); const { pvc, pv } = cloneBinding(plan, "database");
  assert.equal(requireClonePVCBinding(pvc, pv, plan, "database").volumeId, id(51));
  for (const mutate of [v => { v.pv.spec.csi.volumeHandle = plan.originalVolumeIds[0]; },
    v => { v.pv.spec.claimRef.uid = id(99); }, v => { v.pvc.metadata.namespace = "fixture"; },
    v => { v.pvc.spec.dataSource.name = "other"; }, v => { v.pv.spec.persistentVolumeReclaimPolicy = "Retain"; }]) {
    const f = structuredClone({ pvc, pv }); mutate(f);
    assert.throws(() => requireClonePVCBinding(f.pvc, f.pv, plan, "database"), /binding_invalid/);
  }
});

function mockCluster(f, mutation = () => {}) {
  const objects = new Map(), calls = [], volumeFiles = { "database.dump": Buffer.from("PGDMP-FIXTURE-NOT-REAL-DATABASE"),
    "media.tar.gz": gzipSync(Buffer.from("FIXTURE-NOT-REAL-MEDIA")) };
  let counter = 100;
  const sourceNamespacePath = `/api/v1/namespaces/${f.plan.sourceNamespace.name}`;
  objects.set(sourceNamespacePath, { metadata: { name: f.plan.sourceNamespace.name, uid: f.plan.sourceNamespace.uid } });
  function response(value) { return { nativeExitCode: 0, stdout: JSON.stringify(value) }; }
  const run = async (program, args, options = {}) => {
    calls.push({ program, args, input: options.input });
    if (program === "doctl") return response([]);
    if (program === "bash") return { nativeExitCode: 0, stdout: "PUBLIC-FIXTURE-QUERY-".repeat(10) };
    if (program === "tar") return runExportNative(program, args, options);
    assert.equal(program, "kubectl"); assert.ok(args.includes(f.plan.context));
    if (args.includes("--raw")) {
      const rawIndex = args.indexOf("--raw"), verb = args[rawIndex - 1], path = args[rawIndex + 1];
      const uri = new URL("https://fixture.invalid" + path);
      if (verb === "get") {
        let value;
        if (uri.searchParams.has("fieldSelector")) {
          const name = uri.searchParams.get("fieldSelector").slice("metadata.name=".length);
          const object = objects.get(uri.pathname + "/" + name); value = { items: object ? [object] : [] };
        } else { value = objects.get(path); assert.ok(value, `Missing ${path}`); }
        const copied = structuredClone(value); mutation(copied, path, verb); return response(copied);
      }
      if (verb === "create") {
        const object = JSON.parse(options.input); object.metadata.uid = id(counter++); object.metadata.resourceVersion = "1";
        if (object.kind === "VolumeSnapshot") object.status = { readyToUse: true,
          boundVolumeSnapshotContentName: object.spec.source.volumeSnapshotContentName };
        if (object.kind === "PersistentVolumeClaim") {
          const { pv } = cloneBinding(f.plan, object.metadata.name);
          object.spec.volumeName = pv.metadata.name; object.status = { phase: "Bound" };
          pv.spec.claimRef.uid = object.metadata.uid; objects.set(`/api/v1/persistentvolumes/${pv.metadata.name}`, pv);
        }
        if (object.kind === "Pod") object.status = { phase: "Running", containerStatuses: object.spec.containers.map(c => ({
          name: c.name, ready: true, restartCount: 0, imageID: c.image, state: { running: {} } })) };
        objects.set(path + "/" + object.metadata.name, structuredClone(object)); return response(object);
      }
      assert.equal(verb, "delete");
      const body = JSON.parse(options.input), object = objects.get(path);
      assert.equal(body.preconditions.uid, object.metadata.uid); assert.equal(body.preconditions.resourceVersion, object.metadata.resourceVersion);
      assert.equal(body.propagationPolicy, "Foreground"); objects.delete(path);
      if (object.kind === "PersistentVolumeClaim") objects.delete(`/api/v1/persistentvolumes/${object.spec.volumeName}`);
      return response({ status: "Success" });
    }
    assert.equal(args[args.indexOf("-n") + 1], f.plan.namespace);
    const command = args.slice(args.indexOf("--") + 1);
    if (command[0] === "psql") return response(f.point.contract);
    if (command[0] === "cat") {
      const name = command[1].split("/").at(-1); await options.outputFile.writeFile(volumeFiles[name]);
      return { nativeExitCode: 0, stdout: "" };
    }
    assert.equal(command[0], "sh");
    if (command[2].includes("pg_dump")) return { nativeExitCode: 0, stdout: "" };
    const name = command.at(-1).split("/").at(-1), bytes = volumeFiles[name];
    return { nativeExitCode: 0, stdout: `${sha(bytes)}  /work/${name}\n${bytes.length}\n` };
  };
  const snapshots = { async get(snapshotId) {
    const expected = Object.values(f.point.pair.snapshots).find(s => s.id === snapshotId);
    assert.ok(expected); return { id: expected.id, name: expected.name, resource_id: expected.volumeId, resource_type: "volume",
      regions: [expected.region], min_disk_size: expected.minimumDiskGiB, size_gigabytes: expected.billableGiB, created_at: expected.createdAt };
  } };
  return { run, snapshots, calls, objects, volumeFiles };
}

test("native adapter prepares CSI clones, proves exports and only cleans UID-bound temporary objects", async () => {
  const f = await fixture(), cluster = mockCluster(f), provider = nativeSnapshotExportProvider(cluster), journal = events();
  await provider.prepare(f.plan, f.point, journal);
  const directory = join(f.parent, "export"); await mkdir(directory, { mode: 0o700 });
  const result = await provider.exportFiles(f.plan, f.point, directory, journal);
  assert.equal(result.nativeExitCode, 0); assert.deepEqual(result.beforeContract, f.point.contract);
  assert.deepEqual(await readFile(join(directory, "database.dump")), cluster.volumeFiles["database.dump"]);
  const exportCommand = cluster.calls.find(c => c.args.includes("exec") && c.args.some(a => a.includes("pg_dump")));
  assert.ok(exportCommand, "fixture must observe the actual export invocation");
  assert.match(exportCommand.args.join(" "), /tar --format=ustar --create --gzip --file=\/work\/media\.tar\.gz --directory=\/media owned(?: |$)/);
  assert.doesNotMatch(exportCommand.args.join(" "), /--directory=\/media \./);
  await provider.cleanup(f.plan, journal);
  const creates = cluster.calls.filter(c => c.args.includes("create")), deletes = cluster.calls.filter(c => c.args.includes("delete"));
  assert.equal(creates.length, 9); assert.equal(deletes.length, 9);
  assert.ok(!cluster.calls.some(c => c.args.includes("apply") || c.args.includes("patch") || c.args.includes("snapshot")));
  assert.equal(cluster.objects.size, 1); // original namespace remains untouched
});
for (const omitted of [["ingress"], ["egress"], ["ingress", "egress"]]) {
  test(`native API omission of empty NetworkPolicy ${omitted.join("/")} preserves deny-all isolation`, async () => {
    const f = await fixture({ minimal: true }), cluster = mockCluster(f), run = cluster.run;
    cluster.run = async (program, args, options) => {
      const result = await run(program, args, options);
      if (args.includes("--raw")) {
        const value = JSON.parse(result.stdout);
        if (value.kind === "NetworkPolicy") {
          for (const field of omitted) delete value.spec[field];
          result.stdout = JSON.stringify(value);
        }
      }
      return result;
    };
    const provider = nativeSnapshotExportProvider(cluster), journal = events();
    await provider.prepare(f.plan, f.point, journal);
    assert.equal(cluster.calls.filter(c => c.args.includes("create")).length, 9);
    await provider.cleanup(f.plan, journal);
    assert.equal(cluster.objects.size, 1);
    assert.equal(journal.entries.at(-1).event, "clones-cleanup-verified");
  });
}
for (const [field, value] of Object.entries({ ingress: [{}], egress: [{}],
  podSelector: { matchLabels: { unselected: "fixture" } }, policyTypes: ["Ingress"] })) {
  test(`NetworkPolicy drift ${field} is not normalized away`, async () => {
    const f = await fixture({ minimal: true }), cluster = mockCluster(f), run = cluster.run;
    cluster.run = async (program, args, options) => {
      const result = await run(program, args, options);
      if (args.includes("--raw")) {
        const valueFromAPI = JSON.parse(result.stdout);
        if (valueFromAPI.kind === "NetworkPolicy") {
          delete valueFromAPI.spec.ingress; delete valueFromAPI.spec.egress;
          valueFromAPI.spec[field] = value; result.stdout = JSON.stringify(valueFromAPI);
        }
      }
      return result;
    };
    const provider = nativeSnapshotExportProvider(cluster), journal = events();
    await assert.rejects(provider.prepare(f.plan, f.point, journal), /export_owned_resource_changed/);
    assert.equal(cluster.calls.filter(c => c.args.includes("create")).length, 2);
    assert.equal(cluster.calls.filter(c => c.args.includes("delete")).length, 0);
  });
}
test("billing metadata finalized after capture does not prevent the complete local export", async () => {
  const f = await fixture({ minimal: true, billableGiB: 0 }), cluster = mockCluster(f);
  const get = cluster.snapshots.get;
  cluster.snapshots.get = async snapshotId => ({ ...await get(snapshotId),
    size_gigabytes: snapshotId === f.point.pair.snapshots.database.id ? 0.2927 : 0.3328 });
  const originalPair = await readFile(join(f.directory, "native-pair.json"));
  const provider = nativeSnapshotExportProvider(cluster);
  const identityPath = join(f.parent, "fixture-billing-age.key");
  execFileSync("age-keygen", ["-o", identityPath], { stdio: "pipe" });
  const recipient = execFileSync("age-keygen", ["-y", identityPath], { encoding: "utf8" }).trim();
  const result = await exportMonthlySnapshotPoint({ checkpointDirectory: f.directory,
    captureCompletionPath: f.completionPath, outputDirectory: join(f.parent, "result"),
    journalDirectory: join(f.parent, "journal"), recipient, provider });
  assert.equal(result.nativeExportExitCode, 0);
  assert.equal(result.state, "sealed-not-restore-accepted");
  assert.equal(result.cloneCleanupVerified, true);
  const opened = join(f.parent, "opened");
  const manifest = await openPortablePoint({ packageDirectory: result.packageDirectory, outputDirectory: opened, identityPath });
  assert.equal(manifest.binding.nativeManifestSha256, f.point.manifestSha256);
  assert.deepEqual(await readFile(join(opened, "database.dump")), cluster.volumeFiles["database.dump"]);
  assert.deepEqual(await readFile(join(opened, "media.tar.gz")), cluster.volumeFiles["media.tar.gz"]);
  assert.deepEqual(await readFile(join(f.directory, "native-pair.json")), originalPair);
  assert.ok(cluster.calls.some(c => c.args.includes("exec") && c.args.some(a => a.includes("pg_dump"))));
  assert.equal(cluster.calls.filter(c => c.args.includes("create")).length, 9);
  assert.equal(cluster.calls.filter(c => c.args.includes("delete")).length, 9);
  assert.equal(cluster.objects.size, 1);
  assert.ok(!cluster.calls.some(c => c.args.includes("apply") || c.args.includes("patch")));
  assert.ok(cluster.calls.filter(c => c.program === "doctl").every(c =>
    c.args.slice(0, 3).join(" ") === "compute volume list")); // mocked cleanup read only
  assert.equal(buildSnapshotExportPlan(f.point).estimatedTemporaryUSD, f.plan.estimatedTemporaryUSD);
});
for (const role of ["database", "media"]) {
  for (const [field, value] of Object.entries({ id: id(99), name: "foreign-snapshot", resource_id: id(98),
    resource_type: "droplet", regions: ["nyc3"], min_disk_size: 11, created_at: "2026-10-06T12:00:01Z" })) {
    test(`updated billing does not excuse changed ${role} snapshot ${field}`, async () => {
      const f = await fixture({ minimal: true, billableGiB: 0 }), cluster = mockCluster(f), get = cluster.snapshots.get;
      cluster.snapshots.get = async snapshotId => ({ ...await get(snapshotId), size_gigabytes: 0.3328,
        ...(snapshotId === f.point.pair.snapshots[role].id ? { [field]: value } : {}) });
      const provider = nativeSnapshotExportProvider(cluster), journal = events();
      await assert.rejects(provider.prepare(f.plan, f.point, journal),
        /(?:monthly_snapshot_identity_mismatch|export_source_snapshot_changed)/);
      assert.equal(cluster.calls.filter(c => c.args.includes("create")).length, 0);
      assert.equal(journal.entries.length, 0);
    });
  }
  for (const value of [-1, NaN, Infinity, "0.3328", null]) {
    test(`invalid ${role} billing value ${String(value)} still fails before creation`, async () => {
      const f = await fixture({ minimal: true, billableGiB: 0 }), cluster = mockCluster(f), get = cluster.snapshots.get;
      cluster.snapshots.get = async snapshotId => ({ ...await get(snapshotId),
        size_gigabytes: snapshotId === f.point.pair.snapshots[role].id ? value : 0.3328 });
      const provider = nativeSnapshotExportProvider(cluster);
      await assert.rejects(provider.prepare(f.plan, f.point, events()), /monthly_snapshot_identity_mismatch/);
      assert.equal(cluster.calls.filter(c => c.args.includes("create")).length, 0);
    });
  }
}
test("changed generated plan is rejected before any cloud read/write", async () => {
  const f = await fixture(), cluster = mockCluster(f), provider = nativeSnapshotExportProvider(cluster);
  const plan = structuredClone(f.plan); plan.objects.at(-1).spec.volumes[0].persistentVolumeClaim.claimName = "pgsql-pvc";
  await assert.rejects(provider.prepare(plan, f.point, events()), /not_generated_exact/); assert.equal(cluster.calls.length, 0);
});
test("pod drift and restart fail before data is read", async () => {
  const f = await fixture(); let change = false;
  const cluster = mockCluster(f, (value, path) => {
    if (change && path.endsWith("/pods/export")) value.status.containerStatuses[0].restartCount = 1;
  });
  const provider = nativeSnapshotExportProvider(cluster); await provider.prepare(f.plan, f.point, events()); change = true;
  await assert.rejects(provider.exportFiles(f.plan, f.point, f.parent, events()), /pod_not_ready_exact/);
});
test("Retain drift stops local snapshot deletion before it could delete the original snapshot", async () => {
  const f = await fixture(); let change = false;
  const cluster = mockCluster(f, (value, path) => {
    if (change && path.includes("/volumesnapshotcontents/")) value.spec.deletionPolicy = "Delete";
  });
  const provider = nativeSnapshotExportProvider(cluster); await provider.prepare(f.plan, f.point, events()); change = true;
  await assert.rejects(provider.cleanup(f.plan, events()), /owned_resource_changed/);
  assert.ok(!cluster.calls.some(c => c.args.includes("delete") && c.args.some(a => a.includes("/volumesnapshots/"))));
});
test("ambiguous create is not repeated, adopted or cascaded away", async () => {
  const f = await fixture(), cluster = mockCluster(f), original = cluster.run;
  cluster.run = async (program, args, options) => {
    if (args.includes("create") && args.some(a => a.includes("persistentvolumeclaims"))) {
      await original(program, args, options); throw new Error("export_native_command_failed_or_ambiguous");
    }
    return original(program, args, options);
  };
  const provider = nativeSnapshotExportProvider(cluster), journal = events();
  await assert.rejects(provider.prepare(f.plan, f.point, journal), /failed_or_ambiguous/);
  await assert.rejects(provider.cleanup(f.plan, journal), /uncertain_resource_creation/);
  assert.equal(cluster.calls.filter(c => c.args.includes("create") && c.args.some(a => a.includes("persistentvolumeclaims"))).length, 1);
  assert.equal(cluster.calls.filter(c => c.args.includes("delete")).length, 0);
});
test("native command reports real exit0 and refuses a native failure without leaking stderr", async () => {
  const value = await runExportNative(process.execPath, ["-e", 'process.stdout.write("native-ok")']);
  assert.equal(value.nativeExitCode, 0); assert.equal(value.stdout, "native-ok");
  await assert.rejects(runExportNative(process.execPath, ["-e", 'process.stderr.write("DO-NOT-LEAK-SECRET");process.exit(13)']),
    error => error.message === "export_native_command_failed_or_ambiguous");
});
test("native child receives only the explicitly supplied environment for bound live checks", async () => {
  const result=await runExportNative(process.execPath,["-e",
    'if(process.env.YENHUBS_ONLY_FIXTURE_ENV!=="bound-fixture")process.exit(19);process.stdout.write("bound-env-ok")'],
  {env:{YENHUBS_ONLY_FIXTURE_ENV:"bound-fixture"}});
  assert.equal(result.nativeExitCode,0);assert.equal(result.stdout,"bound-env-ok");
});
test("wrong snapshot or source namespace is rejected before the first creation", async () => {
  const f = await fixture(), cluster = mockCluster(f);
  const get = cluster.snapshots.get;
  cluster.snapshots.get = async snapshotId => ({ ...await get(snapshotId), resource_id: id(99) });
  const provider = nativeSnapshotExportProvider(cluster);
  await assert.rejects(provider.prepare(f.plan, f.point, events()), /snapshot_identity_mismatch/);
  assert.equal(cluster.calls.filter(c => c.args.includes("create")).length, 0);
});
test("a changed clone handle cannot export or delete a source volume", async () => {
  const f = await fixture(); let change = false;
  const cluster = mockCluster(f, (value, path) => {
    if (change && path.includes("/persistentvolumes/clone-")) value.spec.csi.volumeHandle = f.plan.originalVolumeIds[0];
  });
  const provider = nativeSnapshotExportProvider(cluster), journal = events();
  await provider.prepare(f.plan, f.point, journal); change = true;
  await assert.rejects(provider.exportFiles(f.plan, f.point, f.parent, journal), /pvc_binding_invalid/);
  await assert.rejects(provider.cleanup(f.plan, journal), /pvc_binding_invalid/);
  assert.ok(!cluster.calls.some(c => c.args.includes("delete") && c.args.some(a => a.includes("persistentvolumeclaims"))));
});
test("remote readback alteration cannot pass the native producer", async () => {
  const f = await fixture(), cluster = mockCluster(f), original = cluster.run;
  cluster.run = async (program, args, options) => {
    if (args.includes("cat")) {
      await options.outputFile.writeFile(Buffer.from("ALTERED-AND-INCOMPLETE"));
      return { nativeExitCode: 0, stdout: "" };
    }
    return original(program, args, options);
  };
  const provider = nativeSnapshotExportProvider(cluster), journal = events();
  await provider.prepare(f.plan, f.point, journal);
  const output = join(f.parent, "export"); await mkdir(output, { mode: 0o700 });
  await assert.rejects(provider.exportFiles(f.plan, f.point, output, journal), /readback_size_changed/);
});
test("invalid encryption destination and journal inside a captured point fail before any cloud effect", async () => {
  const f = await fixture(); let started = 0;
  const provider = { prepare: async () => { started++; }, exportFiles: async () => {}, cleanup: async () => {} };
  const args = { checkpointDirectory: f.directory, captureCompletionPath: f.completionPath,
    outputDirectory: join(f.parent, "output"), journalDirectory: join(f.parent, "journal"), provider, recipient: "invalid" };
  await assert.rejects(exportMonthlySnapshotPoint(args), /recipient_invalid/);
  await assert.rejects(exportMonthlySnapshotPoint({ ...args, recipient: "age1" + "a".repeat(58),
    journalDirectory: join(f.directory, "journal") }), /inside_capture/);
  assert.equal(started, 0);
});
test("a failed cleanup is not automatically retried or labelled complete", async () => {
  const f = await fixture(); let cleanupCalls = 0;
  const cluster = mockCluster(f), native = nativeSnapshotExportProvider(cluster);
  const provider = { ...native, async cleanup() { cleanupCalls++; throw new Error("export_cleanup_resources_still_present"); } };
  const identityPath = join(f.parent, "fixture.key"); execFileSync("age-keygen", ["-o", identityPath], { stdio: "pipe" });
  const recipient = execFileSync("age-keygen", ["-y", identityPath], { encoding: "utf8" }).trim();
  await assert.rejects(exportMonthlySnapshotPoint({ checkpointDirectory: f.directory, captureCompletionPath: f.completionPath,
    outputDirectory: join(f.parent, "result"), journalDirectory: join(f.parent, "journal"), recipient, provider }), /resources_still_present/);
  assert.equal(cleanupCalls, 1); await assert.rejects(readFile(join(f.parent, "result", "export-result.json")), { code: "ENOENT" });
});
for (const minimal of [false,true]) test(`snapshot producer seals the ${minimal ? "compact" : "previous"} evidence archive and never self-accepts restore`, async () => {
  const f = await fixture({minimal}), cluster = mockCluster(f), provider = nativeSnapshotExportProvider(cluster);
  const identityPath = join(f.parent, "fixture-age.key");
  execFileSync("age-keygen", ["-o", identityPath], { stdio: "pipe" }); await chmod(identityPath, 0o600);
  const recipient = execFileSync("age-keygen", ["-y", identityPath], { encoding: "utf8" }).trim();
  const result = await exportMonthlySnapshotPoint({ checkpointDirectory: f.directory, captureCompletionPath: f.completionPath,
    outputDirectory: join(f.parent, "result"), journalDirectory: join(f.parent, "journal"), recipient, provider });
  assert.equal(result.state, "sealed-not-restore-accepted"); assert.equal(result.cloneCleanupVerified, true);
  const opened = join(f.parent, "opened");
  const manifest = await openPortablePoint({ packageDirectory: result.packageDirectory, outputDirectory: opened, identityPath });
  assert.equal(manifest.binding.nativeManifestSha256, f.point.manifestSha256);
  assert.deepEqual(await readFile(join(opened, "database.dump")), cluster.volumeFiles["database.dump"]);
  const list = execFileSync("tar", ["-tzf", join(opened, "runtime.tar.gz")], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(list, [...(minimal ? minimalMonthlyArtifacts : nativeMonthlyArtifacts), "SHA256SUMS"].sort());
  await assert.rejects(exportMonthlySnapshotPoint({ checkpointDirectory: f.directory, captureCompletionPath: f.completionPath,
    outputDirectory: join(f.parent, "result"), journalDirectory: join(f.parent, "journal"), recipient, provider }), { code: "EEXIST" });
});

/** Closed, local monthly gate. This is neither product acceptance nor a restore proof. */
import { readFileSync } from "node:fs";
import { readFile, lstat, realpath, readdir, open } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { readPrivateBytes } from "./monthly-snapshot-worker.mjs";
import { createMonthlyTestProcessOwner } from "./monthly-test-process-owner.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requireValue = (value, reason) => { if (!value) throw new Error(reason); };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = /^[a-f0-9]{64}$/;
const execute = promisify(execFile);
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const scopeBytes = readFileSync(new URL("./monthly-verification-scope.json", import.meta.url));
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const monthlyVerificationScope = freeze(JSON.parse(scopeBytes));
export const monthlyVerificationScopeSha256 = sha256(scopeBytes);
export const monthlyVerificationInputs = Object.freeze([...new Set([
  ...Object.values(monthlyVerificationScope.dependencies).flat(),
  ...monthlyVerificationScope.checks.flatMap(check => check.tests)
])].sort());
export const monthlyVerificationArguments = check => ["--test", "--test-concurrency=1", "--test-reporter=tap", ...check.tests];
const runtimeIdentity = () => ({ node: process.version, platform: process.platform, arch: process.arch });

async function gitNative(directory, args) {
  return (await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", directory, ...args],
    { timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" })).stdout;
}
async function readCandidateFile(path) {
  const before = await lstat(path);
  requireValue(before.isFile() && await realpath(path) === path && before.size <= MAX_EVIDENCE_BYTES,
    "monthly_verification_input_not_regular");
  const bytes = await readFile(path), after = await lstat(path);
  requireValue(["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key]),
    "monthly_verification_input_changed");
  return { bytes, executable: Boolean(before.mode & 0o100) };
}
function requireCandidate(candidate) {
  requireValue(candidate?.schema === "yenhubs-monthly-candidate-v1" && candidate.clean === true &&
    isDeepStrictEqual(Object.keys(candidate.code ?? {}).sort(), ["cloud", "hubs", "root"]) &&
    Object.values(candidate.code).every(value => /^[a-f0-9]{40}$/.test(value)) &&
    isDeepStrictEqual(Object.keys(candidate.inputs ?? {}).sort(), monthlyVerificationInputs) &&
    Object.values(candidate.inputs).every(value => sha.test(value)), "monthly_verification_candidate_invalid");
}

// Clean worktrees and root gitlinks are checked separately. Each declared input
// must also match its HEAD blob, even if assume-unchanged hides a working edit.
export async function inspectMonthlyCandidate(directory = root, { git = gitNative, read = readCandidateFile } = {}) {
  requireValue(isAbsolute(directory) && await realpath(directory) === directory, "monthly_verification_root_not_canonical");
  const code = {}, inputs = {};
  for (const [name, suffix] of [["root", ""], ["hubs", "hubs"], ["cloud", "hubs-cloud"]]) {
    const repository = join(directory, suffix);
    requireValue((await git(repository, ["rev-parse", "--show-toplevel"])).trim() === repository,
      "monthly_verification_subrepo_uninitialized");
    requireValue(await git(repository, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]) === "",
      "monthly_verification_source_dirty");
    code[name] = (await git(repository, ["rev-parse", "HEAD"])).trim();
    const paths = monthlyVerificationInputs.filter(path => suffix ? path.startsWith(suffix + "/") : !path.startsWith("hubs-cloud/") && !path.startsWith("hubs/"));
    if (!paths.length) continue;
    const localPaths = paths.map(path => suffix ? path.slice(suffix.length + 1) : path);
    const tree = (await git(repository, ["ls-tree", "-r", "-z", "HEAD", "--", ...localPaths])).split("\0").filter(Boolean);
    const blobs = new Map(tree.map(line => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      requireValue(match, "monthly_verification_input_not_tracked");
      return [match[3], { mode: match[1], hash: match[2] }];
    }));
    requireValue(blobs.size === localPaths.length, "monthly_verification_input_not_tracked");
    for (let i = 0; i < paths.length; i++) {
      const expected = blobs.get(localPaths[i]), { bytes, executable } = await read(join(directory, paths[i]));
      const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      requireValue(expected && expected.hash === blob && executable === (expected.mode === "100755"),
        "monthly_verification_input_not_at_head");
      inputs[paths[i]] = sha256(bytes);
    }
  }
  for (const [name, path] of [["hubs", "hubs"], ["cloud", "hubs-cloud"]]) {
    requireValue((await git(directory, ["ls-tree", "HEAD", "--", path])).trim() === `160000 commit ${code[name]}\t${path}`,
      "monthly_verification_subrepo_pin_changed");
  }
  const candidate = { schema: "yenhubs-monthly-candidate-v1", clean: true, code, inputs };
  requireCandidate(candidate);
  return candidate;
}

// Completion means native close, including drained stdout/stderr, never exit or
// a TAP-looking line alone. Any timeout/signal/overflow revokes the whole check.
export async function runMonthlyNativeCheck(check, { directory = root, evidenceDirectory, launch = spawn,
  own = child => createMonthlyTestProcessOwner(child, { pollMilliseconds: 500 }) } = {}) {
  const args = monthlyVerificationArguments(check), began = performance.now();
  return new Promise(resolveResult => {
    const chunks = { stdout: [], stderr: [] };
    let size = 0, timedOut = false, interrupted = false, outputLimitExceeded = false, launchFailed = false;
    let child, timer, owner, retirement, nativeClosed = false, settled = false;
    const unprovenRetirement = () => ({ schema: "yenhubs-monthly-test-process-retirement-v1",
      coverage: "observed-lineage", absenceVerified: false, observationUnproven: true, remaining: [] });
    const retire = () => retirement ??= Promise.resolve().then(() => owner?.retire())
      .then(value => value ?? unprovenRetirement(), unprovenRetirement);
    const stop = () => {
      // Cleanup remains joined even if the parent closes first. No negative-PID
      // signal and no adoption by name; detached descendants have native identities.
      void retire().then(cleanup => {
        // An unproved close is a failed observation, never a fabricated exit.
        if (!nativeClosed) void finish(null, null, false, cleanup);
      });
    };
    const interrupt = () => { interrupted = true; stop(); };
    const finish = async (nativeExitCode, signal, nativeCloseObserved, cleanup) => {
      clearTimeout(timer);
      const processRetirement = cleanup ?? await retire();
      if (settled) return;
      settled = true;
      owner?.close();
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      resolveResult({ nativeExitCode, signal, nativeCloseObserved, processRetirement,
        timedOut, interrupted, outputLimitExceeded, launchFailed,
        durationMilliseconds: Math.round(performance.now() - began),
        stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8") });
    };
    try {
      child = launch(process.execPath, args, { cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
        // Do not inherit credentials, NODE_OPTIONS, test filters or recovery selectors.
        env: { PATH: dirname(process.execPath) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: evidenceDirectory, TMPDIR: evidenceDirectory, LANG: "C", TZ: "UTC" } });
      child.once("error", () => { launchFailed = true; });
      child.once("close", (code, signal) => { nativeClosed = true; void finish(code, signal, true); });
      for (const name of ["stdout", "stderr"]) child[name].on("data", bytes => {
        size += bytes.length;
        if (size > MAX_EVIDENCE_BYTES / 2) { outputLimitExceeded = true; stop(); }
        else chunks[name].push(Buffer.from(bytes));
      });
      timer = setTimeout(() => { timedOut = true; stop(); }, check.timeoutMilliseconds);
      process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
      owner = own(child);
      Promise.resolve(owner.ready).catch(stop);
    } catch { launchFailed = true; void finish(null, null, false); }
  });
}

export function validateMonthlyCheckReceipt(receipt, check, attemptSha256) {
  requireValue(sha.test(attemptSha256 ?? "") && receipt?.attemptSha256 === attemptSha256,
    "monthly_verification_check_attempt_mismatch");
  const result = receipt?.result;
  requireValue(receipt?.schema === "yenhubs-monthly-check-v1" && receipt.id === check.id &&
    isDeepStrictEqual(receipt.arguments, monthlyVerificationArguments(check)) && result?.nativeExitCode === 0 &&
    result.signal === null && result.nativeCloseObserved === true && result.timedOut === false && result.interrupted === false &&
    result.outputLimitExceeded === false && result.launchFailed === false &&
    Number.isSafeInteger(result.durationMilliseconds) && result.durationMilliseconds >= 0 &&
    result.durationMilliseconds <= check.timeoutMilliseconds &&
    typeof result.stdout === "string" && typeof result.stderr === "string", "monthly_verification_native_check_failed");
  requireValue(result.processRetirement?.schema === "yenhubs-monthly-test-process-retirement-v1" &&
    result.processRetirement.coverage === "observed-lineage" && result.processRetirement.absenceVerified === true &&
    result.processRetirement.observationUnproven === false && Array.isArray(result.processRetirement.remaining) &&
    result.processRetirement.remaining.length === 0, "monthly_verification_process_retirement_unproven");
  const counters = {};
  for (const name of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...result.stdout.matchAll(new RegExp(`^# ${name} ([0-9]+)$`, "gm"))];
    requireValue(matches.length === 1, "monthly_verification_tap_unproven");
    counters[name] = Number(matches[0][1]);
  }
  requireValue(Object.values(counters).every(Number.isSafeInteger) && counters.tests > 0 && counters.tests === counters.pass &&
    ["fail", "cancelled", "skipped", "todo"].every(name => counters[name] === 0) &&
    (!check.expectedTests || counters.tests === check.expectedTests), "monthly_verification_tap_unproven");
  for (const expected of check.requiredDiagnostics ?? []) {
    const diagnostics = [...result.stdout.matchAll(/^# (\{.+\})$/gm)].flatMap(match => {
      try { return [JSON.parse(match[1])]; } catch { return []; }
    }).filter(value => value.state === expected.state);
    requireValue(diagnostics.length === 1 && diagnostics[0].nativeExit === expected.nativeExit &&
      diagnostics[0].actualCaptureAccepted === false, "monthly_verification_coordinator_unproven");
  }
  return counters;
}

async function privateDirectory(path) {
  requireValue(isAbsolute(path) && resolve(path) === path && await realpath(path) === path,
    "monthly_verification_evidence_path_invalid");
  const info = await lstat(path);
  requireValue(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700,
    "monthly_verification_evidence_not_private");
}
async function publishEvidence(path, value) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n"), file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const parent = await open(dirname(path), "r"); try { await parent.sync(); } finally { await parent.close(); }
  requireValue((await readPrivateBytes(path, MAX_EVIDENCE_BYTES)).equals(bytes), "monthly_verification_evidence_readback_failed");
  return sha256(bytes);
}

export async function readMonthlyVerification(reference, candidate) {
  requireCandidate(candidate);
  requireValue(isAbsolute(reference?.evidencePath ?? "") && sha.test(reference?.evidenceSha256 ?? ""),
    "monthly_verification_reference_invalid");
  await privateDirectory(dirname(reference.evidencePath));
  const bytes = await readPrivateBytes(reference.evidencePath, MAX_EVIDENCE_BYTES);
  requireValue(sha256(bytes) === reference.evidenceSha256, "monthly_verification_evidence_changed");
  const proof = JSON.parse(bytes);
  requireValue(proof.schema === "yenhubs-monthly-verification-v1" && proof.scope === monthlyVerificationScope.scope &&
    proof.state === "verified-not-restore-accepted" && proof.scopeSha256 === monthlyVerificationScopeSha256 &&
    isDeepStrictEqual(proof.candidate, candidate) && isDeepStrictEqual(proof.runtime, runtimeIdentity()) &&
    Number.isFinite(Date.parse(proof.startedAt)) && Date.parse(proof.completedAt) >= Date.parse(proof.startedAt) &&
    proof.checks?.length === monthlyVerificationScope.checks.length, "monthly_verification_proof_stale_or_invalid");
  requireValue(sha.test(proof.attemptSha256 ?? ""), "monthly_verification_attempt_unproven");
  const attemptBytes = await readPrivateBytes(join(dirname(reference.evidencePath), "attempt.json"), MAX_EVIDENCE_BYTES);
  requireValue(sha256(attemptBytes) === proof.attemptSha256, "monthly_verification_attempt_changed");
  requireValue(isDeepStrictEqual(JSON.parse(attemptBytes), {
    schema: "yenhubs-monthly-verification-attempt-v1", scope: proof.scope, scopeSha256: proof.scopeSha256,
    candidate, runtime: proof.runtime, startedAt: proof.startedAt
  }), "monthly_verification_attempt_stale_or_invalid");
  for (let i = 0; i < monthlyVerificationScope.checks.length; i++) {
    const check = monthlyVerificationScope.checks[i], referenceCheck = proof.checks[i];
    requireValue(referenceCheck?.id === check.id && sha.test(referenceCheck.evidenceSha256 ?? ""),
      "monthly_verification_check_missing");
    const checkBytes = await readPrivateBytes(join(dirname(reference.evidencePath), check.id + ".json"), MAX_EVIDENCE_BYTES);
    requireValue(sha256(checkBytes) === referenceCheck.evidenceSha256, "monthly_verification_check_changed");
    validateMonthlyCheckReceipt(JSON.parse(checkBytes), check, proof.attemptSha256);
  }
  return { state: proof.state, code: proof.candidate.code, evidenceSha256: reference.evidenceSha256 };
}

export async function runMonthlyVerification({ evidenceDirectory, directory = root,
  inspect = inspectMonthlyCandidate, run = runMonthlyNativeCheck, progress = () => {} }) {
  await privateDirectory(evidenceDirectory);
  requireValue(evidenceDirectory !== directory && !evidenceDirectory.startsWith(directory + sep),
    "monthly_verification_evidence_inside_candidate");
  requireValue((await readdir(evidenceDirectory)).length === 0, "monthly_verification_attempt_exists");
  const candidate = await inspect(directory), startedAt = new Date().toISOString(), checks = [];
  requireCandidate(candidate);
  // Immutable claim prevents a retry or concurrent runner from borrowing results.
  const attempt = { schema: "yenhubs-monthly-verification-attempt-v1", scope: monthlyVerificationScope.scope,
    scopeSha256: monthlyVerificationScopeSha256, candidate, runtime: runtimeIdentity(), startedAt };
  const attemptSha256 = await publishEvidence(join(evidenceDirectory, "attempt.json"), attempt);
  for (const check of monthlyVerificationScope.checks) {
    progress(check.id);
    const receipt = { schema: "yenhubs-monthly-check-v1", id: check.id, attemptSha256, arguments: monthlyVerificationArguments(check),
      result: await run(check, { directory, evidenceDirectory }) };
    const evidenceSha256 = await publishEvidence(join(evidenceDirectory, check.id + ".json"), receipt);
    validateMonthlyCheckReceipt(receipt, check, attemptSha256);
    checks.push({ id: check.id, evidenceSha256 });
  }
  requireValue(isDeepStrictEqual(await inspect(directory), candidate), "monthly_verification_candidate_changed");
  const proof = { schema: "yenhubs-monthly-verification-v1", scope: monthlyVerificationScope.scope,
    state: "verified-not-restore-accepted", scopeSha256: monthlyVerificationScopeSha256, candidate,
    runtime: attempt.runtime, startedAt, completedAt: new Date().toISOString(), attemptSha256, checks };
  const evidencePath = join(evidenceDirectory, "monthly-verification.json");
  const reference = { evidencePath, evidenceSha256: await publishEvidence(evidencePath, proof) };
  await readMonthlyVerification(reference, candidate);
  return reference;
}

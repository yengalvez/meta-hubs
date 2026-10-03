import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
function extract(name, indent = "") {
  const start = source.indexOf(`${indent}${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert.notEqual(end, -1, name);
  return source.slice(start, end + indent.length + 3);
}

// Proposed private contract, not a replacement for any complete predicate:
// READY is exactly "ready\n", followed by exactly ONE complete result record.
//   result:v1:healthy:-:0:complete-predicate
//   result:v1:guard-rejected:<array-index>:<1..255>:complete-predicate
//   result:v1:infrastructure:-:1:<guardian-identity|guardian-signal|guardian-wait>
// The worker publishes its result only after the native guardian has stopped.
// The parent validates kind/reason/status, every guard array's exact index,
// selected eight-argument tuple when present, native wait status, and EOF.
// It exports stream_guard_audit_result_{kind,index,status,reason}; no payload
// crosses archive stdout or supplies an arbitrary public diagnostic. Missing,
// partial, duplicate or invalid records are infrastructure, never guard proof.
// Existing public reasons remain compatible: guard-process:<index> ONLY for
// an identified complete-predicate rejection; infrastructure has no such label.
const nativeFunctions = [
  "recovery_process_start_identity",
  "recovery_monotonic_milliseconds",
  "recovery_process_identity_is_live",
  "recovery_revoke_owned_child_process_group_immediate",
  "recovery_stop_reaped_isolated_process_group"
].map(name => extract(name)).join("\n").replace(
  "recovery_process_identity_is_live() {", "native_process_identity_is_live() {"
);
const workerFunctions = [
  "stream_record_diagnostic",
  "supervised_stream_audit_child_is_running",
  "supervised_stream_audit_cleanup",
  "invoke_complete_stream_guard_audit"
].map(name => extract(name, "    ")).join("\n");
const runFunction = extract("run_complete_stream_guard_audit", "    ");

// The COMPLETE predicate and foreground counter are controlled boundaries.
// The production coproc, pipe, gate, job ownership, Python guardian, PID/start
// identities, PGID check, signals, wait/reap and cleanup remain native. Hooks
// corrupt only a result publication, READY, or an exact guardian/wait boundary;
// they do not port the consumer to JS or replace the production audit function.
const harness = String.raw`
set -u
fixture_layout="$1" fixture_reject_index="$2" fixture_reject_status="$3"
fixture_scope="$4" fixture_fault="$5" fixture_payload="$6" fixture_missing_array="$7"
fixture_parent_pid="$BASHPID"
# Preserve the fixture's stderr sink independently of the production helper's
# intentional 2>/dev/null redirects. Never use stdout/the result pipe for trace.
exec {fixture_trace_fd}>&2
recovery_process_identity_is_live(){
  native_process_identity_is_live "$@" || return $?
  if [[ "$BASHPID" != "$fixture_parent_pid" && "$1" != "$fixture_parent_pid" ]]; then
    builtin printf 'fixture_native_guardian_identity\n' >&"$fixture_trace_fd"
    [[ "$fixture_fault" != guardian-identity ]] || return 1
  fi
}
printf(){
  local rendered
  builtin printf -v rendered "$@"
  if [[ "$BASHPID" != "$fixture_parent_pid" &&
        "@{FUNCNAME[1]:-}" == run_complete_stream_guard_audit &&
        "$rendered" == result:v1:* ]]; then
    if [[ "$fixture_fault" == payload ]]; then
      builtin printf 'fixture_result_publication_corrupted\n' >&"$fixture_trace_fd"
      builtin printf '%s' "$fixture_payload"
      return 0
    elif [[ "$fixture_fault" == missing-result ]]; then
      builtin printf 'fixture_result_publication_suppressed\n' >&"$fixture_trace_fd"
      return 0
    elif [[ "$fixture_fault" == nul-ready ]]; then
      # Delay this corrupted READY until the exact predicate and guardian
      # outcome are observable, so prompt rejection cannot race our witnesses.
      builtin printf 'fixture_nul_ready_emitted\n' >&"$fixture_trace_fd"
      builtin printf '%b' 're\000ady\n'
      builtin printf "$@"
      return 0
    elif [[ "$fixture_fault" == nul-result ]]; then
      builtin printf 'fixture_nul_result_emitted\n' >&"$fixture_trace_fd"
      # Generate the byte inside the owned child, never in a spawn argument.
      builtin printf 'res\000%s' "@{rendered#res}"
      return 0
    elif [[ "$fixture_fault" == nul-tail ]]; then
      builtin printf 'fixture_nul_tail_emitted\n' >&"$fixture_trace_fd"
      builtin printf '%s\000' "$rendered"
      return 0
    fi
  fi
  builtin printf "$@"
}
kill(){
  if [[ "$BASHPID" != "$fixture_parent_pid" && "@{1:-}" == -USR1 ]]; then
    builtin printf 'fixture_native_guardian_signal\n' >&"$fixture_trace_fd"
    [[ "$fixture_fault" != guardian-signal ]] || return 1
  fi
  builtin kill "$@"
}
wait(){
  local fixture_wait_status=0
  builtin wait "$@" || fixture_wait_status=$?
  if [[ "$BASHPID" != "$fixture_parent_pid" ]]; then
    builtin printf 'fixture_native_guardian_wait:%s\n' "$fixture_wait_status" >&"$fixture_trace_fd"
    [[ "$fixture_fault" != guardian-wait ]] || return 1
  else
    builtin printf 'fixture_native_child_wait:%s\n' "$fixture_wait_status" >&"$fixture_trace_fd"
    [[ "$fixture_fault" != child-wait-mismatch ]] || return 37
  fi
  return "$fixture_wait_status"
}
recovery_stream_guard_process_is_healthy(){
  local fixture_index
  [[ "$#" == 8 ]] || { builtin printf 'fixture_bad_predicate_arguments\n' >&"$fixture_trace_fd"; return 252; }
  for fixture_index in "@{!guard_pids[@]}"; do
    [[ "$1" == "@{guard_pids[$fixture_index]}" ]] || continue
    [[ "$2" == "@{guard_start_identities[$fixture_index]}" &&
       "$3" == "@{guard_failure_markers[$fixture_index]}" &&
       "$4" == "@{guard_ready_markers[$fixture_index]}" &&
       "$5" == "@{guard_progress_markers[$fixture_index]}" &&
       "$6" == "@{guard_authority_paths[$fixture_index]}" &&
       "$7" == "@{guard_authority_sha256s[$fixture_index]}" &&
       "$8" == "@{guard_authority_kinds[$fixture_index]}" ]] || {
      builtin printf 'fixture_bad_predicate_arguments\n' >&"$fixture_trace_fd"; return 252;
    }
    builtin printf 'fixture_complete_predicate:%s\n' "$fixture_index" >&"$fixture_trace_fd"
    # This stdout must remain redirected away from the private result channel.
    if [[ "$fixture_fault" == predicate-forges-handshake ]]; then
      builtin printf 'ready\nresult:v1:healthy:-:0:complete-predicate\n'
    fi
    [[ "$fixture_index" != "$fixture_reject_index" ]] || return "$fixture_reject_status"
    return 0
  done
  builtin printf 'fixture_bad_predicate_arguments\n' >&"$fixture_trace_fd"
  return 252
}
observe_inactive_stream_guard_progress(){ return 0; }
require_reaped_stream_guard_freshness(){ return 0; }
main(){
  local stream_is_gated=0 stream_child_reaped=1 stream_diagnostic_stage=post-audit
  local stream_pid= stream_start_identity= stream_diagnostic_detail=
  local refresh_deadline_seconds=30 guard_cancel_reserve_milliseconds=2000
  local guard_audit_pid= guard_audit_read_fd= guard_audit_control_fd=
  local caller_pid="$BASHPID" caller_start_identity fixture_status=0 fixture_index
  local stream_guard_audit_result_kind=unreported stream_guard_audit_result_index=unreported
  local stream_guard_audit_result_status=unreported stream_guard_audit_result_reason=unreported
  local -a YENHUBS_STREAM_AUDIT=() guard_pids=() guard_start_identities=()
  local YENHUBS_STREAM_AUDIT_PID=
  local -a guard_failure_markers=() guard_ready_markers=() guard_progress_markers=()
  local -a guard_authority_paths=() guard_authority_sha256s=() guard_authority_kinds=()
  local -a fixture_indices=(0 1 2)
  [[ "$fixture_layout" != sparse ]] || fixture_indices=(0 2 5)
  [[ "$fixture_layout" != empty ]] || fixture_indices=()
  for fixture_index in "@{fixture_indices[@]}"; do
    guard_pids[$fixture_index]=$((10101 + fixture_index))
    guard_start_identities[$fixture_index]="synthetic-start-$fixture_index"
    guard_failure_markers[$fixture_index]="/fixture/f$fixture_index"
    guard_ready_markers[$fixture_index]="/fixture/r$fixture_index"
    guard_progress_markers[$fixture_index]="/fixture/p$fixture_index"
    guard_authority_paths[$fixture_index]="/fixture/r$fixture_index.authority.json"
    guard_authority_sha256s[$fixture_index]="synthetic-sha-$fixture_index"
    guard_authority_kinds[$fixture_index]="synthetic-kind-$fixture_index"
  done
  # Reject guard 2 before the missing slot is ever dereferenced by a sweep.
  # A forged result for guard 5 must still have membership in ALL eight arrays.
  if [[ -n "$fixture_missing_array" ]]; then
    case "$fixture_missing_array" in
      guard_pids|guard_start_identities|guard_failure_markers|guard_ready_markers|\
      guard_progress_markers|guard_authority_paths|guard_authority_sha256s|guard_authority_kinds)
        unset "$fixture_missing_array[5]" ;;
      *) return 253 ;;
    esac
  fi
  caller_start_identity="$(recovery_process_start_identity "$caller_pid")" || return 254
  trap supervised_stream_audit_cleanup EXIT
  if [[ "$fixture_scope" == single ]]; then
    fixture_index=2
    run_complete_stream_guard_audit \
      "@{guard_pids[$fixture_index]}" "@{guard_start_identities[$fixture_index]}" \
      "@{guard_failure_markers[$fixture_index]}" "@{guard_ready_markers[$fixture_index]}" \
      "@{guard_progress_markers[$fixture_index]}" "@{guard_authority_paths[$fixture_index]}" \
      "@{guard_authority_sha256s[$fixture_index]}" "@{guard_authority_kinds[$fixture_index]}" || fixture_status=$?
  else
    run_complete_stream_guard_audit || fixture_status=$?
  fi
  builtin printf 'status=%s\nkind=%s\nindex=%s\nresult_status=%s\nreason=%s\ndiagnostic=%s\n' \
    "$fixture_status" "$stream_guard_audit_result_kind" "$stream_guard_audit_result_index" \
    "$stream_guard_audit_result_status" "$stream_guard_audit_result_reason" "$stream_diagnostic_detail"
  builtin printf 'remaining_jobs=%s\n' "$(jobs -r -p)"
  # EXIT fires after main's dynamic locals are gone on a normal return. Finish
  # idempotent cleanup and remove that fallback while its FD/PID locals exist.
  supervised_stream_audit_cleanup
  trap - EXIT
}
main
`.replaceAll("@{", "${");

function run({ layout = "dense", rejectIndex = -1, rejectStatus = 1, scope = "sweep", fault = "none", payload = "", missingArray = "" } = {}) {
  let audit = runFunction;
  if (["missing-handshake", "forged-handshake", "predicate-forges-handshake", "result-before-handshake", "nul-ready"].includes(fault)) {
    const ready = 'os.write(1, b"ready\\n")';
    assert.ok(audit.includes(ready), "instrument only the existing native guardian READY publication");
    const replacement = fault === "forged-handshake" ? 'os.write(1, b"forged-ready\\n")' :
      fault === "result-before-handshake" ? 'os.write(1, b"result:v1:healthy:-:0:complete-predicate\\nready\\n")' :
      "# Fixture suppresses the guardian READY, never its ownership checks.";
    audit = audit.replace(ready, replacement);
  }
  const script = `${nativeFunctions}\n${workerFunctions}\n${audit}\n${harness}`;
  assert.ok(!script.includes("\0"), "NUL corruption must be generated at runtime, not passed in argv");
  const result = spawnSync("bash", ["-c", script, "stream-audit-result-fixture",
    layout, String(rejectIndex), String(rejectStatus), scope, fault, payload, missingArray], {
    cwd: root, encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, LC_ALL: "C" }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes("fixture_bad_predicate_arguments"), result.stderr);
  const rows = result.stdout.trimEnd().split("\n");
  assert.equal(rows.length, 7, "private payload/predicate stdout must not escape into archive stdout");
  const report = Object.fromEntries(rows.map(line => {
    const separator = line.indexOf("=");
    assert.ok(separator > 0, result.stdout);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.equal(report.remaining_jobs, "", "the owned audit job must be reaped before returning");
  return { ...report, stderr: result.stderr,
    audited: [...result.stderr.matchAll(/^fixture_complete_predicate:(\d+)$/gm)].map(match => Number(match[1])) };
}

function assertNativeGuardian(r) {
  assert.match(r.stderr, /^fixture_native_guardian_identity$/m, "reach the REAL guardian identity check");
  assert.match(r.stderr, /^fixture_native_guardian_signal$/m, "signal the REAL guardian");
  assert.match(r.stderr, /^fixture_native_guardian_wait:0$/m, "join the REAL guardian successfully");
  assert.match(r.stderr, /^fixture_native_child_wait:/m, "wait/reap the REAL coproc");
}
function assertInfrastructure(r, reason) {
  assert.notEqual(r.status, "0", JSON.stringify(r));
  assert.equal(r.kind, "infrastructure", JSON.stringify(r));
  assert.equal(r.index, "", "infrastructure cannot claim a rejected guard index");
  assert.match(r.result_status, /^(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])$/);
  assert.equal(r.reason, reason);
  assert.ok(!r.diagnostic.startsWith("guard-process:"), "a generic auditor failure is NOT proof of any guard rejection");
  assert.ok(!r.stderr.includes("private-secret-sentinel"), "malformed private content is never reflected");
}

for (const [layout, expected] of [["dense", [0, 1, 2]], ["sparse", [0, 2, 5]], ["empty", []]]) {
  test(`native ${layout} healthy sweep exports a validated result, not just guardian success`, () => {
    const r = run({ layout });
    assert.deepEqual(r.audited, expected, "the production invoke function runs every complete predicate in order");
    assertNativeGuardian(r);
    assert.equal(r.status, "0");
    assert.equal(r.kind, "healthy");
    assert.equal(r.index, "");
    assert.equal(r.result_status, "0");
    assert.equal(r.reason, "complete-predicate");
    assert.equal(r.diagnostic, "");
  });
}

for (const [layout, rejectIndex, rejectStatus, expected] of [
  ["dense", 0, 1, [0]], ["dense", 1, 2, [0, 1]],
  ["sparse", 2, 37, [0, 2]], ["sparse", 5, 255, [0, 2, 5]]
]) {
  test(`native complete rejection identifies exact ${layout} guard ${rejectIndex} and status ${rejectStatus}`, () => {
    const r = run({ layout, rejectIndex, rejectStatus });
    assert.deepEqual(r.audited, expected, "never omit an earlier predicate or execute past the first rejection");
    assertNativeGuardian(r);
    assert.equal(r.status, String(rejectStatus));
    assert.equal(r.kind, "guard-rejected");
    assert.equal(r.index, String(rejectIndex));
    assert.equal(r.result_status, String(rejectStatus));
    assert.equal(r.reason, "complete-predicate");
    assert.equal(r.diagnostic, `guard-process:${rejectIndex}`, "generic guard-audit-exit is insufficient");
  });
}

for (const rejectIndex of [-1, 2]) {
  test(`the native eight-argument Lease audit binds its result to sparse guard 2 (${rejectIndex < 0 ? "healthy" : "rejected"})`, () => {
    const r = run({ layout: "sparse", scope: "single", rejectIndex, rejectStatus: 2 });
    assert.deepEqual(r.audited, [2], "run exactly the selected full tuple, not a reduced or complete-array sweep");
    assertNativeGuardian(r);
    assert.equal(r.kind, rejectIndex < 0 ? "healthy" : "guard-rejected");
    assert.equal(r.index, rejectIndex < 0 ? "" : "2");
    assert.equal(r.status, rejectIndex < 0 ? "0" : "2");
    assert.equal(r.result_status, r.status);
    assert.equal(r.reason, "complete-predicate");
  });
}

for (const fault of ["guardian-identity", "guardian-signal", "guardian-wait"]) {
  for (const rejectIndex of [-1, 2]) {
    test(`${fault} remains infrastructure even when a complete guard also rejects`, () => {
      const r = run({ fault, rejectIndex });
      assert.deepEqual(r.audited, [0, 1, 2]);
      assert.match(r.stderr, /^fixture_native_guardian_identity$/m);
      assertInfrastructure(r, fault);
    });
  }
}

const malformedResults = [
  ["unknown version", "result:v2:healthy:-:0:complete-predicate\n"],
  ["unknown kind", "result:v1:accepted:-:0:complete-predicate\n"],
  ["unknown or reflected reason", "result:v1:guard-rejected:2:1:private-secret-sentinel\n"],
  ["healthy with rejection status", "result:v1:healthy:-:1:complete-predicate\n"],
  ["rejection with success status", "result:v1:guard-rejected:2:0:complete-predicate\n"],
  ["status above native range", "result:v1:guard-rejected:2:256:complete-predicate\n"],
  ["negative status", "result:v1:guard-rejected:2:-1:complete-predicate\n"],
  ["noncanonical status", "result:v1:guard-rejected:2:01:complete-predicate\n"],
  ["nonnumeric status", "result:v1:guard-rejected:2:one:complete-predicate\n"],
  ["sparse array hole", "result:v1:guard-rejected:1:1:complete-predicate\n"],
  ["index beyond arrays", "result:v1:guard-rejected:9:1:complete-predicate\n"],
  ["negative index", "result:v1:guard-rejected:-1:1:complete-predicate\n"],
  ["noncanonical index", "result:v1:guard-rejected:02:1:complete-predicate\n"],
  ["healthy carrying guard identity", "result:v1:healthy:2:0:complete-predicate\n"],
  ["extra field", "result:v1:guard-rejected:2:1:complete-predicate:extra\n"],
  ["missing field", "result:v1:guard-rejected:2:1\n"],
  ["unterminated result", "result:v1:guard-rejected:2:1:complete-predicate"],
  ["duplicate result", "result:v1:guard-rejected:2:1:complete-predicate\nresult:v1:guard-rejected:2:1:complete-predicate\n"],
  ["trailing payload", "result:v1:guard-rejected:2:1:complete-predicate\nprivate-secret-sentinel\n"]
];
for (const [label, payload] of malformedResults) {
  test(`native private channel rejects ${label} without manufacturing guard evidence`, () => {
    const r = run({ layout: "sparse", rejectIndex: 2, fault: "payload", payload });
    assert.deepEqual(r.audited, [0, 2]);
    assertNativeGuardian(r);
    assertInfrastructure(r, "result");
    assert.match(r.stderr, /^fixture_result_publication_corrupted$/m);
  });
}

for (const missingArray of ["guard_pids", "guard_start_identities", "guard_failure_markers", "guard_ready_markers",
  "guard_progress_markers", "guard_authority_paths", "guard_authority_sha256s", "guard_authority_kinds"]) {
  test(`a private guard index must exist in ${missingArray}, not only another parallel array`, () => {
    const r = run({ layout: "sparse", rejectIndex: 2, fault: "payload", missingArray,
      payload: "result:v1:guard-rejected:5:1:complete-predicate\n" });
    assert.deepEqual(r.audited, [0, 2]);
    assertNativeGuardian(r);
    assertInfrastructure(r, "result");
  });
}

test("a single-tuple result cannot claim another otherwise valid sparse guard", () => {
  const r = run({ layout: "sparse", scope: "single", rejectIndex: 2, fault: "payload",
    payload: "result:v1:guard-rejected:5:1:complete-predicate\n" });
  assert.deepEqual(r.audited, [2]);
  assertNativeGuardian(r);
  assertInfrastructure(r, "result");
});
for (const rejectIndex of [-1, 2]) {
  test(`missing private result with native exit ${rejectIndex < 0 ? "0" : "1"} is not guard evidence`, () => {
    const r = run({ fault: "missing-result", rejectIndex });
    assert.deepEqual(r.audited, [0, 1, 2]);
    assertNativeGuardian(r);
    assertInfrastructure(r, "result");
  });
}
test("native wait status must agree with the private healthy result", () => {
  const r = run({ fault: "child-wait-mismatch" });
  assert.deepEqual(r.audited, [0, 1, 2]);
  assertNativeGuardian(r);
  assertInfrastructure(r, "child-exit");
});
test("a valid guard record cannot conceal a different native child exit status", () => {
  const r = run({ rejectIndex: 2, fault: "payload",
    payload: "result:v1:guard-rejected:2:37:complete-predicate\n" });
  assert.deepEqual(r.audited, [0, 1, 2]);
  assertNativeGuardian(r);
  assertInfrastructure(r, "child-exit");
});
for (const fault of ["missing-handshake", "forged-handshake", "predicate-forges-handshake", "result-before-handshake"]) {
  test(`${fault} cannot establish the native private guardian handshake`, () => {
    const r = run({ fault });
    assertInfrastructure(r, "handshake");
    if (fault === "predicate-forges-handshake") {
      assert.deepEqual(r.audited, [0, 1, 2]);
      assertNativeGuardian(r);
      assert.match(r.stderr, /^ready$/m, "the predicate's fake READY exists only on stderr");
    }
  });
}

for (const [fault, position, reason] of [
  ["nul-ready", "inside READY", "handshake"],
  ["nul-result", "inside the result record", "result"],
  ["nul-tail", "after the result LF", "result"]
]) {
  test(`NUL ${position} cannot fabricate attribution to a real rejected guard 2 / status 1`, () => {
    const r = run({ rejectIndex: 2, rejectStatus: 1, fault });
    assert.deepEqual(r.audited, [0, 1, 2]);
    assertNativeGuardian(r);
    assert.match(r.stderr, new RegExp(`^fixture_${fault.replace("-", "_")}_emitted$`, "m"), "the owned child emitted byte-level corruption");
    assertInfrastructure(r, reason);
  });
}
test("NUL after a healthy result LF cannot grant successful archive acceptance", () => {
  const r = run({ fault: "nul-tail" });
  assert.deepEqual(r.audited, [0, 1, 2]);
  assertNativeGuardian(r);
  assert.match(r.stderr, /^fixture_nul_tail_emitted$/m);
  assertInfrastructure(r, "result");
});

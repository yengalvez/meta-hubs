import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
function extract(name) {
  const start = source.indexOf(`    ${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = source.indexOf("\n    }\n", start);
  assert.notEqual(end, -1, name);
  return source.slice(start, end + 7);
}
// Execute the production Bash functions, not a JavaScript port of their
// scheduling algorithm. Only boundary checks, elapsed costs and monitor
// counters are simulated; no files, timers, kubectl or publishers are needed.
const functions = [
  "stream_record_diagnostic",
  "refresh_supervised_stream_guards_for_launch",
  "supervised_stream_guards_are_continuously_healthy",
  "supervised_stream_guard_remaining_milliseconds",
  "supervised_stream_require_lease_within_guard_budget",
  "supervised_stream_guard_has_cancellation_reserve"
].map(extract).join("\n");

const harness = String.raw`
set -u
mode="$1" fault="$2" phase="$3" full_cost="$4" require_lease="$5"
IFS=, read -r -a counter_periods <<<"@{6:-1000,1000,1000}"
IFS=, read -r -a audit_costs <<<"@{7:-$full_cost,$full_cost,$full_cost}"
clock=0 full_audits=0 continuity_checks=0 lease_reads=0 identity_checks=0
stream_is_gated=1 stream_diagnostic_stage=refresh stream_diagnostic_detail=
supervised_stream_guard_failure_kind=
refresh_deadline_seconds=30 guard_cancel_reserve_milliseconds=2000
lease_authority_guard_index= poll_seconds=.1
stream_pid=41 stream_start_identity=x caller_pid=42 caller_start_identity=x
guard_pids=(11 12 13) guard_start_identities=(x x x)
guard_failure_markers=(/fixture/f0 /fixture/f1 /fixture/f2)
guard_ready_markers=(/fixture/r0 /fixture/r1 /fixture/r2)
guard_progress_markers=(/fixture/p0 /fixture/p1 /fixture/p2)
guard_authority_paths=(/fixture/r0.authority.json /fixture/r1.authority.json /fixture/r2.authority.json)
guard_authority_sha256s=(synthetic synthetic synthetic) guard_authority_kinds=(synthetic synthetic synthetic)
guard_maximum_stale_seconds=(10 10 10) guard_last_progress=(1 1 1)
guard_last_progress_milliseconds=(0 0 0) guard_last_observation_milliseconds=(0 0 0)
recovery_monotonic_milliseconds(){ printf '%s\n' "$clock"; }
recovery_stream_guard_process_is_healthy(){
  if [[ "$#" == 8 ]]; then
    full_audits=$((full_audits+1)); clock=$((clock+audit_costs[$1-11]))
    [[ "$fault" != audit-after-realignment || "$full_audits" -le 6 ]] || return 1
  else
    continuity_checks=$((continuity_checks+1))
    if [[ "$mode" == persistent ||
          ( "$mode" == lease-transient && "$continuity_checks" -ge 4 && "$continuity_checks" -le 6 ) ||
          ( "$mode" != fast && "$mode" != asymmetric && "$mode" != lease-transient && "$continuity_checks" -le 3 ) ]]; then
      clock=$((clock+3500))
    else clock=$((clock+100)); fi
    [[ "$fault" != process && "$fault" != failure-marker ]] || return 1
  fi
  return 0
}
recovery_stream_guard_failure_detail(){
  [[ "$fault" == failure-marker ]] || return 1
  printf 'identity:changed\n'
}
recovery_read_private_file_once(){ [[ "$fault" != hash ]]; }
recovery_stream_guard_progress_value(){
  if [[ "@{FUNCNAME[*]}" == *observe_gated_prelaunch_guard_progress* ]]; then
    [[ "$fault" != sample-read ]] || return 1
    if [[ "$fault" == sample-regression && "$full_audits" -ge 1 ]]; then printf '1\n'; return; fi
  fi
  if [[ "$continuity_checks" -gt 0 ]]; then
    [[ "$fault" != read ]] || return 1
    [[ "$fault" != read-after-lease || "$lease_reads" == 0 ]] || return 1
    if [[ "$fault" == regression ]]; then printf '1\n'; return; fi
  fi
  if [[ "$mode" == stalled && "$clock" -ge 6000 ]]; then printf '7\n'
  else
    local guard_number="@{1##*/p}"
    if [[ "$fault" == stopped-source && "$guard_number" == 0 ]]; then printf '1\n'; return; fi
    printf '%s\n' "$((clock/counter_periods[guard_number]+1))"
  fi
}
recovery_process_identity_is_live(){
  identity_checks=$((identity_checks+1))
  [[ "$fault" != identity ]] || return 1
}
recovery_require_operation_serialization_stream(){
  lease_reads=$((lease_reads+1)); clock=$((clock+100))
  [[ "$fault" != lease ]] || return 1
}
sleep(){ clock=$((clock+100)); }
main(){
  local status=0 reserve_status=0
  case "$phase" in
    reserve-boundary) clock=8000 ;;
    reserve-above) clock=7999 ;;
    post) stream_is_gated=0; stream_diagnostic_stage=post-audit
      refresh_supervised_stream_guards_for_launch 1000 || status=$? ;;
    running) stream_is_gated=0; stream_diagnostic_stage=running
      refresh_supervised_stream_guards_for_launch || status=$? ;;
    closed-flag) stream_is_gated=0
      refresh_supervised_stream_guards_for_launch || status=$? ;;
    *) refresh_supervised_stream_guards_for_launch || status=$? ;;
  esac
  supervised_stream_guard_has_cancellation_reserve || reserve_status=$?
  printf 'status=%s\nclock=%s\nfull_audits=%s\ncontinuity_checks=%s\nlease_reads=%s\nidentity_checks=%s\nreserve_status=%s\nremaining=%s\ndiagnostic=%s\nkind=%s\n' \
    "$status" "$clock" "$full_audits" "$continuity_checks" "$lease_reads" "$identity_checks" \
    "$reserve_status" "$remaining_milliseconds" "$stream_diagnostic_detail" "$supervised_stream_guard_failure_kind"
  (IFS=,; printf 'progress=%s\nbounds=%s\nobservations=%s\n' \
    "@{guard_last_progress[*]}" "@{guard_last_progress_milliseconds[*]}" "@{guard_last_observation_milliseconds[*]}")
}
main
`.replaceAll("@{", "${");

function run({ mode = "transient", fault = "none", phase = "pre", fullCost = 1000, lease = 0, periods = [1000, 1000, 1000], costs = [fullCost, fullCost, fullCost] } = {}) {
  const result = spawnSync("/bin/bash", ["-c", `${functions}\n${harness}`, "fixture", mode, fault, phase, String(fullCost), String(lease), periods.join(","), costs.join(",")], {
    encoding: "utf8", timeout: 5000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return Object.fromEntries(result.stdout.trim().split("\n").map(line => {
    const separator = line.indexOf("=");
    const value = line.slice(separator + 1);
    return [line.slice(0, separator), /^-?\d+$/.test(value) ? Number(value) : value];
  }));
}

test("healthy counters realign after transient continuity cost within the ORIGINAL deadline", () => {
  // Before this change, the same real-function harness failed at 16,500ms:
  // guard-stale:0, counters 10/14/17, causal bounds 4000/5000/6000.
  const r = run();
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.ok(r.clock > 16500 && r.clock < 30000, JSON.stringify(r));
  assert.ok(r.full_audits > 6, "realignment repeats complete audits");
  assert.equal(r.reserve_status, 0);
  assert.ok(r.remaining > 2000);
  assert.equal(r.diagnostic, "", "transient diagnostics cannot mask a subsequent failure");
  const bounds = r.bounds.split(",").map(Number);
  const observations = r.observations.split(",").map(Number);
  assert.ok(bounds.every((bound, i) => bound < observations[i]), "progress is dated to the PREVIOUS observation");
});

test("unchanged healthy fast path retains a simultaneous freshness and cancellation window", () => {
  const r = run({ mode: "fast" });
  assert.equal(r.status, 0);
  assert.equal(r.clock, 6300);
  assert.equal(r.full_audits, 6);
  assert.equal(r.reserve_status, 0);
});

for (const period of [3000, 6000, 9000]) {
  test(`a slower source monitor (${period}ms) aligns with independently advancing parent monitors`, () => {
    const r = run({ mode: "asymmetric", periods: [period, 1000, 1000], costs: [100, 1500, 1500] });
    assert.equal(r.status, 0, JSON.stringify(r));
    assert.equal(r.reserve_status, 0, JSON.stringify(r));
    assert.ok(r.clock < 30000, JSON.stringify(r));
  });
}

test("healthy one-second counters remain observable across a six-second signed audit round", () => {
  const r = run({ mode: "fast", fullCost: 2000 });
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.equal(r.reserve_status, 0, JSON.stringify(r));
  assert.ok(r.clock < 30000, JSON.stringify(r));
});

test("stopped counters fail at the original 30-second deadline without renewed authority", () => {
  const r = run({ mode: "stalled" });
  assert.equal(r.status, 1);
  assert.ok(r.clock >= 30000 && r.clock < 33100, JSON.stringify(r));
  assert.equal(r.progress, "7,7,7");
  assert.ok(r.bounds.split(",").map(Number).every(bound => bound < 6000), "stalled progress was not redated after it stopped");
  assert.match(r.diagnostic, /^guard-refresh-timeout:\d+:-?\d+:counter:\d+:age-ms:\d+:observation-ms:\d+$/);
});

for (const fault of ["sample-read", "sample-regression", "stopped-source"]) {
  test(`${fault} cannot grant launch authority through intermediate observations`, () => {
    const r = run({ mode: "fast", fullCost: 2000, fault });
    assert.equal(r.status, 1, JSON.stringify(r));
    if (fault === "stopped-source") {
      assert.match(r.diagnostic, /^guard-refresh-timeout:/);
      assert.equal(r.bounds.split(",")[0], "0", "unchanged source progress has no newer causal bound");
    } else {
      assert.match(r.diagnostic, /^guard-progress-(read|regression):/);
      assert.ok(r.full_audits < 6);
    }
  });
}

test("persistent observation cost cannot extend startup or grant an unsafe launch", () => {
  const r = run({ mode: "persistent" });
  assert.equal(r.status, 1);
  assert.ok(r.clock >= 30000 && r.clock < 41000, JSON.stringify(r));
  assert.equal(r.reserve_status, 1);
  assert.match(r.diagnostic, /^guard-stale:0:counter:\d+:age-ms:\d+:observation-ms:\d+$/);
});

for (const fault of ["identity", "process", "failure-marker", "hash", "read", "regression"]) {
  test(`${fault} fails immediately rather than realigning`, () => {
    const r = run({ fault });
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.full_audits, 6);
    assert.ok(r.clock < 16500);
    assert.notEqual(r.kind, "stale");
  });
}

test("a newly failed full audit after a temporal stale remains fatal", () => {
  const r = run({ fault: "audit-after-realignment" });
  assert.equal(r.status, 1);
  assert.equal(r.full_audits, 7);
});

test("lost Lease is fatal without retry", () => {
  const r = run({ mode: "fast", fault: "lease", lease: 1 });
  assert.equal(r.status, 1);
  assert.equal(r.lease_reads, 1);
  assert.equal(r.full_audits, 6);
  assert.equal(r.diagnostic, "lease-check");
});

test("successful realignment still pays for Lease read, continuity and cancellation reserve", () => {
  const r = run({ lease: 1 });
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.equal(r.lease_reads, 1);
  assert.equal(r.reserve_status, 0);
  assert.ok(r.remaining > 2000);
  assert.ok(r.clock < 30000);
});

test("staleness in the SECOND continuity check requires another full audit and Lease read", () => {
  const r = run({ mode: "lease-transient", lease: 1 });
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.equal(r.lease_reads, 2);
  assert.ok(r.full_audits > 6);
  assert.equal(r.reserve_status, 0);
  assert.ok(r.clock < 30000);
});

test("a read error after the Lease cannot be mistaken for temporal stale", () => {
  const r = run({ mode: "fast", fault: "read-after-lease", lease: 1 });
  assert.equal(r.status, 1);
  assert.equal(r.lease_reads, 1);
  assert.equal(r.full_audits, 6);
  assert.equal(r.kind, "error");
  assert.equal(r.diagnostic, "guard-progress-read:0");
});

test("the existing cancellation guard rejects exactly 2000ms and accepts 2001ms", () => {
  const boundary = run({ phase: "reserve-boundary" });
  assert.equal(boundary.remaining, 2000);
  assert.equal(boundary.reserve_status, 1);
  const above = run({ phase: "reserve-above" });
  assert.equal(above.remaining, 2001);
  assert.equal(above.reserve_status, 0);
});

for (const phase of ["running", "closed-flag"]) {
  test(`${phase} cannot opt into temporal realignment`, () => {
    const r = run({ phase });
    assert.equal(r.status, 1);
    assert.equal(r.clock, 16500, "same pre-change fail-close at the first stale observation");
    assert.equal(r.full_audits, 6);
    assert.match(r.diagnostic, /^guard-stale:0:counter:10:age-ms:12500:observation-ms:9500$/);
  });
}

test("post-stream refresh never rearms a stale guard", () => {
  const r = run({ phase: "post", fullCost: 2000 });
  assert.equal(r.status, 1);
  assert.equal(r.clock, 12000);
  assert.equal(r.full_audits, 6);
  assert.equal(r.continuity_checks, 0);
});

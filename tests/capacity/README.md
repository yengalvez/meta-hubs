# YenHubs capacity harness

This Node 22 harness creates bounded, reproducible capacity plans and validates
strict evidence without making a capacity claim. It does not open a target,
launch a browser, execute a load driver, provision rooms or create cloud
resources. Physical execution is deliberately disabled until YenHubs has a
reviewed driver, an OS/network sandbox and destination enforcement independent
of driver self-reporting.

`meta-hubs.org` and every subdomain remain denied planning targets. Remote plans
must use HTTPS and an explicit `staging`, `test`, `qa`, `preview`, `sandbox` or
`dev` hostname marker. There is no default target.

## Reproducible local checks

```bash
npm ci
npm test
npm run validate
npm run plan -- --scenario local-smoke --target http://localhost:4000/test-room --bots 0
npm run run -- --scenario local-smoke --target http://localhost:4000/test-room --bots 0
npm run model -- --scenario total-10000-model --bots 0 --input examples/model-input.json
npm run report -- --scenario local-smoke --target http://localhost:4000/test-room --bots 0 \
  --run-id 11111111-1111-4111-8111-111111111111 \
  --issued-at 2026-07-17T09:55:00.000Z \
  --evidence examples/evidence-passing.json
```

Both `plan` and `run` are non-executing. Each plan contains:

- a deterministic configuration `planId` and workload seed;
- a unique run UUID, issue time and one-hour start deadline;
- `executionEnabled: false`;
- exact room, worker and participant ranges;
- linear ramp-up, full-concurrency plateau and graceful ramp-down durations;
- a bounded waypoint-movement profile and explicit synthetic media profile;
- Node, browser-profile and future driver-protocol requirements.

Supplying `--execute`, `--driver` or the former acknowledgement option fails
with `PHYSICAL_EXECUTION_DISABLED`. No code path invokes `kubectl` or an
arbitrary executable.

## Evidence contract

The example is a schema fixture, not an observed result. A completed evidence
file must repeat the saved plan's run UUID and issue time and include one common
run window whose duration exactly matches the scenario. The start must fall
before the plan deadline. Driver identity is a safe slug, semantic version,
SHA-256, protocol and Node 22 version; browser identity is Chromium version plus
the planned profile.

Every collector must:

- use the same run UUID, start and end;
- cover the complete run;
- meet the checked-in maximum sampling interval;
- use the exact closed schema and required collector set.

Room evidence is path-sensitive, not merely origin-sensitive. Every planned
room must report its exact final URL, exact unique population, full plateau
peak, plateau duration, sample count and participant-seconds. Every worker must
report the exact run-scoped participant IDs assigned by the plan. IDs must be
unique across all workers and rooms. This prevents a single healthy room from
standing in for the twelve-room 300-participant scenario.

Lobby and in-room phases are separate closed records. The in-room phase must
reach every participant and contain at least the complete planned plateau.
Metric keys are exact; ratios are restricted to `0..1`, counts are non-negative
integers and time/FPS values are non-negative. Sustained evidence cannot exceed
the run duration.

Unknown fields are rejected rather than copied to output. Driver free text is
never part of a report; failed evidence uses an allowlisted failure code and the
report returns a generic reason. This is the primary secret-safety boundary,
not heuristic redaction.

## Future NDJSON protocol

`lib/execute.mjs` is a pure protocol evaluator used by local unit tests. It does
not spawn a process. Future live samples have this closed form:

```json
{"type":"sample","runId":"11111111-1111-4111-8111-111111111111","metric":"join.failureRate","value":0,"observedAt":"2026-07-17T10:00:00.000Z"}
```

Sample timestamps must be canonical ISO values, remain inside the planned
window and never move backwards. Unknown metrics invalidate the protocol.
A final event contains only `type` and the strict evidence object. A result or
stop is terminal.

No driver should be connected to this protocol until its browser/WebRTC
behavior, destination confinement, filesystem isolation, redirect handling and
collector implementations have been independently reviewed.

## Scenario meaning

- `local-smoke`: two synthetic desktop participants; 10 s ramp, 40 s plateau,
  10 s ramp-down.
- `room-30`: one room; 120 s ramp, 660 s plateau, 120 s ramp-down.
- `room-100-experimental`: one explicitly non-certifying room; 180 s ramp,
  600 s plateau, 120 s ramp-down.
- `total-300`: twelve rooms of 25; 300 s ramp, 1,200 s plateau, 300 s
  ramp-down. The target requires a literal `{room}` placeholder.
- `total-10000-model`: model only; physical planning and execution are denied.

Each physical plan selects exactly 0, 5 or 10 bots per room. The 10,000 model
also requires one of those variants and refuses a baseline measured with a
different one. Its result always says `certified: false` and
`physicalExecutionAllowed: false`; it is an architecture model, not load-test
evidence or a purchasing recommendation.

All thresholds remain provisional. `PASSED` means only that one internally
consistent evidence set passed those provisional bounds; it is not a capacity
certification.

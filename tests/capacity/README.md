# YenHubs capacity harness

This Node 22 harness plans, executes and validates bounded YenHubs capacity
runs. It never provisions infrastructure, creates rooms, calls `kubectl` or
purchases resources. `run` is dry by default. Every result is provisional and
non-certifying: `PASSED` means that one complete measured run stayed inside the
checked-in stop criteria, not that a CCU level has been certified.

Production is hard denied. A remote run additionally needs a reviewed,
unexpired attestation whose exact target, service, collector and Coturn
allowlists are hashed into the plan and its human acknowledgement. A hostname
that merely contains `staging` is not sufficient.

The checked-in physical readiness state is currently `BLOCKED` and cannot be
used for a load run. All 39 server-side observability contracts are explicitly
`unavailable`: this repository contains no reviewed metric producers,
recording rules, scrape inventory or per-source freshness proof for them. The
remote HTTPS/authentication boundary, OS-level egress isolation, physical host
identity, cgroup termination proof, base-owned readiness policy and Reticulum
database fencing are also absent. `npm run validate` lists each missing
prerequisite and always reports `physicalExecutionAllowed: false` and
`certified: false`. Its numeric harness ceilings are safety bounds, not
measured capacity.

## Local validation and dry planning

```bash
cd tests/capacity
npm ci
npx playwright install chromium
npm test
npm run validate
npm run run -- --scenario local-smoke \
  --target http://localhost:4000/test-room --bots 0 \
  --client mobile --audio active --transport forced-turn
```

The final command is a dry run. It prints the closed, non-executable plan,
execution topology and collector requirements. It does not print a reusable
ACK: `executionEnabled`, `runId`, `issuedAt`, the full canonical scenario and
the signed environment are plan identity, so a dry plan cannot be flipped and
resealed. There is no default target and no arbitrary driver option.

## Trust, security and execution gate

Remote attestations, environment snapshots, raw-integrity claims and final
bundle manifests use Ed25519. Verification is anchored in
`trust-anchors.json`. That store is deliberately empty until the owner supplies
and reviews the public half of an offline key; there is no generated or
bootstrap key that physical execution will trust. With the checked-in empty
store every production `ack`, `worker`, `aggregate`, `run --execute` and model
load fails closed. The private key is never stored in the repository; after the
owner installs its public half, the runtime reads the private half only from a
bounded `0600` JWK file named by:

```bash
export YENHUBS_CAPACITY_SIGNING_KEY_ID=REPLACE_WITH_TRACKED_OWNER_KEY_ID
export YENHUBS_CAPACITY_SIGNING_PRIVATE_KEY_FILE=/private/offline/capacity-signing-key.jwk
```

Before the first physical run, version the public half of an owner-controlled
offline key in the empty store and review that source change. A test key exists
only in the test process and is rejected by `ack`, `worker`,
`aggregate`, `run --execute` and the model loader. Unsigned, untrusted or
rebound documents fail closed.

Trust is necessary but not sufficient. `physical-readiness.json` separately
records every required producer/rule/scrape, TLS/authentication, egress,
physical-host, process-termination and coordination artifact. A future `READY`
state must also match identities materialized outside the candidate change by
the base-owned review workflow:

```bash
export YENHUBS_CAPACITY_BASE_OWNED_POLICY_SHA256=REPLACE_WITH_BASE_POLICY_SHA256
export YENHUBS_CAPACITY_REVIEW_ATTESTATION_SHA256=REPLACE_WITH_REVIEW_ATTESTATION_SHA256
```

Filling hashes into the candidate file cannot authorize execution by itself.
Both external identities and every reviewed readiness artifact must match.

An environment snapshot and remote attestation must first be signed with the
purposes `environment-snapshot` and `remote-attestation`. The attestation binds
the exact scenario, canonical target template, `executionEnabled` bit and
signed environment SHA-256. It also lists every target, Reticulum, Dialog,
asset, collector and Coturn endpoint. All remote hosts must be explicitly
staging and labels `prod`, `production` and `live` are denied.

A single-host execution is deliberately two-step. First save an immutable
execution plan and derive its exact ACK:

```bash
npm run --silent plan -- --scenario local-smoke \
  --target https://capacity-staging.example.org/room --bots 0 \
  --client desktop --audio muted --transport direct \
  --environment /absolute/path/to/environment.json \
  --attestation /absolute/path/to/remote-attestation.json \
  --execution-enabled true > /private/path/plan.json

npm run ack -- --plan /private/path/plan.json

npm run run -- --plan /private/path/plan.json --execute \
  --ack-staging 'EXACT_TEXT_PRINTED_BY_ACK' \
  --collector-endpoint https://collector-capacity-staging.example.org/v1/capacity-sample \
  --environment /absolute/path/to/environment.json
```

The common plan validator is called by planning, reporting, the direct driver,
workers, the aggregator and the model. It recomputes `planId` and the workload
seed, checks closed schemas, totals, room and worker ranges, bot counts,
timeline arithmetic, target classification, attestation binding and host
assignments. Calling the driver directly does not bypass the exact ACK.

The browser blocks service workers and intercepts HTTP(S) and WebSocket
requests. Remote requests must
match one exact attested scheme, origin and port; loopback requests must match
the planned loopback origin and port. Production-family and deceptive hosts
such as `dev.meta-hubs.org.evil.example` remain denied.
This is application-layer browser confinement only. It is not host or pod
egress isolation, so physical execution remains blocked until a separately
reviewed OS/network policy and attestation exist.

Before constructing each real `RTCPeerConnection`, the init script compares
every configured ICE URL with the signed Coturn allowlist. A forced-TURN run
also requires a non-empty list. The exact observed URLs are preserved as raw
profile evidence. Coturn attestation URLs are credential-free `stun:`,
`stuns:`, `turn:` or `turns:` values. Only TURN URLs may contain
`?transport=udp` or `?transport=tcp`; usernames, passwords and other query
channels are rejected. Forced-TURN requires at least one attested TURN URL.

The environment snapshot is closed metadata, not free text. It records Hubs
and Hubs Cloud commits, image digests, scene, region, node SKU/count, service
replicas and the collector mapping SHA-256. The completed bundle binds it to
the plan, driver, package lock, execution config and active mapping. Never put
secrets in this file.
`examples/environment.example.json` and
`examples/remote-attestation.example.json` are deliberately invalid fill-in
templates. Replace every placeholder from the actual staging inventory and
sign the completed unsigned object. Never put credentials or private key
material in either document.
Because `BotRunnerLease` is process-local, the snapshot currently requires
exactly one Reticulum replica. That singleton is a safety constraint, not
capacity evidence. Reticulum must not scale beyond one until lease arbitration
and fencing are database-backed and independently reviewed.

## Browser and workload semantics

Workers are logical shards of at most ten participants. One generator launches
one pre-measurement Chromium process and at most 30 isolated contexts; larger
plans are assigned reproducibly across hosts. Contexts perform the real
Hubs lobby/name/room flow, prove the final URL and Hubs/NAF/AFRAME readiness,
hold the complete plateau, apply bounded movement every 30 seconds and prove
avatar-rig displacement before a graceful ramp-down.

Profiles are measured dimensions:

- `desktop` uses a 1280x720 desktop Chromium context;
- `mobile` is Chromium mobile emulation (390x844, mobile user agent, touch and
  mobile context semantics), not a claim about physical handset performance;
- `active` requires a shared, enabled, live fake-device audio track; `muted`
  requires Hubs' authoritative microphone state to remain disabled;
- `forced-turn` installs `iceTransportPolicy: relay` before application code
  and requires selected relay candidates; `direct` requires non-relay
  candidates.

Desktop and mobile emulation, muted and active audio, and direct and forced-TURN
must be modelled separately. Their capacity and generator costs are not
interchangeable.

Each participant has a complete interval series during the plateau. A run with
300 declared participants but samples from only one participant is invalid.
Lobby join/leave and room join/leave are timestamped events; peaks and
participant-seconds are recomputed from interval overlap rather than trusted
counters. Bot state is also a full timeline. The `0` bot variant still requires
observed desired/active/authenticated/spawn-ACK/navmesh-ready zeros for every
room and interval.

## Distributed workers and aggregator

The `host-001` style assignments in a plan are logical shard identifiers, not
by themselves proof of distinct machines. Every completed worker must also
write `generator-inventory.json`, bound to the exact plan/run/host, with a
unique machine ID, boot ID, dedicated run-namespaced cgroup/root PID and a
post-STOP `cgroup.procs` snapshot with zero members besides the driver root and
zero browser processes. Shard
aggregation requires the exact planned host set, and the final model loader
revalidates the signed inventory. The commands below remain protocol examples
and will not pass the physical readiness gate until the external host and
policy prerequisites are independently reviewed. Summed `ps` RSS and `%CPU`
do not provide that proof.

For a distributed plan, create one shared execution-enabled plan, derive its
ACK, schedule one common future start, choose one file on storage shared by all
generators for terminal STOP control, and run every planned host:

```bash
npm run --silent plan -- --scenario total-300 \
  --target 'https://capacity-staging.example.org/{room}' --bots 0 \
  --environment /private/path/environment.json \
  --attestation /absolute/path/to/remote-attestation.json \
  --execution-enabled true > /private/path/plan.json

npm run ack -- --plan /private/path/plan.json

npm run worker -- --plan /private/path/plan.json \
  --worker-host host-001 --start-at 2026-07-17T12:00:00.000Z \
  --ack-staging 'EXACT_PLAN_ACK' \
  --collector-endpoint https://collector-capacity-staging.example.org/v1/capacity-sample \
  --environment /private/path/environment.json \
  --stop-control /shared/capacity/STOP.json
```

Repeat `worker` for every host in `executionTopology.hosts`. Only `host-001`
queries the server collector; other shards contain their browser and generator
evidence. Each worker writes a hash-bound shard manifest. A worker STOP exits
with status 3, atomically publishes the exact plan/run/host terminal state to
the shared STOP file and writes a signed forensic bundle. Every peer polls that
file at least once per second, including while waiting at the start barrier,
aborts its active work and writes its own signed partial bundle. A malformed or
rebound STOP file fails closed. The control file must not exist before the run.

The shard-list file is closed and every entry is a strict relative path under
its own directory:

```json
{
  "schemaVersion": 1,
  "planId": "plan-REPLACE",
  "shards": [
    "host-001/manifest.json",
    "host-002/manifest.json"
  ]
}
```

Aggregate only after every planned worker succeeds:

```bash
npm run aggregate -- --plan /private/path/plan.json \
  --shards /private/path/shards.json --ack-staging 'EXACT_PLAN_ACK' \
  --collector-endpoint https://collector-capacity-staging.example.org/v1/capacity-sample \
  --environment /private/path/environment.json \
  --output /private/path/aggregate
```

The aggregator rejects missing, duplicate, rebound or tampered shards, mixed
run/browser/driver/lockfile/environment identities, fixture sources and more
than one server-collector leader. Absolute paths, `..`, empty segments and any
ancestor symlink under the shard root are rejected after realpath containment.
It enforces one incremental global envelope of 500,000 samples and 256 MiB
before retaining shard data, then merges the bounded raw samples and runs the
same report validator used by a single host.

## Prometheus collector adapter

`bin/capacity-collector.mjs` now uses the same strict multiseries semantic path
covered by the harness tests, but production startup fails with
`OBSERVABILITY_UNAVAILABLE` before opening a socket. The names and raw selectors
in `lib/collector-contract.mjs` are reserved mapping scaffolding only: no
matching exporters, recording rules or scrape configuration exist in the
tracked project, so they are not evidence sources. This diagnostic command
cannot currently collect a physical run:

```bash
npm run collector -- --config /absolute/path/to/capacity-collector.json
```

`lib/observability-contract.mjs` instead records the semantics that real
instrumentation must satisfy for all 39 server metrics. Counters require raw
per-entity counters, explicit reset evidence, exact inventory and a run-scoped
interval. Histograms require previous/current cumulative buckets and reset
proof, then calculate quantiles from interval bucket deltas. Ratios likewise
use previous/current numerator and denominator counters, reject a reset in
either component and weight their interval deltas. Node/pod utilization and
bot state retain physical entity identity; a single aggregate cannot stand in
for multiple replicas. Each authoritative bot state uses the same ten-slot
`bot_id` namespace, every identity is binary, and exactly `bot-001..N` must be
desired, active, authenticated, spawn-acknowledged and navmesh-ready at every
tick. A zero-bot appearance histogram records honest zero bucket deltas and is
accepted as an explicitly empty interval only for a planned zero-bot room.

The implemented adapter accepts every series in the hash-bound inventory and
rejects missing, extra, duplicate or churned entities. It pairs value queries
with separate source-timestamp queries; derives interval deltas from raw
counters plus `resets(...)`; chains every entity's next baseline exactly to its
preceding timestamp and values; aggregates histogram deltas before calculating
P95; and computes ratios from counter deltas. Raw Prometheus `__name__` and
room labels are validated against the exact selector before being removed from
the canonical entity identity. The
timestamp attached to a Prometheus instant-expression result is evaluation
time and is deliberately not treated as scrape freshness. Source timestamps
must be fresh, advance independently per entity and fall inside the signed run
window. PromQL range selectors are left-open, so reset queries add one
millisecond to include the canonical millisecond baseline; the tracked reset
policy must pin and review the deployed Prometheus version and these query
semantics. A zero-width baseline runs no retrospective reset query. The driver
does not request server evidence at offset zero. Its first interval still
requires an exact run-bound baseline at or after `run.startedAt`; a normal
pre-run scrape is rejected rather than contaminating the signed window. No
producer or handshake currently supplies that boundary, so
`prometheus-run-bound-baseline-not-tracked` remains an explicit readiness
blocker. Because no reviewed external continuity source can reconstruct
increments hidden by a reset, any positive reset count, counter decrease,
inventory churn or pre-run window fails closed. These semantics do not make
the placeholder sources available or bypass readiness.

Physical readiness additionally requires tracked producer, rule, scrape and
inventory manifests; a reviewed HTTPS deployment; TLS and authentication;
and host-level egress isolation. Until those artifacts and the base-owned
review attestation exist, changing candidate mappings or supplying a
self-computed hash leaves every server metric `unavailable`.

## Measurements, raw provenance and STOP

The closed metric catalogue includes participant FPS, join timing, console
errors/warnings, request failures, HTTP error statuses, concurrent WebSockets,
client receive/send traffic, WebRTC packet loss/RTT/audio, authoritative avatar
network-update gaps, Reticulum, load balancer latency/rate/errors, Kubernetes
and pod limits, PostgreSQL, Coturn allocation/relay/traffic, Dialog
saturation/lag/errors/traffic, bots and generator CPU/memory/RSS/event-loop lag
plus total/browser process counts.

`avatar.networkUpdateGapP95Ms` uses the ECS `Networked.timestamp` for the
remote entity or the bot-transform `_lastReceivedAt` receive timestamp. It
never uses ownership time and is not RTP jitter relabelled as synchronization.
The legacy local sampler derives generator CPU/RSS and process counts from a
`ps` descendant snapshot rooted at the worker PID. That is insufficient for a
physical run: `%CPU` is not a run-scoped cgroup counter, RSS can double-count
shared pages, and a snapshot cannot prove that STOP killed every descendant.
The bundle path now requires a machine/boot/cgroup/root-PID inventory and
zero-process post-STOP verification, but physical generator metrics remain
blocked pending reviewed cgroup accounting and external host attestation. Every
threshold aggregate
is recomputed from canonical NDJSON with its closed aggregation. Sample source,
dimensions (including phase), timestamps and deterministic ID are validated.
Every measurement kind requires an original source timestamp inside the exact
signed run. The Prometheus path additionally requires the semantic proof and
exact entity inventory; an instant-query evaluation timestamp alone is not
accepted as physical evidence.

Error, failure, drop, deadlock, OOM, eviction, restart and worker-death metrics
are specified as raw counters plus explicit reset series. No tracked producer
currently supplies them. A future collector must derive conservative deltas
per exact entity and run window; every reset invalidates the run until a
separately reviewed monotonic continuity source can reconstruct the exact
interval. It may not hide pod churn or infer correctness from `increase(...)`
alone.

Client traffic is an observed lower bound, not packet-capture accounting.
Incoming bytes combine Resource Timing transfer/body sizes, WebSocket message
payloads and RTC inbound/data-channel counters; outgoing bytes combine
fetch/XHR bodies, WebSocket payloads and RTC outbound/data-channel counters.
Browser-hidden protocol/TLS headers, cache entries with unavailable transfer
sizes and cross-origin bodies without Resource Timing exposure are not
invented. Interpret these metrics only with that limitation.

Phase labels are recomputed from `run.startedAt` and the signed ramp/plateau/
ramp-down windows. Client/WebRTC interval metrics cover the complete plateau
with the exact timestamp series for every participant; they do not claim ramp-
down telemetry. Each join failure/latency metric has exactly one observation
for every planned participant and its room/worker identity. Those batched join
observations use the exact signed plateau-start timestamp (zero timestamp
tolerance); the separate phase events preserve each real lobby/room handoff.
The evidence schema requires server/Kubernetes intervals across the complete
run, bot intervals for every room and generator intervals for every attested
physical host. The current repository has no physical server producer or host
attestation capable of satisfying those requirements. Missing,
duplicate, shifted or relabelled samples are invalid.

The first immediate or sustained threshold breach aborts the local worker,
rejects trailing samples, exits 3 and preserves partial artifacts. `report`
also exits 3 when validated evidence produces `STOPPED`. Invalid input exits 2;
unexpected execution failure exits 1.

A successful single-host or aggregated run writes:

- `plan.json`;
- `raw.ndjson`;
- `evidence.json`;
- `report.json`;
- `environment.json`;
- `execution-config.json`;
- `package-lock.json` snapshot;
- `collector-config.json` with the complete reviewed mapping and queries;
- `generator-inventory.json` with the exact machine/boot/cgroup/root identity
  and zero-orphan post-STOP proof for every planned host;
- `harness-tree.json` with every production `bin/`, `lib/` and tracked config
  path, byte count and hash;
- `manifest.json` with SHA-256 and byte count for every artifact plus the
  driver, lockfile, config, attestation, environment and mapping identities.

`raw.ndjson` has its own signed integrity claim and the schema-version-4 final
manifest signs all ten artifact claims, including the generator inventory.
STOP and unexpected collector/browser failures also
write signed, nonempty-status forensic manifests and exit nonzero. Artifact
paths and NDJSON line/file sizes are bounded.

The ignored output tree is private operational evidence. Schemas reject secret
channels, but do not publish or commit these bundles.

## Offline reports and the 10,000-participant model

`report` rebuilds the exact plan and validates saved evidence. Unknown fields,
self-declared aggregates, incomplete participant or join series, partial
global-counter timelines, missing bot-room timelines, counter-only phase claims
and stale/replayed server samples fail closed.

```bash
npm run report -- --plan /private/path/plan.json \
  --evidence /private/path/evidence.json \
  --raw /private/path/raw.ndjson
```

The `total-10000-model` scenario never executes clients. Its schema-version-3
input references complete physical bundle manifests, not standalone reports:

```bash
npm run model -- --scenario total-10000-model --bots 0 \
  --input /absolute/path/to/model-manifest.json
```

`examples/model-manifest.example.json` is the relative-path skeleton for this
input; copy it beside a private `bundles/` tree and replace every placeholder.

For every source, the loader streams and hashes the bounded raw artifact,
hashes all ten artifacts, rejects traversal and every ancestor symlink,
verifies production Ed25519 manifest/raw signatures and the exact current
harness tree, requires the checked-in Playwright driver and an attested remote
plan, revalidates the exact signed generator inventory and zero-orphan proof,
and reconstructs `report.json` from `plan.json`, `raw.ndjson` and
`evidence.json`. Bundles are loaded sequentially and raw arrays are discarded
after reconstruction. A fixture driver, test signer or fixture raw source is
not model evidence.

Reports must be `PASSED`, no older than 30 days, and use one bot variant, one
exact client/runtime/audio/transport profile and one signed deployment/node
topology. Evidence needs at least two repetitions of each of these three
physical levels: `room-30`, `room-100-experimental` and `total-300`. CPU and
memory use are fitted with participants and rooms as separate predictors; the
input therefore also needs a repeated crossed participants-by-rooms factorial
design, not three confounded points. Each target dimension is limited to 3x
the largest measured value, and each fit must have R² at least 0.8. Observed
node CPU/memory and total used resources must agree with the signed node
SKU/count and the real DigitalOcean SKU identifiers (`s-2vcpu-4gb`,
`s-4vcpu-8gb`, `s-8vcpu-16gb`) in the dated catalogue.

The existing 30/100/300 design is not factorial and extrapolates roughly 33x
in both participants and room count. In addition, 10,000-participant topology
work would require Reticulum horizontal scaling, which is prohibited while
`BotRunnerLease` remains process-local. Consequently the current model returns
`state: INSUFFICIENT` and emits no fit, node count or cost range. It cannot emit
actionable output until crossed measurements remain within 3x and a reviewed
database arbitration/fencing policy exists. A future successful model would
still return `certified: false` and `physicalExecutionAllowed: false`.

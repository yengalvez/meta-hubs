# Native runtime samples (opt-in)

These opt-in tests use **synthetic data**, not a checkpoint or the public DB.
They do not create cloud resources or switch a public installation's profile.
The existing `PRODUCT_MODULES` implementation/schema remains authoritative.

Portable safety checks (also registered in local/CI security):

```sh
node --test tests/runtime/reticulum-local.test.mjs
node --test tests/runtime/bot-transport-local.test.mjs
```

On the verified macOS host, with the existing pinned tools/cache, run from the
candidate root, **not** the dirty historical root. First method sample:

```sh
node tests/runtime/reticulum-local.mjs --run \
  --pg-bin /opt/homebrew/opt/postgresql@14/bin \
  --cache-reticulum /Users/Shared/Gits/YenHubs/output/product-fixes-20260926/hubs-cloud/community-edition/services/reticulum
```

Use `--profiles` instead of `--run` for the six independent, sequential
OS/BEAM starts: BASE, BASE+Avaturn, bots, bots+Avaturn, bots+IA, full.
Do not rerun the five existing tests separately once the method is accepted.
The profile chain stops at its first failure; no parallel server/auto-retry.

For the distinct live creator-capability message, use `--avaturn-runtime`:
it selects exactly five new tagged cases from ProductModules, AppConfig and
HubChannel, with zero failures/skips and exact excluded counts. It exercises
current SQL flags, the initial channel snapshot and updates, not a browser or
provider. On this host use the matching existing dependency cache:

```sh
node tests/runtime/reticulum-local.mjs --avaturn-runtime \
  --pg-bin /opt/homebrew/opt/postgresql@14/bin \
  --cache-reticulum /Users/yengalvez/.codex/worktrees/reliability-20261001/YenHubs/hubs-cloud/community-edition/services/reticulum
```

Do not replay `--run` or `--profiles` for this delta. The historical `--run`
still selects its five original cases, explicitly excluding the two new tagged
ProductModules cases (seven total, two excluded, no skips).

For one distinct browser consumer, build the current RoomSettings/HubChannel
canary with the existing Hubs webpack toolchain, then serve its returned private
scratch separately:

```sh
node tests/runtime/profile-ui-browser.mjs build
node tests/runtime/profile-ui-browser.mjs serve <scratch-from-build-receipt>
```

Open the returned127.0.0.1 URL in the internal browser. BASE must hide bot/chat
controls, BOTS+IA must expose them, and returning to BASE must hide them without
remounting the form or losing an edited room name. The three accessible buttons
deliver the existing event through an unconnected real Phoenix channel. Build
and artifact hashes bind the frozen Hubs source; compilation is NOT browser
acceptance. No SQL/socket/provider/scene or other UI consumer is covered. The
loopback server uses no proxy, rejects writes and closes with SIGINT/SIGTERM,
recording STOPPED; do not leave it running after the browser check.

For the separate SQL→PubSub→real Phoenix→RoomSettings observation, freeze the
candidate root and both submodules first. Use the same native runner with an
explicit existing Hex archive (no installer/network in this mode):

```sh
node tests/runtime/reticulum-local.mjs --profile-ui-socket \
  --pg-bin /opt/homebrew/opt/postgresql@14/bin \
  --cache-reticulum <matching-existing-Reticulum-cache> \
  --browser-origin http://127.0.0.1:18443 \
  --hex-cache <verified-existing-hex-2.5.1-archive>
```

Keep its stdin handle open. After `RET_UI_SOCKET` READY, use only the returned
private bootstrap path (never print its JSON/JWT). Build and serve separately:

```sh
node tests/runtime/profile-ui-browser.mjs build --bootstrap <private-bootstrap-path>
node tests/runtime/profile-ui-browser.mjs serve <scratch-from-build-receipt> --port 18443
```

Open `http://127.0.0.1:18443/` in the internal browser. Require valid JOINED,
invalid-token and missing-token DENIED on separate real sockets, and initial BASE controls hidden.
Edit the room name and retain a reference to the mounted form. Write these exact
JSON lines to the **native runner stdin handle**, one at a time after observing
each browser result; the browser has no profile-transition buttons:

```json
{"command":"BOTS_AI"}
{"command":"BASE"}
```

`SQL_APPLIED` confirms committed boolean object wrappers, not the browser result.
Observe bot/chat controls appearing then disappearing without losing the name
or form identity. Send BOTS_AI once more, observe ON, then use “Cerrar socket
real”; require controls hidden after the real disconnect (no fabricated event).
Stop the static server with SIGINT/SIGTERM and write `{"command":"STOP"}` to
the native handle. Require its OBSERVATION_STOPPED receipt, Endpoint/BEAM PID
absence and owned PG cleanup. EOF, interruption, malformed input or the five
minute observation deadline fails; no observation path emits PASS. Retain the
private diagnostic scratch on failures; do not print raw logs/bootstrap/bundle.

This covers one local account/sala (`scene:nil`), required-account join denial,
production AppConfig setters and transport, with synthetic RoomSettings data and
disabled submit. It does not cover Avaturn, scene/WebRTC, raw-SQL periodic
detection, six profiles, providers, public deployment or final acceptance.

For the distinct existing chat-delivery boundary, use `--chat-canary`: it runs
only the chat-OFF-during-response case plus the positive delivery/fence control.
After that method sample passes, `--chat-boundaries` runs only the other five
cases (presence loss, bots OFF, module absent, OFF→ON and quarantine). Neither
mode reruns the accepted six profiles. Selection uses exact ExUnit test names;
missing/duplicated cases, skips, failures or unexpected excluded counts fail.
The interruption oracle also requires the provider test client to receive the
request; an early HTTP403 alone is not proof of an in-flight boundary.

The separate `--chat-concurrent` canary has two NEW tests: a held synthetic
reply delivered with the current fence, and a real concurrent SQL chat-OFF
transaction that must finish before that reply is released. Its distinct
`--chat-concurrent-boundaries` mode runs only four additional cases: bots OFF,
OFF→ON, quarantine and lost presence. It does not rerun the canary, synchronous
tests or profiles. Both modes require exact test totals, no exclusions/skips.

These concurrent tests deliberately do NOT use a shared SQL sandbox transaction:
fixtures commit to this owned disposable database, and request/transition tasks
check out separate SQL connections. Backend PIDs must be different. A separate
connection takes/releases the admission advisory lock while the reply is held;
the transition completes, persisted state/revision/notification is checked,
and the request is still pending before the release. Only then may the control
deliver200 with the current fence, or the stale reply reject403 with its exact
reason and no command. Tasks, gates and waits are owned/reference-bound/bounded.
Never require this test file on the normal/default DB or a public target.

For the distinct cached-configuration boundary, `--config-cache-canary` runs
only two NEW cases: warm ON/general-cache control and immediately committed AI
OFF with the old raw ON cache still present. They exercise authenticated API
routing and the actual page-config serializer with skip_cache=false. Data
commits only to this owned synthetic cluster; no TCP/browser/provider claim.
Unknown modes fail before creating a target. It does not repeat previous chat
cases or profiles. After the method passes, `--config-cache-boundaries` selects
ONLY four normal tests from `test/ret/app_config_test.exs`, by exact unique
names, requiring5total/1excluded/0skips/failures and4/4 result. The original
shape test is not replayed. Late stale cache fill, bots/creator OFF, ON with raw
OFF, malformed/absent flags and BASE remain distinct affected cases. Caller
telemetry requires one SQL query with exactly the three flag keys; other cached
config remains warm. They do not prove browser invalidation, all live profiles,
STOP or Kubernetes, and cannot replace the final exact full gate.
For a change only to the malformed/absent oracle, `--config-cache-types` selects
that exact named test alone, requiring5total/4excluded/0skips/failures and1/1.
Keep bots ON during the malformed-chat check so its dependency cannot hide an
incorrect truthy conversion; cover absent bots separately. Do not replay the
other accepted cases after a test-only refinement.

For the distinct mounted-client boundary, the two ordinary AVA cases in
`hubs/test/unit/react-components/use-bot-chat-request.test.js` select these
exact titles: `actual Phoenix modules control delivers in mounted hook` and
`actual Phoenix modules OFF aborts held reply before re-enable`. They use
actual HubChannel/Phoenix dispatch plus the mounted hook, never connecting or
joining the socket. The positive proves reply/action-notice delivery; the
negative holds a synthetic reply through OFF→ON, requires abort/epoch changes,
no old reply/notice and a valid new send. The parent sendingDisabled prop and
request transport remain explicit seams: NOT full UIRoot/SQL→HTTP/Presence or
browser/movement acceptance. Normal AVA already includes this file; do not
replay the three pre-existing fake-channel tests for an unchanged boundary.
On this verified host, the existing F Node dependency cache can resolve via
NODE_PATH only after package/lock/Babel/shim equality; use private HOME/TMP,
`--no-cache`, BABEL_DISABLE_CACHE=1 and OS deny-network. Do not install modules
or create a shared node_modules symlink. See [terminal evidence and limits](../../DOC/fiabilidad-ui-canal-2026-10-01.md).

## Isolation and ownership

The runner checks cache lock/config against this source, copies tracked current
Reticulum source and dependency artifacts into a fresh 0700 scratch, and does
not reuse the candidate's compiled Reticulum. Tool versions are deliberately
the project's OTP27.3.4.14/Elixir1.18.4-otp-27 and existing native PG14.23.
Do not install/change a global toolchain or assume another host has this target.
Hex stays at 2.5.1 using Mix's official signed-CSV/SHA512 installer in this
private Mix home; only that preparation phase has installer network access,
before PG/app start. No user Mix/Hex configuration or provider credentials.
The new `--profile-ui-socket` branch instead requires the already materialized
archive: owner/type/version and its pinned 133-file manifest are checked before
scratch/PG effects, then checked again after private copying. This is artifact
identity evidence, not an attestation of the archive's original download.

Runtime network confinement uses the host's existing `sandbox-exec` (macOS
deprecated facility, **not portable CI or general filesystem isolation**).
Only the owned PG loopback port is an outbound destination; Mix can bind and
accept loopback listeners, not call arbitrary local services. The behavior
was checked with actual permitted/denied listening peers, not just string tests.

The PG target binds only 127.0.0.1, with fresh test-only SCRAM credentials,
owned Unix socket/data/PID identity and sanitized environment. Check the same
data directory/port/user inside the sandboxed VM **before** create/migrate.
No normal `mix test` alias/default `ret_test` connection is used. The name
`ret_test` exists only inside the newly owned cluster. Source/private inputs,
the active manifest and the frozen dependency cache are not mutated.

The output exposes closed stage/result markers and the private scratch path.
The 0600 receipt/raw log stay inside scratch. Never print credentials, JWTs,
full SQL/logs/config or private application values. A failed stage is not PASS.
The runner stops only its verified postmaster and checks PID file/liveness.
Keep the private scratch for reconciliation; do not purge other jobs/caches.
If the outer process disappears, reconcile its receipt/log/PID before deciding
whether anything finished. Do not infer success or duplicate the run.

## Oracles and limits

The profile test exercises actual supervisor processes, SQL feature writes,
authenticated HubChannel join/entered, ON/OFF notifications, real router chat
rejection under OFF, pending policy revision and dispatcher survival for STOP.
Avaturn is independent of bots, and administrator flags cannot exceed installed
capabilities. Each installed profile starts in a fresh VM, not an env swap in a
surviving supervisor. Dialog has an inert test host plus tracked selector weights.

The focused chat cases prove actual controller/SQL/fence rejection and positive
delivery with a synchronous test HTTP client. They are not concurrent sockets,
provider replies or an abort of an outbound network request.
The held-reply cases additionally prove concurrent, committed SQL invalidation
across distinct connections. Their provider callback is still synthetic, not a
real socket, transport cancellation, cached HTTP configuration or browser.

It does **not** prove cached public config/UI changes, real Dialog/WebRTC,
provider replies, complete in-flight HTTP cancellation, bot movement, STOP
delivery, GLB/editor regressions, PG12 compatibility, Kubernetes restoration,
three full copy/restore/deploy/rollback cycles or a live release. The native
speed is not remote speed. The active Goal/plan retains all those separate
acceptance requirements and the final exact `--full` gate.

## Bot orchestrator: actual loopback HTTP cancellation

This separate macOS-only runner uses existing Node22 and the current tracked
bot-orchestrator source, not the frozen cache's application. Verify package and
lock equality before copying its existing dependencies into an owned 0700
scratch; no install or mutation of the cache. From the clean candidate root:

```sh
node tests/runtime/bot-transport-local.mjs --canary \
  --cache-bot-orchestrator /Users/Shared/Gits/YenHubs/output/product-fixes-20260926/hubs-cloud/community-edition/services/bot-orchestrator
```

That canary selects only positive delivery and IA OFF while the model response
is held. After it passes, `--boundaries` runs only four different cases: OFF
during input moderation, OFF during output moderation, OFF→ON during the model
request, and actual caller disconnect during the model request. Neither mode
reruns Reticulum SQL cases or profiles; unknown/no explicit target fails before
creating scratch, listeners or child processes. Normal CI runs only pure guards.

Each case starts a fresh owned app child. Its synthetic credentials/environment
are explicit, autostart is disabled, Reticulum's endpoint is private-test.invalid,
and existing readiness seeding is a **fixture**, not an authenticated ghost
runner. The actual Express route, native fetch and provider pipeline are not
replaced. Provider and denied-peer servers listen only on owned 127.0.0.1 ports.
The child uses sandbox-exec with outbound access to exactly the provider port;
an actual listening denied peer must receive zero connections. No public/paid
provider, Kubernetes, productive database or inherited user credentials.

The provider holds a real HTTP response until transition/release. Before the
transition, the API request must be pending and the held socket open. The
positive control completes input/model/output phases with the exact reply and
no movement action. Revocation must close the held socket with an unfinished
response, prevent any later provider phase, and return generic503/no reply.
OFF→ON cannot revive the old request. Caller disconnect must propagate to the
provider's held socket and reject the caller with AbortError. These observations
precede cleanup; a shutdown cannot supply the cancellation oracle. Product
deadlines and authority checks are unchanged.

Only owned requests, child handles, stub sockets and servers are stopped. A
PASS requires normal child exit0 and verified closed listeners for every case.
Stage/result markers are closed; raw diagnostics and terminal JSON remain0600
in scratch. Reconcile exit and exact results/cleanup, not just disappearance.
Recorded localhost milliseconds are NOT a remote latency or release SLO.
This does not prove combined Reticulum SQL→HTTP propagation, cached UI, real
runner STOP/movement, six Kubernetes installations, productive transport or
the three complete backup/restore/deploy/rollback cycles of the active Goal.

## Integrated SQL → actual HTTP canary (two NEW cases)

This opt-in mode extends the existing Reticulum runner; it does not replay
the six profiles, synthetic callback cases or separate Node HTTP tests:

```sh
node tests/runtime/reticulum-local.mjs --sql-http-canary \
  --pg-bin /opt/homebrew/opt/postgresql@14/bin \
  --cache-reticulum /Users/yengalvez/.codex/worktrees/reliability-20261001/YenHubs/hubs-cloud/community-edition/services/reticulum \
  --cache-bot-orchestrator /Users/Shared/Gits/YenHubs/output/product-fixes-20260926/hubs-cloud/community-edition/services/bot-orchestrator
```

Run only from a clean exact candidate. Both current tracked applications are
materialized in the existing owned scratch with matching dependency locks;
Reticulum is freshly compiled. Product source/locks and the cache stay intact.
The current candidate's existing Reticulum dependency cache is required on
this host: F's frozen runtime.exs predates the accepted port-binding delta
and is deliberately rejected. Do not loosen the five-file equality guard.
The new normal security guard is `node --test tests/runtime/sql-http-local.test.mjs`.

The canary joins PostgreSQL + Reticulum's real HTTPoison client + Node's actual
Express chat route/fetch + owned synthetic provider sockets. Node refreshes
capabilities using its actual authenticated HTTP GET against the running
Reticulum internal endpoint, and health is observed over real HTTP. No
callback HTTP client or direct fixture applyModuleCapabilities supplies OFF.
The positive completes the three provider phases and delivers the exact reply
without an action. The negative commits OFF in a third distinct SQL connection
while the model response is genuinely held. The raw ON config cache remains
warm. A real snapshot must propagate OFF, close the provider socket unfinished
without output moderation, and reject delivery/command before cleanup. Each
case's handshake is bounded and matched; unknown/duplicate/missing cases fail.

BEAM outbound is limited to owned PG + Node ports; Node outbound to owned
Reticulum + provider ports. Both processes probe a real denied listening peer,
which must receive zero connections. No default database, provider credentials,
global configuration, Kubernetes or public service. Verified normal child
exits and closed listeners precede the existing postmaster identity-bound stop.
Private logs/receipts remain0600 in0700 scratch, including actual source HEADs
before/after; no secret contents printed. Failure is never auto-retried.

Seams remain explicit: chat entry is authenticated ConnTest, ghost readiness
is synthetic, provider JSON is synthetic, sync scheduling is invoked explicitly,
and the SQL cluster is disposable. This is NOT a complete browser/Presence/
periodic-scheduler/runner STOP/movement/Kubernetes or six-edition acceptance,
not a deployment/backup SLO or the three representative cycles. Those separate
requirements remain in the canonical plan and the final exact full gate.

### Unobserved OFF → ON window (one NEW integrated case)

Use the same explicit inputs with `--sql-http-reentry` instead of
`--sql-http-canary`. It runs exactly one NEW case/zero exclusions or skips,
not the two accepted controls. Keep the actual provider model socket held;
chat OFF and ON must both commit on a third SQL connection before Node's
next snapshot. Verify persisted ON, both notifications, a changed policy
revision and the old warm raw ON cache while the request is still pending.
Only then call the actual authenticated HTTP sync: Node observes ON, never
the intermediate OFF, and its provider socket must still be open. Complete
the three real HTTP phases; Reticulum must reject the old reply with exact
403/reason and no command even though chat is currently enabled.

This proves stale-delivery rejection across SQL/HTTP when a revocation window
is missed. It does NOT prove that the unseen revocation cancelled a provider
socket, stopped provider work, reached the browser or was observed by the
periodic scheduler. Those remain separate boundaries, not an invented defect
or a zero-traffic claim. Same owned listeners/children/PG identity and cleanup;
no product changes, broader mode, public target, provider credentials or retry.

## Native reference catalog dataset (one NEW case)

```sh
node tests/runtime/reticulum-local.mjs --catalog-dataset \
  --pg-bin /opt/homebrew/opt/postgresql@14/bin \
  --cache-reticulum /Users/yengalvez/.codex/worktrees/reliability-20261001/YenHubs/hubs-cloud/community-edition/services/reticulum \
  --catalog-receipts /Users/Shared/Gits/YenHubs-avaturn/output/rpm-catalog-20260925/thumbnails/render-receipts.json
```

Only a clean exact root/Hubs/Cloud is eligible; sources are checked again at
completion. Explicit current dependency cache, existing PostgreSQL14 and the
approved source receipts are mandatory. All66 original files, the exact
catalog and its approved combined binding are checked without modifying them.
No install/API/prod values or avatar sync/apply is performed. Reuse the normal
importer's GLB split/material normalization only in private derived copies.
Embedded model resources only;33 unique full-body models, approved720×1280
thumbnails and seven preserved listing IDs. The26 other listing IDs follow
the existing importer's exact hash rule. Normal short guards run with
`node --test tests/runtime/catalog-dataset.test.mjs`, without starting PG.

The existing owned native runner executes exactly one new dataset case, not
profile or chat matrices. It uses current migrations/models, Storage's real
encryption/promotion/fetch and committed SQL. A distinct Postgrex connection
checks33 avatars/33 listings/99 owned pairs and their owner/file relations;
all decrypted bytes must match their bound inputs. The real AvatarView
projection uses loopback file URLs, not an actual browser/HTTP acceptance.
New local keys and full SQL remain private0600 inside0700 scratch, never in
stdout or commits. An identity-bound pg_dump is captured before the existing
normal verified stop. Original binaries/receipts and all three sources must
be unchanged. No automatic retry; reconcile first failure and cleanup first.

The output is a **PG14 synthetic catalog seed**, not the current production
backup or complete representative dataset: room/scene/Spoke ownership,
major-version runtime, restore, browser, installation, signed images and the
three Kubernetes/deploy/rollback cycles still need their own acceptance.
Do not restore this SQL into production, use it to validate an interrupted
backup, or substitute it for the coordinated installation/restore protocol.

The distinct `--catalog-graph-dataset` selector uses the same required input
arguments and owned native runner, adding room/scene/listing/Spoke relations
to the seed. It does not launch the old catalog-only target or chat/profile
matrices. Current tracked Reticulum fixtures are hash-bound: Spoke v3 with
Floor Plan and GLB with native navmesh. The GLB's one missing image URL is
replaced ONLY in a private derived copy with embedded approved PNG bytes;
geometry/BIN and original source are unchanged, no external resource allowed.
Four extra
owned encrypted files belong to a separate project/scene account (103 total).
Use normal creator-token assignment/co-owner membership; independently query
SQL links and test that room owners cannot read another account's project
and the project owner is not implicitly a room owner. Real ProjectView
projections and decrypted bytes are readbacks, not HTTP/browser acceptance.
This creates a synthetic functional graph, not the current metaverse or its
representative total volume. No restored service, signed image, latency SLO,
provider traffic, full cycle or production approval follows from that seed.

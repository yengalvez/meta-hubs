# Native Reticulum profile sample

These opt-in tests use **synthetic data**, not a checkpoint or the public DB.
They do not create cloud resources or switch a public installation's profile.
The existing `PRODUCT_MODULES` implementation/schema remains authoritative.

Portable safety checks (also registered in local/CI security):

```sh
node --test tests/runtime/reticulum-local.test.mjs
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

For the distinct existing chat-delivery boundary, use `--chat-canary`: it runs
only the chat-OFF-during-response case plus the positive delivery/fence control.
After that method sample passes, `--chat-boundaries` runs only the other five
cases (presence loss, bots OFF, module absent, OFF→ON and quarantine). Neither
mode reruns the accepted six profiles. Selection uses exact ExUnit test names;
missing/duplicated cases, skips, failures or unexpected excluded counts fail.
The interruption oracle also requires the provider test client to receive the
request; an early HTTP403 alone is not proof of an in-flight boundary.

## Isolation and ownership

The runner checks cache lock/config against this source, copies tracked current
Reticulum source and dependency artifacts into a fresh 0700 scratch, and does
not reuse the candidate's compiled Reticulum. Tool versions are deliberately
the project's OTP27.3.4.14/Elixir1.18.4-otp-27 and existing native PG14.23.
Do not install/change a global toolchain or assume another host has this target.
Hex stays at 2.5.1 using Mix's official signed-CSV/SHA512 installer in this
private Mix home; only that preparation phase has installer network access,
before PG/app start. No user Mix/Hex configuration or provider credentials.

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

It does **not** prove cached public config/UI changes, real Dialog/WebRTC,
provider replies, complete in-flight HTTP cancellation, bot movement, STOP
delivery, GLB/editor regressions, PG12 compatibility, Kubernetes restoration,
three full copy/restore/deploy/rollback cycles or a live release. The native
speed is not remote speed. The active Goal/plan retains all those separate
acceptance requirements and the final exact `--full` gate.

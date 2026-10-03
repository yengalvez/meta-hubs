# Product modules — version 1

Implementation candidate, 2026-09-26. Runtime baseline: Hubs `prod-2026-03-11`, Hubs CE `2.1.0`. This changes the installation/configuration contract, not the approved GLBs or scene format. Production acceptance is separate from local tests.

## Product surface

BASE retains Hubs, Reticulum/Presence, voice, Spoke, backup/restore, authoritative sitting, third person, manual GLB import and the 33 approved «Avatares». Optional capabilities are installation ceilings in the owner-private deployment values:

```yaml
PRODUCT_MODULES:
  schema_version: 1
  bots: false
  ai: false
  avaturn: false
  avaturn_creator_url: ""
```

Only exact YAML booleans are accepted. Missing block means BASE, unknown keys/versions/invalid types fail. `ai: true` requires `bots: true`. Avaturn is independent and requires an exact HTTPS project origin, not `demo.avaturn.dev`, paths, credentials or token queries.

| Product | bots | ai | avaturn |
| --- | --- | --- | --- |
| Base | false | false | false |
| Base + creator | false | false | true |
| Ambient characters | true | false | false |
| Ambient characters + creator | true | false | true |
| Characters with AI | true | true | false |
| All extras | true | true | true |

Static or moving characters use the existing per-room `mobility` setting. Static does not imply AI OFF: an unmoving character can speak. Patrols use published Spoke `spawbot-*` points on a published Floor Plan/navmesh; they are scene authoring data, not a request for new server workers. Room count and per-room limits remain bounded.

## What OFF means

- Installed bots OFF: parent replicas zero, no runner creation or Reticulum bot-only supervisors/dispatchers, no bot admissions/discovery/chat. Existing room configuration and Spoke objects remain editable data. Base Endpoint/Presence and sitting are retained.
- Installed AI OFF: no OpenAI key in generated `configs` or parent env; no provider requests or chat UI. Enabled bots can continue moving without AI.
- Installed Avaturn OFF: no creator UI/link/SDK load or allowed Avaturn frame origin. Already-imported provider-neutral GLBs still work.
- The durable control-plane objects/RBAC and inert guard objects are retained for recovery. OFF is not a security boundary against a cluster administrator, and does not reduce a fixed DigitalOcean machine invoice by itself.

Admin runtime feature flags can only reduce installed capabilities. They cannot enable a module omitted from the installation. A runtime pause keeps the STOP dispatcher available to drain commands; use a regenerated installed-OFF profile for complete removal of dedicated processes. This distinction must be explained to an operator.

Canonical Admin changes use `Ret.AppConfig.set_config_value`; bypass SQL/PostgREST edits do not produce the module revision event. The client receives effective capabilities at join/rejoin and when changed. The UI explicitly says «Hablar con IA», requires an eligible nearby bot, clears history/cancels pending UI work on revoke and stops its proximity timer while unavailable. A request already accepted by the provider can run until the existing bounded deadline; OFF cannot undo usage already incurred.

### Current runtime flags are not general cached configuration

The API/admin JSON and page `window.APP_CONFIG` projection must not advertise a
cached ON after a runtime OFF has committed. Reticulum retains its general
branding/config cache, but `AppConfig.get_config(false)` overlays ONLY the
three runtime flags from one fresh SQL query/snapshot before the existing
installed-capability projection. Missing/non-boolean values remain OFF; AI
still requires bots, and no SQL flag can install an omitted capability.
`get_config(true)` already reads the source rows and keeps its existing path.
No cache clear, TTL wait or process-local invalidation is an authority proof:
another reader may fill the raw cache with an older snapshot after the write.

Upstream baseline remains Hubs CE2.1.0. Core surface:
`services/reticulum/lib/ret/app_config.ex`, its existing JSON/page callers and
`test/ret/app_config_test.exs`. No persisted schema, wrapper, API field, module
schema/generator, profile, admission/fence or provider deadline is changed.
Expect a merge conflict if upstream changes cache/fetch/projection ordering;
preserve the one current flag snapshot and the installation ceiling. Rollback
uses compatible images/profile as above; a source check is not a deployment.

Four normal AppConfig regressions cover late stale cache fill, bots/creator
OFF, ON with raw OFF, missing/malformed flags and BASE. They observe exactly
one query for the three keys while unrelated cache stays warm. A separate
native opt-in canary uses committed synthetic SQL, authenticated API routing
and page-config serialization to reproduce stale ON before the fix and check
immediate OFF after it. See the candidate's [runtime recipe](../../tests/runtime/README.md).
Browser/UI cache, complete profiles, STOP and release acceptance stay separate.

### Live creator and room-settings projection

The existing `product_modules_changed` channel message carries exactly the
effective booleans `bots_enabled`, `ai_enabled` and `avaturn_enabled`; creator
origins and credentials are not included. Initial join and canonical Admin
writes use the same installed ceilings and current SQL flags. Creator-only
writes publish after persistence without invalidating server chat admission;
the existing bots/AI locking and invalidation order is retained.
Internally, creator-only persistence emits `avaturn_capabilities_changed` on
the existing topic; HubChannel maps it to the same client message, while the
chat presence tracker ignores only that creator event.

The client projects only those three flags from its current channel and fails
closed on missing/malformed capability data or lost channel authority. Mounted
room settings, media browser and creator receive synchronous updates so an
OFF/ON pulse cannot leave work admitted by the old creator session alive.
Delayed login, SDK export, preview, upload and avatar-save continuations must
revalidate their current selection/epoch; cancellation uses the existing fetch
AbortSignal path. Old completions cannot clear a newer session's autosave state.
Every projection subscriber must be notified even if another subscriber fails.
All other config, ordinary GLB import/editing and chat's unconditional capability
epoch rotation remain unchanged. Aborting a client request cannot undo bytes
the server has already committed.

The native opt-in `--avaturn-runtime` selects exactly five tagged backend
regressions in the existing local runner. It does not run the six profiles or
the entire historical suite; `--run` preserves its original five selected cases
and explicitly excludes the two newly loaded creator tests. Unit/native checks
of these boundaries do not establish a connected browser, provider login,
all six complete runtimes, installation transition or deployment acceptance.

The distinct normal client regressions connect actual Phoenix message dispatch
and HubChannel capability epochs to a mounted useBotChatRequest hook. OFF
aborts a held request; OFF→ON cannot deliver its old reply/action notice, but
a new request still works. A positive action-notice control keeps that oracle
live. Only test cases change; the socket never connects/joins, transport and
parent sendingDisabled remain explicit seams. This does not prove the full
UIRoot, SQL-to-network propagation or movement/STOP. Keep these cases when
merging upstream changes to HubChannel or the hook's cancellation identity.
See [local evidence](../../DOC/fiabilidad-ui-canal-2026-10-01.md).

### Automatic active-room propagation regression

The parent uses the same active-room periodic sync under RUNNER_AUTOSTART;
its default interval remains30s. A shared internal timer function preserves
the real callback/catch/unref and server-close cleanup without exposing a
new endpoint or allowing Kubernetes autostart on a loopback test server.

The opt-in `tests/runtime/reticulum-local.mjs --sql-http-periodic` mode selects
one committed synthetic SQL bots-OFF case. It waits for real timer ticks and
authenticated HTTP reads, not an explicit sync command or injected clock.
It observes capability OFF, readiness503 during a real owned child's stop,
held provider socket abortion, native child exit and lifecycle removal. The
chat timing oracle starts before request admission and must close below14s,
excluding the unchanged15s product deadline; COMMIT latency has honest bounds.
This narrow canary does not prove full ghost authentication, autostart,
Kubernetes, all six profiles, browser behaviour or whole-operation SLOs.
It never substitutes for exact full verification or deployment acceptance.

## Provider contract

AI uses the requested `gpt-6-luna` with Responses `reasoning.effort: high`, `store: false`, bounded total deadline and token output, input/output moderation, pseudonymous safety IDs and reply-only JSON schema. The model has no tools/action authority. Movement derives only from validated exact human commands and server checks. No hidden deterministic response is presented as working AI. `configured_not_probed` is configuration evidence, not a successful provider request. Actual credential access, response quality and latency require a separately recorded functional check before selling AI as accepted.

Official API model/effort and migration compatibility checked 2026-09-26: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6 migration](https://developers.openai.com/api/docs/guides/latest-model). No credentials or paid requests were used for these documentation checks.

Avaturn keeps standard provider login, including Google/email. No private REST-user integration, paid plan, account registration or terms acceptance is performed by this change. Customer project/domain setup and provider commercial terms remain external acceptance items; the sample demo is never shipped as a product endpoint.

## Migration and validation

Do not silently apply missing/default modules to the existing online installation: explicitly declare its intended profile first. Client, Reticulum and parent must be compatible with this contract. The generated Namespace, Reticulum and parent metadata must agree with literal runtime flags; the manifest verifier rejects drift and secret injection when AI is OFF.

Changing installed bots ON→OFF is a coordinated maintenance transition. The guarded apply requires the old parent already quiesced and no executable runners/intents before removing executors. It rejects unsafe live transitions rather than scaling down first and stranding STOPs. Do not bypass this with `kubectl scale`, raw apply or a UI toggle. Preserve the checkpoint and recorded recovery phase/epoch; use the documented guarded cutover workflow once its real checkpoint is valid. Re-enabling requires the normal authenticated Presence/spawn readiness gates.

The same generated resource inventory is retained in BASE; recovery-fence still stops every writer and never starts the parent. Legacy cold-rebind profiles keep their historical trust-domain checks and explicitly carry module metadata when produced by this candidate. Historical manifests without that marker are evidence of the old contract, not new BASE artifacts.

Tests cover all six combinations, bootstrap/admission/active/restore-fence, legacy profiles, mismatched env/annotations, stale capability delivery, disabled UI, and forbidden credentials. Full candidate validation, a joint DB+media checkpoint, digest-pinned official builds, guarded rollout and cold-browser/live acceptance are still mandatory. No local test substitutes for two-user sitting/voice, hardware VR or owner visual acceptance.

Upstream-sensitive changes: Reticulum application/supervisor and app-config projection, bot endpoint admission/delivery, generated deployment env/metadata and guarded apply/verifier. No persisted avatar/scene schema change. Roll back compatible images **and the corresponding complete profile/manifest**; do not mix the old always-enabled images with new installed-OFF claims.

# YenHubs Repository Rules

This is the single agent/rules file for the project. It contains durable
operating rules only. Session history belongs exclusively in
`docs/session-changelog.md`.

## Repository Map

- Root repository: `/Users/Shared/Gits/YenHubs`, base branch `main`.
- Hubs client submodule: `hubs/`, fork `yengalvez/hubs`, base branch `master`.
- Hubs CE and backend submodule: `hubs-cloud/`, fork `yengalvez/hubs-cloud`,
  base branch `master`.
- Runtime and recovery source of truth: `deployment/README.md`.
- Sole authority for current order and task state: `PLAN_ACTUAL.md`.
- Historical H5 plan and evidence: `docs/active-goal-plan-2026-07-18.md`.
- Human-readable projection of that plan: `docs/estado-sencillo.md`.
- Latest frozen audit snapshot and residual risks:
  `docs/auditoria-final-h5-2026-08-20.md`.
- H1 hibernation contract: `docs/client-hibernation-design-v1.md`.
- July handoff and audit are historical evidence, not resumption points.
- Upstream update procedure: `docs/development-workflow.md`.
- Per-client create/freeze/restore lifecycle: `deployment/client-instance-lifecycle.md`.
- Feature specifications: `features/<feature>/`.
- `OLD/` is archive-only. Never use it as implementation or deployment input.

The root repository pins exact submodule commits. A subrepo change is not fully
integrated until its base branch contains the commit and root `main` records the
new submodule pointer.

## Upstream Baselines

- Accepted Hubs release: `prod-2026-03-11`.
- Accepted Hubs Community Edition release: `2.1.0`.
- Stable release tags are the production baseline. `upstream/master` is only an
  early conflict signal and must not be deployed merely because it is newer.
- Run `scripts/audit-upstream.sh` before planning an update. It reports release
  ancestry, custom commit counts and dry-merge conflicts.

Treat both forks as updateable upstream bases. Prefer isolated components,
systems, utilities, feature flags and configuration over invasive core edits.
When a core edit is unavoidable, document:

- upstream release/tag used as the baseline;
- files, schemas, APIs and persisted contracts changed;
- behavior that YenHubs must preserve;
- feature-specific acceptance tests;
- likely merge conflicts and rollback path.

Never combine a feature, an upstream update and unrelated infrastructure
modernization in one branch or rollout. An upstream merge that compiles is not
accepted until third-person, authoritative sitting, full-body/provider-neutral
GLB avatars, avatar import, bots, ghost runner, bot privacy, Spanish UI, Spoke
ownership and deployment recovery have been revalidated where relevant.

## Branch and Change Workflow

1. Start from clean base branches and initialized submodules.
2. Create short-lived `codex/<scope>` branches only in affected repositories.
3. Create a DB and storage checkpoint before any production mutation.
4. Implement one coherent change set.
5. Update the relevant feature specification and `docs/session-changelog.md`.
6. Run static and full validation.
7. Build images through the approved GitHub Actions workflow.
8. Deploy only by regenerating and applying the tracked Hubs CE manifest.
9. Perform a cold-browser acceptance and the live verifier.
10. Merge subrepos first, then update and merge the root pointers.

Do not amend or rewrite published history unless the owner explicitly approves
the disruption to existing clones and references.

## Required Validation

Run from the root. The `--full` path already executes the common/normal block,
so do not run both commands consecutively on the same bytes:

```bash
./scripts/verify-project.sh --full
```

Use `./scripts/verify-project.sh` alone only as the faster intermediate gate
when the full-only components are not yet due. A frozen final candidate must
pass `--full` once.

The full gate covers Hubs, Admin, Hubs CE generator, bot orchestrator, Dialog,
Photomnemonic, Coturn, Spoke and Reticulum. Do not use `npm audit fix --force`
or broad dependency upgrades to silence findings. Upgrade one compatibility
surface at a time and retest it.

After a live rollout:

```bash
./deployment/verify-live-reactivation.sh
```

Acceptance requires zero failures and zero warnings plus a real cold browser
load proving `APP`, `AFRAME`, the scene and expected bots initialize without
uncaught errors.

## Deployment Rules

- Standard path: GitHub Actions image build, digest pin, set the tracked runner
  activation/recovery inputs, `npm run gen-hcce`, review `kubectl diff` without
  emitting Secret bodies, then run the guarded `npm run apply`. Never bypass
  the generated-manifest verifier, global operation Lease or fail-closed
  activation checks with a raw `kubectl apply -f hcce.yaml`.
- Introduce or repair the runner control plane only through separately
  regenerated `bootstrap`, `admission` and `active` manifests, in that order.
  `restore-fence` is reserved for the coordinated checkpoint-restore workflow.
- Never edit generated `hcce.yaml`. Fix the tracked generator and regenerate.
- Never apply manual RBAC patches after generation.
- If Actions, GHCR, generation or apply fails, stop and report the exact failure.
  Do not switch to in-cluster builds, pod hotpatches, `kubectl cp`,
  `kubectl set image` or manual asset replacement without explicit approval.
- Export `BASE_ASSETS_PATH` and `RETICULUM_SERVER` for Hubs builds as documented.
- After changing the Hubs image, restart Reticulum so cached HTML references the
  new hashed assets.
- Keep every active Deployment image pinned by digest.
- Keep `PERMS_KEY` identical in Reticulum and Dialog.
- Store global app config values as JSON object wrappers, not raw primitives.
- Do not run `/ret/bin/ret eval` or `/ret/bin/ret rpc` inside the live pod.
- Do not create DigitalOcean resources without an explicit cost gate. Keep
  control-plane HA disabled for this low-cost topology.

Known Actions failures and fixes are documented in `deployment/README.md`,
including reusable-workflow `secrets.*` expressions and GHCR `403` errors.

## Secrets and Supply Chain

- Never commit or print real secrets.
- Local runtime values live only in `deployment/input-values.local.yaml`
  (`0600`, ignored by Git).
- The generated Hubs CE values and manifest are ignored and may contain secrets.
- Do not open, diff or print ignored generated manifests as a diagnostic. Use
  the redacted verifier/inventory paths. If a value appears in task, terminal
  or CI output, treat it as compromised and rotate it before rollout.
- GitHub package credentials must be supplied through GitHub Actions secrets,
  an environment variable for preflight, or a Kubernetes image pull secret.
  Do not put PATs in workflow inputs or tracked YAML.
- Run Gitleaks on the current deliverable tree and Actionlint/ShellCheck before
  commit. The root security workflow enforces the same baseline.
- A secret found in Git history is compromised even after deleting the file.
  Revoke it and record only the revocation status, never the value.
- Reticulum currently acknowledges exactly two upstream `cowlib 2.18.0`
  advisories with no fixed release. Any additional Hex advisory must fail CI.

## Backup, Freeze and Restore

A valid checkpoint always contains both PostgreSQL metadata and Reticulum media:

```bash
./deployment/create-checkpoint.sh
```

It produces:

- `retdb-*.sql.gz`;
- `ret-storage-*.tar.gz`;
- exact commits and image digests;
- non-secret Kubernetes and DigitalOcean inventory;
- configured-key presence only;
- `SHA256SUMS`.

Validate restores in dry-run mode before deleting infrastructure. A DB-only
backup is incomplete because scene, avatar, thumbnail and Spoke bytes live in
`ret-pvc`. Follow `deployment/client-instance-lifecycle.md` for client closure
or reconstruction.

## Bots and AI

- The Node ghost runner is the only production and authenticated backend, with
  `GHOST_NAVIGATION_MODE=navmesh_preferred` and required navmesh. Chromium is
  retained only as a legacy/local browser diagnostic without `--runner`; it
  cannot authenticate against hardened Reticulum because `BOT_RUNNER_ACCESS_KEY` is
  not delivered to the renderer, does not count toward readiness and must never
  receive that key through a URL or client-side state.
- Bot scenes need a published Floor Plan/navmesh. Name patrol points
  `spawbot-*` and place them on the walkable surface.
- `mobility=static` disables autonomous and LLM-triggered movement.
- A runner is usable only after authenticated Presence, an exact per-room bot
  namespace and authoritative spawn ACKs; readiness, not liveness, is the
  rollout gate.
- Re-test navmesh extraction/routing after Hubs, Spoke, Three.js,
  networked-aframe or Hubs CE updates.
- Bot chat is private to the current browser session. YenHubs must not persist
  conversations or log message/prompt content.
- OpenAI requests use `store:false`, fail-closed moderation, one bounded total
  deadline, pseudonymous safety IDs and reply-only structured output. The model
  has no action authority; allowlisted movement is derived from an exact human
  command and revalidated by Reticulum.
- `store:false` is not Zero Data Retention; keep the user notice and review
  provider retention requirements before public events.

## Room and Spoke Content

- Main room: `VJopCY3`.
- Editable Spoke project: `qa3U3Ke`.
- Published scene: `f6VKtim`.
- Operational administrator: `info@virtualmente.com`.
- Room ownership and Spoke project ownership are separate records.
- Permanent geometry and waypoint changes must be published from Spoke.
- An authoritative sitting waypoint uses `Disable motion`, `Can be occupied`
  and a stable published network identity; add `Clickable` when the Space
  target must be visible after fully entering the room.
- Deploy a compatible Reticulum reservation protocol before the Hubs client.
  A mixed legacy window is fail-closed for accepting seat exclusivity.

## Archive Policy

Move obsolete research, superseded runbooks and historical patches into `OLD/`
instead of deleting useful evidence. Every archived item must be listed in
`OLD/README.md` with its replacement or reason. Active docs and scripts must not
link to archived material as a required step.

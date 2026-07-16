# YenHubs Project Rules

## Development Workflow
- `hubs/` is a git submodule (client). `hubs-cloud/` is a git submodule (infra generator).
- Land production-ready client work on `hubs` `master`.
- Develop features in short-lived branches in `hubs` (prefer `codex/<feature-name>`), then fast-forward/merge to `master`.
- Update the parent repo `main` to point the `hubs` submodule to the desired commit (this is what actually pins what “version” of the client we ship).

## Upstream Compatibility and Upgrade Auditing
- Treat Mozilla Hubs and Hubs Community Edition as updateable upstream bases, not as code that YenHubs permanently
  owns. Every implementation decision must consider how the customization will be reviewed, migrated or removed when
  a newer upstream release is integrated.
- Prefer isolated components, systems, utilities, feature flags and configuration over invasive edits to upstream
  core. When a core modification is unavoidable, keep it as small and explicit as possible.
- Every feature or base-code fix must document its custom patch surface in the relevant `features/<feature>/`
  documentation, or in `docs/` for cross-cutting work. Record at least:
  - upstream Hubs/Hubs CE version or tag used as the starting point;
  - files, components, systems, schemas, APIs and persisted data contracts changed;
  - why upstream behavior was insufficient and which YenHubs behavior must be preserved;
  - tests and live acceptance needed to prove the customization still works;
  - likely merge conflicts, upgrade risks and rollback path.
- Add a concise entry to `docs/session-changelog.md` whenever upstream base code is modified. The changelog is history;
  the feature document is the durable specification used during future upgrades.
- Never mix a new feature, an upstream upgrade and unrelated infrastructure modernization in the same branch or
  rollout. Upgrade Hubs and Hubs CE in separate isolated branches from the last accepted production baseline.
- Before accepting an upstream update:
  - fetch and identify the exact official tag/commit;
  - compare the full YenHubs custom diff against that upstream point;
  - audit every documented customization for deleted APIs, changed schemas and behavioral conflicts;
  - run the complete local test/build suites and feature-specific acceptance checklists;
  - build only through the approved GitHub Actions workflows;
  - test the candidate without changing the accepted production image;
  - deploy only after checkpoint, diff review, rollback preparation and explicit acceptance.
- An upstream merge that compiles is not considered compatible. Third-person, sitting, RPM/Avaturn avatars, avatar
  import, bots/ghost runner/chat privacy, Spanish glass UI, room ownership/content workflows and deployment security
  must be revalidated explicitly when their underlying Hubs or Hubs CE areas change.
- Do not delete compatibility notes after a successful upgrade. Update them with the new upstream baseline and mark
  obsolete patches as removed or replaced so the next audit can distinguish active customizations from historical
  ones.

## Technology Stack
- **Client**: Mozilla Hubs (React + A-Frame + Three.js + BitECS).
- **Infrastructure**: DigitalOcean Kubernetes (DOKS) + kubectl.
- **Deployment**: Hubs CE 2.1.0 method via `hubs-cloud/community-edition/` scripts (`npm run gen-hcce && kubectl apply -f hcce.yaml`).

## Documentation Convention
- **Session changelog lives only in** `docs/session-changelog.md`.
- Deployment/runbook source of truth: `deployment/README.md`.
- Reactivation and pending audit checkpoint: `docs/reactivation-audit-2026-07.md`.
- Feature-specific docs live in `features/<feature-name>/`.

## Deployment Rules
- The July 2026 restart must first restore the frozen known-good state. Do not combine infrastructure recovery with the Hubs upstream update in one step.
- Do not create DigitalOcean resources until the owner explicitly approves the estimated cost. For DOKS 1.36+, set `HA=false` explicitly to avoid an unintended $40/month control-plane charge.
- Every client code change in `hubs/` MUST be built (`npm run build`) and deployed.
- **IMPORTANT**: Export `BASE_ASSETS_PATH` and `RETICULUM_SERVER` before building, or the live site can be blank/wrong. See `deployment/README.md`.
- A task is NEVER considered finished until verified on the live site.
- Prefer building/pushing images in **GitHub Actions** (cheaper, avoids in-cluster OOM builds). See `deployment/README.md`.
- If GitHub Actions fails, STOP and report the exact run URL and error (do not switch deploy method without explicit approval). Common fixes are documented in `deployment/README.md`:
  - `Invalid workflow file ... Unrecognized named-value: 'secrets'` (reusable workflow job `if:` must not reference `secrets.*`).
  - `403 Forbidden` pushing to GHCR (ensure `packages: write` + repo workflow permissions + correct registry secrets).
- **Standard Method**: Generate YAML with `npm run gen-hcce`, apply with `kubectl apply -f hcce.yaml`.
- **No Unapproved Method Switching**: If the standard deploy path is blocked (CI failure, GitHub outage, build error, kubectl/apply error), STOP and report:
  - what failed (exact command / run id),
  - why it failed (best known cause),
  - the safest next step.
  Do not attempt alternate deploy approaches (hotpatching pods, in-cluster builds, manual asset copying, etc.) unless the user explicitly approves the deviation first.
- Bots rollout requires `BOT_ACCESS_KEY` and `OPENAI_API_KEY` in `deployment/input-values.local.yaml` (never commit real values).
- When writing global feature flags into `ret0.app_configs`, `value` must be stored as a JSON object wrapper (`{"value": <...>}`), not a raw primitive (`true`/`false`), or Reticulum readiness can fail with `cannot load ... as type :map`.
- Keep `PERMS_KEY` stable across deploys by **setting it in** `deployment/input-values.local.yaml` (and copying into `hubs-cloud/community-edition/input-values.yaml`). If it is missing, `gen-hcce` will generate a new key and **rooms can break** after partial restarts (typical symptom: `Imposible conectarse a esta sala` with `JsonWebTokenError: invalid signature`). If this happens, restart both `reticulum` and `dialog` so they load the same key material.
- Runtime hotpatches, local/in-cluster image builds, `kubectl cp` and `kubectl set image` are not standard methods. Do not use them unless the owner explicitly approves a named emergency exception after the normal path fails.
- Never run `/ret/bin/ret eval`, `/ret/bin/ret rpc` or another release helper inside the live Reticulum pod. On the single
  8 GiB node the helper VM can exceed the container limit and restart Reticulum. Use normal authenticated APIs, SQL
  through the PostgreSQL pod or an isolated canary instead.
- Never edit generated `hcce.yaml` or reapply manual RBAC patches. Fix the tracked generator, rerun `npm run gen-hcce`, require the manifest verifier to pass, then apply the generated file unchanged.
- A project freeze is not complete with `pg_dump` alone. Require both a DB dump and a successful `deployment/backup-ret-storage.sh` archive before deleting DOKS or its volumes; validate restores with `deployment/restore-retdb.sh` and `deployment/restore-ret-storage.sh`.

## Room and Spoke Content Rules
- The live room `VJopCY3` and the editable Spoke project `qa3U3Ke` are separate ownership records. The account for
  `info@virtualmente.com` owns the Spoke project/scene and is an additional owner of the room.
- Permanent scene geometry and waypoint properties are edited in Spoke:
  `https://meta-hubs.org/spoke/projects/qa3U3Ke`. In-room object placement is not a replacement for publishing Spoke.
- For sitting waypoints, `Disable motion` identifies the seat. `Clickable` is additionally required if the waypoint
  must appear as a white target while the user holds Space. Space targets are tested after fully entering the room,
  not while using the lobby-only `Mirar` mode.

## Code Standards
- Maintain documentation for every new feature in `features/`.
- General project documentation goes in `docs/`.
- Secrets NEVER go in tracked files. Use `deployment/input-values.local.yaml` (gitignored).

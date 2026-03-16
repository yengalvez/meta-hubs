# YenHubs Project Rules

## Development Workflow
- `hubs/` is a git submodule (client). `hubs-cloud/` is a git submodule (infra generator).
- Land production-ready client work on `hubs` `master`.
- Develop features in short-lived branches in `hubs` (prefer `codex/<feature-name>`), then fast-forward/merge to `master`.
- Update the parent repo `main` to point the `hubs` submodule to the desired commit (this is what actually pins what “version” of the client we ship).

## Technology Stack
- **Client**: Mozilla Hubs (React + A-Frame + Three.js + BitECS).
- **Infrastructure**: DigitalOcean Kubernetes (DOKS) + kubectl.
- **Deployment**: Official Hubs CE 2.0.0 method via `hubs-cloud/community-edition/` scripts (`npm run gen-hcce && kubectl apply -f hcce.yaml`).

## Documentation Convention
- **Session changelog lives only in** `docs/session-changelog.md`.
- Deployment/runbook source of truth: `deployment/README.md`.
- Feature-specific docs live in `features/<feature-name>/`.

## Deployment Rules
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
- **Emergency Method (Only With Explicit User Approval)**: `kubectl cp`/hotpatching. WARNING: Non-durable and can break the live site if page/asset URLs are wrong; typically requires restarting Reticulum to flush cached HTML. See `deployment/README.md`.

## Code Standards
- Maintain documentation for every new feature in `features/`.
- General project documentation goes in `docs/`.
- Secrets NEVER go in tracked files. Use `deployment/input-values.local.yaml` (gitignored).

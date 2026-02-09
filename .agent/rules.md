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
- **Standard Method**: Generate YAML with `npm run gen-hcce`, apply with `kubectl apply -f hcce.yaml`.
- **Emergency Method**: `kubectl cp` (Hot-fix). WARNING: Non-durable and requires copying both `assets/` and `pages/` plus restarting Reticulum. See `deployment/README.md`.

## Code Standards
- Maintain documentation for every new feature in `features/`.
- General project documentation goes in `docs/`.
- Secrets NEVER go in tracked files. Use `deployment/input-values.local.yaml` (gitignored).

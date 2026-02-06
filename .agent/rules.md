# YenHubs Project Rules

## Development Workflow
- Always use the `master` branch in the `hubs` submodule for production-ready changes.
- Features should be developed in `feature/` branches inside the `hubs` submodule.
- The parent repository tracks infrastructure, feature docs, and specific submodule commits.

## Technology Stack
- **Client**: Mozilla Hubs (React + A-Frame + Three.js + BitECS).
- **Infrastructure**: DigitalOcean Kubernetes (DOKS) + kubectl.
- **Deployment**: Official Hubs CE 2.0.0 method via `hubs-cloud/community-edition/` scripts (`npm run gen-hcce && kubectl apply -f hcce.yaml`).

## Deployment Rules
- Every client code change in `hubs/` MUST be built (`npm run build`) and deployed.
- **IMPORTANT**: Export `BASE_ASSETS_PATH` and `RETICULUM_SERVER` before building, or the live site will be blank. See `docs/project_maintenance.md`.
- A task is NEVER considered finished until verified on the live site.
- **Standard Method**: Generate YAML with `npm run gen-hcce`, apply with `kubectl apply -f hcce.yaml`.
- **Emergency Method**: `kubectl cp` (Hot-fix). WARNING: Requires updating `/www/hubs/pages/` and restarting Reticulum. See `docs/project_maintenance.md`.

## Code Standards
- Maintain documentation for every new feature in `features/`.
- General project documentation goes in `docs/`.
- Secrets NEVER go in tracked files. Use `deployment/input-values.local.yaml` (gitignored).

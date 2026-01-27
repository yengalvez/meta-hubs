# YenHubs Project Rules

## Development Workflow
- Always use the `yenhubs-stable` branch in the `hubs` submodule for production-ready changes.
- Features should be developed in `feature/` branches inside the `hubs` submodule.
- The parent repository `meta-hubs` (YenHubs root) tracks infrastructure and specific submodule commits.

## Technology Stack
- **Client**: Mozilla Hubs (React + A-Frame + Three.js + BitECS).
- **Infrastructure**: DigitalOcean Kubernetes (DOKS) + Helm.
- **CRITICAL: Mandatory Deployment**: Every single code change in `hubs` MUST be built (`npm run build`) and deployed to the DigitalOcean cluster IMMEDIATELY. A task is NEVER considered finished or "working" until it has been verified on the live site (`meta-hubs.org`). Refer to [project_maintenance.md](file:///Users/Shared/Gits/YenHubs/docs/project_maintenance.md) for the exact `kubectl` deployment commands.

## Code Standards
- Maintain documentation for every new feature in `docs/features/`.

# YenHubs Project Rules

## Development Workflow
- Always use the `yenhubs-stable` branch in the `hubs` submodule for production-ready changes.
- Features should be developed in `feature/` branches inside the `hubs` submodule.
- The parent repository `meta-hubs` (YenHubs root) tracks infrastructure and specific submodule commits.

## Technology Stack
- **Client**: Mozilla Hubs (React + A-Frame + Three.js + BitECS).
- **Infrastructure**: DigitalOcean Kubernetes (DOKS) + Helm.
- **CRITICAL: Mandatory Deployment**: Every single code change in `hubs` MUST be built (`npm run build`) and deployed to the DigitalOcean cluster IMMEDIATELY. 
    *   **IMPORTANT**: You MUST export `BASE_ASSETS_PATH` and `RETICULUM_SERVER` before building, or the live site will be blank. See `project_maintenance.md`.
    *   A task is NEVER considered finished or "working" until it has been verified on the live site (`meta-hubs.org`). 
    - **Preferred Method**: Docker Build + Push (Robust).
    - **Emergency Method**: `kubectl cp` (Hot-fix). *WARNING*: Requires updating `/www/hubs/pages/` and restarting Reticulum. See [project_maintenance.md](file:///Users/Shared/Gits/YenHubs/docs/project_maintenance.md) for details.

## Code Standards
- Maintain documentation for every new feature in `/features/`. And the name of the feature.
- general documentation about the project in `/docs/`.  

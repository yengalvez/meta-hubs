# AGENTS

## Session Log

This file tracks concrete execution history for work done by the agent.

### 2026-02-09 - Third-Person Camera + Deploy Operations

Time reference: UTC (local CET noted where relevant).

| Time | What was done | Outcome |
|------|----------------|---------|
| 2026-02-09 10:34Z | Implemented third-person camera toggle feature in `hubs` (`store.js`, `camera-system.js`, `preferences-screen.js`, `ui-root.js`) on branch `codex/third-person-toggle-ui`. | Code completed with persisted preference and toolbar button toggle. |
| 2026-02-09 10:34Z-10:36Z | Executed local checks/build in `hubs` (`npm ci`, `npm run check`, `npm run lint:js`, `npm run build`). | All successful. |
| 2026-02-09 10:34:57Z-10:42:40Z | Monitored GitHub Actions run `21821623890` (`hubs` workflow). | `success`. |
| 2026-02-09 10:36:08Z-10:43:28Z | Triggered and monitored GitHub Actions run `21821659957` (`custom-docker-build-push`, GHCR target). | `failure` due GHCR scope/permission error when pushing image. |
| 2026-02-09 10:40:28Z | Generated and applied `hubs-cloud/community-edition/hcce.yaml` with manual ingress/HAProxy edits. | Apply succeeded. |
| 2026-02-09 10:40:42Z | Re-applied HAProxy RBAC patch and restarted HAProxy deployment. | HAProxy healthy on image `haproxytech/kubernetes-ingress:3.2`. |
| 2026-02-09 10:43:27Z and 10:50:38Z | Observed failed pull for `ghcr.io/yengalvez/hubs:third-person-toggle-20260209-2b4f84827-latest`. | `ErrImagePull` / `ImagePullBackOff`. |
| 2026-02-09 ~10:44Z | Applied emergency hotfix by copying rebuilt `dist` assets/pages to running `hubs` pod and restarting reticulum. | Site served updated frontend successfully. |
| 2026-02-09 10:47:24Z-10:47:56Z | Restarted `dialog` deployment to stabilize room connection path. | Dialog rollout healthy. |
| 2026-02-09 10:52:33Z-10:52:34Z | Restored `hubs` deployment image to `hubsfoundation/hubs:stable-3108` and cleared failing replicasets. | Cluster returned to all-green state. |
| 2026-02-09 11:34:47+01:00 (CET) | Created submodule commit `2b4f84827`. | `Add third-person camera toggle with UI button`. |
| 2026-02-09 11:53:14+01:00 (CET) | Created parent commit `eb6efd7`. | Submodule pointer updated and docs clarified. |
| 2026-02-09 11:00:09Z (12:00:09+01:00 CET) | Reviewed and corrected deployment documentation in `deployment/README.md` and `docs/project_maintenance.md` (verify active hubs image + consistent `RetPageOriginDockerfile` build command). | Deployment guide aligned with real rollout workflow. |
| 2026-02-09 (user confirmation) | User reported third-person camera working correctly in real usage. | Manual production validation confirmed. |

## Operational Reminder

- Hotfix via `kubectl cp` is temporary and can be lost after pod replacement.
- Persistent production rollout requires a published custom image and setting `OVERRIDE_HUBS_IMAGE` to that tag.

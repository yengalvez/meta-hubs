# Session Changelog

## 2026-02-09 (Third-Person Camera + Deploy Work)

Time reference: UTC (local CET noted where relevant).

| Time | Action | Result |
|------|--------|--------|
| 2026-02-09 10:34Z | Implemented third-person feature in `hubs` on branch `codex/third-person-toggle-ui` (store + camera system + preferences + toolbar button). | Feature completed in code with toggle and persisted preference. |
| 2026-02-09 10:34Z-10:36Z | Ran local validation in `/Users/Shared/Gits/YenHubs/hubs`: `npm ci`, `npm run check`, `npm run lint:js`, `npm run build`. | Passed (webpack size warnings only). |
| 2026-02-09 10:34:57Z-10:42:40Z | GitHub Actions run `21821623890` (`hubs` workflow) for commit `2b4f848279d91e3eadfd5c8e38c9bd3a6dcf1832`. | Completed `success`. |
| 2026-02-09 10:36:08Z-10:43:28Z | GitHub Actions run `21821659957` (`custom-docker-build-push`) targeting GHCR. | Completed `failure` (`permission_denied`, token scope issue while pushing image). |
| 2026-02-09 10:40:28Z | Generated and applied `hcce.yaml` with ingress and HAProxy manual fixes. | Applied successfully. |
| 2026-02-09 10:40:42Z | Re-patched RBAC (`haproxy-cr`) and restarted HAProxy. | HAProxy healthy on `haproxytech/kubernetes-ingress:3.2`. |
| 2026-02-09 10:43:27Z and 10:50:38Z | Deploy tried to pull `ghcr.io/yengalvez/hubs:third-person-toggle-20260209-2b4f84827-latest`. | `ErrImagePull` / `ImagePullBackOff` (image not published). |
| 2026-02-09 ~10:44Z | Executed emergency hotfix: rebuilt client with `RETICULUM_SERVER` + `BASE_ASSETS_PATH`, copied `dist/assets` and `dist/pages/*` into running hubs pod, restarted reticulum. | Frontend served correctly from `https://assets.meta-hubs.org/hubs/`. |
| 2026-02-09 10:47:24Z-10:47:56Z | Restarted and rolled out `dialog` deployment. | Dialog healthy (`dialog-86df9df69b-kp26r`). |
| 2026-02-09 10:52:33Z-10:52:34Z | Normalized `hubs` deployment image back to `hubsfoundation/hubs:stable-3108` to remove failing ReplicaSets. | Cluster returned to clean state (all deployments ready). |
| 2026-02-09 11:34:47+01:00 (CET) | Commit in submodule `hubs`: `2b4f84827`. | `Add third-person camera toggle with UI button`. |
| 2026-02-09 11:53:14+01:00 (CET) | Commit in parent repo: `eb6efd7`. | Updated `hubs` submodule pointer and deployment docs clarification. |
| 2026-02-09 11:00:09Z (12:00:09+01:00 CET) | Re-reviewed and corrected deployment docs in `deployment/README.md` and `docs/project_maintenance.md` (added active hubs image verification and unified custom build command with `RetPageOriginDockerfile`). | Deployment docs left consistent for future runs. |
| 2026-02-09 (user validation) | User confirmed third-person camera works well in real usage. | Functional validation confirmed manually. |

## 2026-02-09 (Avatar Upload Fix + Admin Local Upload + RPM MVP + Deploy)

Time reference: UTC (local CET noted where relevant).

| Time | Action | Result |
|------|--------|--------|
| 2026-02-09 12:19:58Z (13:19:58+01:00 CET) | Created commit `9b5ae36ee` in `hubs` implementing: URL normalization in Change Avatar, safer `proxiedUrlFor`/thumbnail fallbacks, admin local `.glb` avatar uploads (batch), and RPM/fullbody skeleton detection + tags. | Feature complete in code; removes `https://undefined/...` proxy breakage and adds disk upload flow. |
| 2026-02-09 12:25:12Z-12:34:18Z | GitHub Actions run `21826862113` (`custom-docker-build-push`) for commit `9b5ae36eedf3d21c9ca50c19ffed6e6cb03df1f9`. | Completed `success` and published `ghcr.io/yengalvez/hubs:rpm-avatar-import-20260209-9b5ae36ee-latest`. |
| 2026-02-09 (deploy) | Updated Kubernetes namespace `hcce` to pull private GHCR images (`ghcr-pull` secret + `imagePullSecrets` on ServiceAccount `default`). | Fixed `ErrImagePull` / `ImagePullBackOff` for private `ghcr.io` tags. |
| 2026-02-09 (deploy) | Rolled out `deployment/hubs` to `ghcr.io/yengalvez/hubs:rpm-avatar-import-20260209-9b5ae36ee-latest`. | Pods `Running`; deployment `hubs` shows correct image via jsonpath. |
| 2026-02-09 (verification) | Verified `https://meta-hubs.org` and `https://assets.meta-hubs.org/hubs/pages/admin.html` are up and serving the new admin UI. | Admin bundle contains `Upload Avatars from Disk` and site returns HTTP 200 with expected CSP/headers. |

## Notes

- The emergency hotfix (`kubectl cp` into running pod) is not durable across full pod replacement.
- Durable production rollout still requires a successfully published custom image and `OVERRIDE_HUBS_IMAGE` update to that image tag.

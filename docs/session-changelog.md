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

## 2026-02-09 (Avatar Bootstrap + Admin Local Upload Fix + URL Avatar Import Fix)

Time reference: UTC (local CET noted where relevant).

| Time | Action | Result |
|------|--------|--------|
| 2026-02-09 14:15Z-14:18Z | Investigated why Admin local `.glb` avatar upload fails in production. | Found root cause: there were **no base avatar listings** (`/api/v1/media/search?filter=base&source=avatar_listings` returned 0) and Reticulum rejects attempts to create base avatars via file upload (`POST /api/v1/avatars` without `parent_avatar_listing_id` returns `400` / `Internal server error`). |
| 2026-02-09 14:15Z-14:18Z | Bootstrapped a base avatar listing by importing a known-good base avatar from `demo.hubsfoundation.org` and creating an `avatar_listings` row tagged `base`, `default`, `featured`. | Base avatar listings became available locally (unblocking avatar creation for uploaded avatars). |
| 2026-02-09 14:24:37Z (15:24:37+01:00 CET) | Committed `hubs` fix `f7605bf73` to: (1) require and select a base avatar listing for Admin local upload (adds `parent_avatar_listing_id`), (2) in-room custom avatar URL now imports Hubs avatar page URLs into local reticulum and stores imported `avatar_id` (SID). | Local upload no longer fails on base-avatar path; Hubs avatar URLs should become properly rigged via import rather than static URL avatars. |
| 2026-02-09 14:26:22Z-14:31:33Z | GitHub Actions run `21828924354` (`custom-docker-build-push`) for `master` `f7605bf73`. | Completed `success`; published `ghcr.io/yengalvez/hubs:rpm-avatar-import-20260209-f7605bf73-latest`. |
| 2026-02-09 ~14:31Z | Deployed the new image to DOKS `hcce` via `kubectl set image`. | First rollout hit `ErrImagePull` (`403 Forbidden` from GHCR token endpoint); fixed by updating `ghcr-pull` secret with the newest PAT and restarting `deployment/hubs`. Rollout then succeeded. |

## 2026-02-09 (Admin Local Upload Hardening + Avatar URL Normalization + GHCR Build Reliability)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-09 14:46Z-14:52Z | Hardened Admin local avatar upload in `hubs`: upload via `getDirectReticulumFetchUrl(\"/api/v1/media\")` (avoid ingress limits) and include `base_gltf_url` when creating avatars. | Admin disk-upload flow should succeed for larger avatars and match `AvatarEditor` semantics more closely. |
| 2026-02-09 14:46Z-14:52Z | Improved in-room `Change Avatar` URL handling to also accept avatar SIDs and Hubs API URLs (e.g. `/api/v1/avatars/<sid>` and `/api/v1/avatars/<sid>/avatar.gltf`) and import remote avatars into local reticulum when cross-origin. | Avoids “static URL avatar” when users paste API URLs; improves reliability of rigged avatars. |
| 2026-02-09 14:52Z | Merged the fixes into `hubs` `master` and pushed (`01f2132e9`). | Code available on `origin/master`. |
| 2026-02-09 14:55Z-14:56Z | Observed `custom-docker-build-push` run `21829985541` fail. | Root cause: missing default registry inputs/vars/secrets -> `Username and password required`. |
| 2026-02-09 14:58Z | Updated `custom-docker-build-push` workflow defaults (`a7c9eb2e7`). | Workflow now defaults to GHCR + repo owner when overrides/vars are absent. |
| 2026-02-09 14:59Z-15:06Z | Observed `custom-docker-build-push` run `21830114386` fail when using `GITHUB_TOKEN` fallback. | Root cause: GHCR returned `403 Forbidden` on cache/push HEAD requests. |
| 2026-02-09 15:08Z-15:17Z | Re-ran `custom-docker-build-push` with explicit PAT auth + no build cache: run `21830444511`. | Completed `success` and published `ghcr.io/yengalvez/hubs:rpm-avatar-import-20260209-a7c9eb2e7-latest`. |
| 2026-02-09 15:17Z-15:18Z | Deployed the new image to DOKS `hcce`: `kubectl set image deployment/hubs ...` + rollout status. | Deployment rolled out successfully; `deployment/hubs` now points at the new image tag. |

## 2026-02-09 (RPM Rigging Fix + Basic Full-Body Locomotion + Deploy)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-09 16:38Z | Committed `hubs` fix (`57a945fae` + `7a0fc7290`): normalize Mixamo/RPM bone names, ensure `AvatarRoot` for template attachment, add fallback eyes, and attach `fullbody-locomotion` to `AvatarRoot` templates. | RPM/Mixamo avatars should now receive `ik-controller` (body yaw + head tracking) and get a basic procedural leg swing while moving. |
| 2026-02-09 16:42:42Z-16:49:17Z | GitHub Actions run `21833234013` (`custom-docker-build-push`) with `Override_Image_Tag=rpm-avatar-rigging-20260209-7a0fc7290` and `Use_Build_Cache=false`. | Completed `success`; published `ghcr.io/yengalvez/hubs:rpm-avatar-rigging-20260209-7a0fc7290-latest`. |
| 2026-02-09 ~16:50Z | Rolled out `deployment/hubs` in namespace `hcce` to the new GHCR image tag via `kubectl set image`. | Rollout succeeded; `https://meta-hubs.org` returns HTTP 200. |

## 2026-02-09 (RPM: Fix Floating + Stop Broken Arm IK + Deploy)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-09 ~17:18Z | Committed `hubs` fix `3791e682f`: prefer renaming skeleton joints for Mixamo/RPM, avoid “wrap under Head” fallback when a humanoid skeleton exists, compute avatar offset in IK-root space, and disable the simple hand IK when a full arm chain is detected. | Should stop RPM avatars being glued to camera / floating, and prevent distorted/stretched arms. |
| 2026-02-09 17:18:59Z-17:26:16Z | GitHub Actions run `21834162983` (`custom-docker-build-push`) with `Override_Image_Tag=rpm-avatar-ikfix-20260209-3791e682f` and `Use_Build_Cache=false`. | Completed `success`; published `ghcr.io/yengalvez/hubs:rpm-avatar-ikfix-20260209-3791e682f-latest`. |
| 2026-02-09 ~17:26Z | Rolled out `deployment/hubs` in namespace `hcce` to `ghcr.io/yengalvez/hubs:rpm-avatar-ikfix-20260209-3791e682f-latest`. | Rollout succeeded; `https://meta-hubs.org` returns HTTP 200. |

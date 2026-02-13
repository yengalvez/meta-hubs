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

## 2026-02-09 (RPM Shared Animations: Idle + Walk + Deploy)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-09 ~18:10Z-18:15Z | Implemented shared Mixamo locomotion MVP in `hubs`: added shared `idle`/`walk` clips (as GLB assets), loader/retargeting utility, and updated `fullbody-locomotion` to prefer shared animations over procedural swing (legs-only to avoid IK conflicts). | Full-body RPM/Mixamo avatars should now play shared idle/walk without requiring per-avatar embedded animations. |
| 2026-02-09 ~18:15Z-18:17Z | Ran local validation in `/Users/Shared/Gits/YenHubs/hubs`: `npm run check`, `npm run lint:js`, `npm run build`. | Passed (webpack size warnings only). |
| 2026-02-09 18:18:19Z-18:25:34Z | GitHub Actions run `21836105337` (`custom-docker-build-push`) with `Override_Image_Tag=rpm-anim-idle-walk-20260209-eb3276a77` and `Use_Build_Cache=false`. | Completed `success`; published `ghcr.io/yengalvez/hubs:rpm-anim-idle-walk-20260209-eb3276a77-latest`. |
| 2026-02-09 ~18:26Z | Installed `kubectl` client to `~/.local/bin/kubectl` (v1.35.0) and rolled out `deployment/hubs` in namespace `hcce` to the new image tag via `kubectl set image`. | Rollout succeeded; `deployment/hubs` now points at `ghcr.io/yengalvez/hubs:rpm-anim-idle-walk-20260209-eb3276a77-latest` and `https://meta-hubs.org` returns HTTP 200. |
| 2026-02-09 ~18:45Z-19:03Z | Extended shared locomotion retargeting to include **arm swing** bones (still excluding hips/spine/neck/head and all translations). Attempted to build/push image via Actions run `21837087699` but GitHub Actions/Logs endpoints were returning server errors during a minor GitHub outage; re-run remained queued. | Deployed a **temporary hotpatch** by copying locally built `/Users/Shared/Gits/YenHubs/hubs/dist/assets` + `dist/*.html` into the running `hubs` pod (`/www/hubs/assets` + `/www/hubs/pages`) and injecting `turkeyCfg_*` env meta tags (without restarting the pod). This is **not durable** across pod replacement; a proper image rollout is still preferred when GitHub Actions recovers. |
| 2026-02-09 ~21:45Z | Production incident: `meta-hubs.org` rendered a blank page again; HTML referenced `{{rawhubs-base-assets-path}}/assets/...` (placeholders not rewritten) causing asset 404s and strict MIME/CSP failures in browser. | Root cause: prior hotpatch replaced `/www/hubs/pages/*.html` in the running pod with placeholder versions, but `run.sh` only rewrites placeholders on container start; Reticulum also cached the broken HTML. |
| 2026-02-09 ~21:48Z | Recovery: restarted `deployment/hubs` to restore image-backed pages and rerun `run.sh`; then restarted `deployment/reticulum` to flush cached HTML. | `meta-hubs.org` returned to serving HTML with `https://assets.meta-hubs.org/hubs/assets/...` URLs (no placeholders); site loaded again. |
| 2026-02-09 21:53Z-22:00Z | Retried durable GHCR build/push for arm swing using GitHub Actions run `21842185352` (`custom-docker-build-push`, `Override_Image_Tag=rpm-anim-idle-walk-arms-20260209-24612e845`). | `failure`: GHCR returned `403 Forbidden` on cache importer and blob HEAD during push (default workflow token did not have required package perms / GHCR was denying). |
| 2026-02-09 22:02Z-22:09Z | Dispatched GitHub Actions run `21842475778` with explicit PAT auth (`Override_Registry_Username=yengalvez`, `Override_Registry_Password=<PAT>`) and `Use_Build_Cache=false`. | `success`: published `ghcr.io/yengalvez/hubs:rpm-anim-idle-walk-arms-20260209-24612e845-latest`. |
| 2026-02-09 ~22:11Z | Rolled out `deployment/hubs` to the new image tag via `kubectl set image` and restarted `deployment/reticulum` to refresh cached HTML/asset hashes. | Rollout succeeded; verified `meta-hubs.org` serves 200 and HTML references valid asset URLs; hubs pod now runs the arm-swing build. |

## 2026-02-09 (Avatar Featured + Preview Thumbnails Fix + Deploy)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-09 ~22:40Z | Investigated why “Featured avatars” was empty and why avatar preview thumbnails were missing in the “Change Avatar” UI. | Root cause: `ret0_admin.featured_avatar_listings` filters by `avatars.allow_promotion=true` in addition to `tags.tags ? 'featured'`, so featured-tagged avatars with `allow_promotion=false` are invisible. |
| 2026-02-09 ~22:50Z | Backfilled `allow_promotion=true` for avatars whose `avatar_listings.tags` includes `featured`. | Featured endpoints began returning 7 entries; Featured Avatars list is no longer empty. |
| 2026-02-09 ~22:55Z | Implemented admin fixes in `hubs` and pushed commit `dfdb76bcd`: (1) local `.glb` uploads generate a real thumbnail preview (WebGL snapshot) instead of a placeholder, (2) imported avatars/scenes are auto-marked `allow_promotion=true`, (3) “Feature” button ensures `allow_promotion=true` for the underlying avatar/scene, (4) guard against missing `tags` when featuring/unfeaturing. | Fixes should make new imports immediately eligible for Featured lists and show proper preview thumbnails. |
| 2026-02-09 ~23:00Z-23:06Z | Dispatched GitHub Actions run `21844461489` (`custom-docker-build-push`) with `Override_Image_Tag=avatars-featured-previews-20260209-dfdb76bcd` and explicit registry auth inputs. | `success`: published `ghcr.io/yengalvez/hubs:avatars-featured-previews-20260209-dfdb76bcd-latest`. |
| 2026-02-09 ~23:10Z-23:13Z | Rolled out `deployment/hubs` in namespace `hcce` to `ghcr.io/yengalvez/hubs:avatars-featured-previews-20260209-dfdb76bcd-latest` and restarted `deployment/reticulum`. | Rollout succeeded; `meta-hubs.org` serves 200; `/api/v1/media/search?source=avatar_listings&filter=featured` returns 7 entries. |
| 2026-02-09 ~23:15Z | Hardened CI in `hubs` commit `787b5236f`: skip `hubs-RetPageOrigin` (turkey deploy) job unless required secrets are configured. | Prevents noisy failing GitHub Actions runs in forks that don’t have turkey secrets. |

## 2026-02-10 (Admin Import: Fix Import Errors + Listing Activation + Featured Reliability)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-10 ~00:00Z | Implemented `hubs` Admin fixes (commit `83ad93135`): (1) `Approve existing` avatar/scene listings now set `state: active`, (2) import defaults no longer auto-select Base/Default/Featured, (3) local import base-avatar detection falls back to any listing that exposes `gltfs.base` (built-in base bot) when `filter=base` returns none, (4) “Feature” button also activates delisted listings. | Fixes the common failure mode where imports create delisted listings that never show up in user pickers/featured lists, and prevents local `.glb` imports from failing when no base-tagged listing exists yet. |
| 2026-02-10 00:00:37Z-00:07:17Z | GitHub Actions run `21845813611` (`custom-docker-build-push`) for `codex/admin-import-fix-active-featured` with `Override_Image_Tag=admin-import-fix-20260210-83ad93135`. | `failure`: GHCR returned `403 Forbidden` on cache importer and blob HEAD during push (workflow `GITHUB_TOKEN` lacked package write rights / registry secrets not configured). |
| 2026-02-10 00:09:07Z-00:16:51Z | Re-ran GitHub Actions as run `21846017453` with explicit registry auth inputs (`Override_Registry_Password=<PAT>`) and `Use_Build_Cache=false`. | `success`: published `ghcr.io/yengalvez/hubs:admin-import-fix-20260210-83ad93135-latest`. |
| 2026-02-10 ~00:17Z-00:21Z | Rolled out `deployment/hubs` in namespace `hcce` to `ghcr.io/yengalvez/hubs:admin-import-fix-20260210-83ad93135-latest`, then restarted `deployment/reticulum` to refresh cached page-origin HTML/asset hashes. | Deployment healthy; `/admin` now references the new `admin-*.js` hash that exists on `assets.meta-hubs.org` (avoids blank admin page due to 404 hashed assets). |

## 2026-02-11 (Bots MVP Branch Deploy Attempt + Hubs Image Rollout)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-11 14:38Z-14:39Z | Pushed branch `codex/bots-hybrid-mvp` to `yengalvez/hubs` and `yengalvez/hubs-cloud`. | Branches published; ready for CI + deploy. |
| 2026-02-11 14:39:35Z-14:44:09Z | GitHub Actions run `21909457715` (`custom-docker-build-push`) on `yengalvez/hubs` for `codex/bots-hybrid-mvp` (`headSha=0e6699502...`). | `success`: published `ghcr.io/yengalvez/hubs:codex-bots-hybrid-mvp-latest` and `ghcr.io/yengalvez/hubs:codex-bots-hybrid-mvp-23`. |
| 2026-02-11 17:20Z-17:21Z | Regenerated `hcce.yaml` from local values, applied ingress/HAProxy manual fixes (cert-manager + ssl redirect annotations, HAProxy 3.2, remove haproxy container securityContext, keep certs workflow), then `kubectl apply -f hcce.yaml` + RBAC patch + HAProxy rollout restart. | Cluster rollout successful; `deployment/hubs` updated to `ghcr.io/yengalvez/hubs:codex-bots-hybrid-mvp-latest`; `meta-hubs.org` and `/spoke` return `HTTP/2 200`. |
| 2026-02-11 17:21Z | New `bot-orchestrator` deployment came up with `ErrImagePull` (`mozillareality/bot-orchestrator:stable-latest` not available for this environment). | Mitigated by scaling `deployment/bot-orchestrator` to `0` to keep production healthy until a custom orchestrator image is published. |
| 2026-02-11 17:56Z-17:57Z | Installed local container runtime (`docker` + `colima` + `docker-buildx`), built and pushed orchestrator image from `hubs-cloud/community-edition/services/bot-orchestrator` for `linux/amd64`. | Published `ghcr.io/yengalvez/bot-orchestrator:codex-bots-hybrid-mvp-latest` and `ghcr.io/yengalvez/bot-orchestrator:codex-bots-hybrid-mvp-7c39c91`. |
| 2026-02-11 17:57Z-17:58Z | Updated `deployment/bot-orchestrator` to GHCR image and scaled back to `1` replica; then regenerated and re-applied `hcce.yaml` using `OVERRIDE_BOT_ORCHESTRATOR_IMAGE`, re-patched RBAC, and restarted HAProxy. | `bot-orchestrator`, `hubs`, and `haproxy` all `Running` (`1/1`), with images pinned to GHCR/custom tags and `meta-hubs.org`/`meta-hubs.org/spoke` returning `HTTP/2 200`. |

## 2026-02-11 (Bots GPT-5 Nano Hardening + Runner Capacity + Deploy Wiring)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-11 18:00Z-18:46Z | Implemented `bot-orchestrator` production hardening on `codex/bots-hybrid-mvp`: OpenAI Responses API integration (`gpt-5-nano`), structured JSON reply parsing (`reply` + optional `go_to_waypoint`), deterministic fallback on LLM failure, in-memory chat rate-limit, runner queue/capacity model (`MAX_ACTIVE_ROOMS=1`), and `MAX_BOTS_PER_ROOM=5` clamp. | Orchestrator now supports real LLM chat with safe fallback and low-cost runner scheduling behavior. |
| 2026-02-11 18:00Z-18:46Z | Added runner runtime pieces in `services/bot-orchestrator`: new `run-bot.js`, Dockerfile update with Chromium runtime, and package updates (`puppeteer-core`, `docopt`, `query-string`). | Service can autostart one technical room runner process from inside the orchestrator container. |
| 2026-02-11 18:00Z-18:46Z | Wired deploy config/template for bots+LLM in `hubs-cloud/community-edition/generate_script/hcce.yam` and generator fallback logic (`OPENAI_API_KEY` <- legacy `OPENAI`; auto-generate `BOT_ACCESS_KEY` if omitted). | Generated manifests now include `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5-nano`, runner envs, and low-cost capacity defaults. |
| 2026-02-11 18:00Z-18:46Z | Aligned bot-count limits to `0..5` in Hubs UI and Reticulum normalization paths (`RoomSettingsSidebar`, `bot-runner-system`, `ret/hub.ex`, `hub_channel.ex`, bot controllers). | Client/backend limits are now consistent with low-cost production mode. |
| 2026-02-11 18:00Z-18:46Z | Added feature documentation at `features/bots/README.md` (usuario/admin + troubleshooting), and updated deployment/rules docs for required bot secrets (`BOT_ACCESS_KEY`, `OPENAI_API_KEY`) and verification steps. | Docs now cover operation and troubleshooting for future bot rollouts. |

## 2026-02-11 (Bots Deploy Completion + Reticulum Readiness Fix + Production Verification)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-11 ~19:08Z-19:12Z | Detected `reticulum` rollout stuck (`1/2 Ready`) after enabling global bots feature flags. | Readiness probe `GET /?skipadmin` returned 500 repeatedly; rollout blocked by old replica pending termination. |
| 2026-02-11 ~19:12Z-19:14Z | Root-cause analysis from pod logs showed `CaseClauseError` in `Ret.AppConfig.get_config/1`: DB value type mismatch for `ret0.app_configs.value`. | Confirmed `features|enable_room_bots` and `features|enable_bot_chat` were stored as raw JSON boolean (`true`) instead of expected object wrapper (`{\"value\": true}`). |
| 2026-02-11 ~19:14Z-19:16Z | Corrected both rows in PostgreSQL to `{\"value\": true}` and rechecked rollout. | New reticulum pod became `2/2 Ready`; deployment rollout completed successfully. |
| 2026-02-11 ~19:16Z-19:20Z | Verified production health and TLS: `meta-hubs.org` + `/spoke` HTTP 200, certificate issuer `Let's Encrypt R13`, hubs and bot-orchestrator images pinned to final GPT-5 Nano tags. | Site healthy and on correct images (`ghcr.io/yengalvez/hubs:bots-gpt5nano-20260211-f9c07d368-latest`, `ghcr.io/yengalvez/bot-orchestrator:bots-gpt5nano-20260211-4cda738-latest`). |
| 2026-02-11 ~19:20Z-19:24Z | Smoke-tested bot orchestrator internals: `room-config` clamp, chat response via LLM, queue/capacity behavior (`MAX_ACTIVE_ROOMS=1`, `MAX_BOTS_PER_ROOM=5`). | Confirmed clamp to 5, `gpt-5-nano` responses with `go_to_waypoint`, and `queued_capacity` behavior when second room is enabled. |
| 2026-02-11 ~19:24Z-19:27Z | Found runner crash in logs: `TypeError: querystring.stringify is not a function` from `run-bot.js`. Implemented fix using `URLSearchParams`, pushed `de457fb`, built via Actions run `21919717500`, and rolled out `bot-orchestrator`. | Crash loop removed; runner starts with valid URL query string. |
| 2026-02-11 ~19:27Z-19:29Z | Detected runner lifecycle issue (`detached Frame` retry loop after room stop). Hardened `run-bot.js` with bounded retries + page recreation + SIGTERM/SIGINT shutdown, pushed `f04cdfd`, built via Actions run `21919851347`, and rolled out. | Runner now exits cleanly on stop and no longer loops on detached frame errors. |
| 2026-02-11 ~19:29Z-19:31Z | Added chat action fallback in `bot-orchestrator` (`app.js`): if LLM omits `action`, apply `detectWaypointAction` from user message/context. Pushed `a02d43b`, built via Actions run `21919952860`, and rolled out `ghcr.io/yengalvez/bot-orchestrator:bots-gpt5nano-20260211-a02d43b-latest`. | `ve a spawbot-2` now returns deterministic action (`go_to_waypoint`) even when model reply omits it; production healthy after rollout. |
| 2026-02-11 ~19:46Z-19:49Z | Incident: rooms failed to join with UI message `Imposible conectarse a esta sala` and console error `JsonWebTokenError: invalid signature`. | Root cause: `reticulum` and `dialog` had mismatched JWT key material (`PERMS_KEY`) after secret regeneration/partial restarts. Restarting `deployment/dialog` aligned keys and room join recovered immediately. |
| 2026-02-11 ~19:49Z | Hardening: updated `generate_script/index.js` to preserve existing `PERMS_KEY` (generate only when missing), derive public JWK from that key, and avoid accidental rotation on every `gen-hcce`. | Prevents future silent key drift causing room connection failures. |

## 2026-02-11 (Bots Runner Navigation Timeout Fix + Successful Rollout)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-11 ~23:40Z | Patched `hubs-cloud/community-edition/services/bot-orchestrator/run-bot.js` (commit `f146cae`) to stop using `waitUntil: \"networkidle2\"` and wait for explicit startup readiness (`scene entered` + `NAF connected`) with retry-safe timeouts. | Removed false navigation timeouts that caused runner restart loops. |
| 2026-02-11 ~22:48Z-22:51Z | Triggered Actions run `21926135680` for bot-orchestrator image build. | `failure`: `failed to read dockerfile: open Dockerfile: no such file or directory` due incorrect override (`Override_Dockerfile=Dockerfile`). |
| 2026-02-11 ~22:50Z-22:51Z | Triggered Actions run `21926174128` with corrected Dockerfile path handling. | `failure`: GHCR push denied (`403 Forbidden` on blob HEAD). |
| 2026-02-11 ~22:52Z-22:53Z | Triggered Actions run `21926216670` with explicit registry auth inputs (`Override_Registry_Username` + `Override_Registry_Password` PAT). | `success`: published `ghcr.io/yengalvez/bot-orchestrator:bots-runnerfix-20260211-f146cae-latest`. |
| 2026-02-11 ~22:53Z-22:54Z | Rolled out `deployment/bot-orchestrator` in namespace `hcce` via `kubectl set image` to `ghcr.io/yengalvez/bot-orchestrator:bots-runnerfix-20260211-f146cae-latest`. | Rollout `success`; new pod `bot-orchestrator-7cb5684689-jnl5p` running. |
| 2026-02-11 ~22:54Z-22:58Z | Verified runtime via orchestrator `/health`, forced `room-config` for room `VJopCY3`, and validated in-room with Playwright. | Runner state `running`, active hub list includes `VJopCY3`, and clients observe bot entities (`[bot-info]` present). |

## 2026-02-13 (Room Connection Outage Fix + Dialog PERMS_KEY Unescape + Build Badge)

Time reference: UTC.

| Time | Action | Result |
|------|--------|--------|
| 2026-02-13 ~09:03Z-09:10Z | Reproduced the “room won’t load” issue via Playwright: UI shows `Imposible conectarse a esta sala`, with console errors originating from Dialog JWT verification (`JsonWebTokenError: invalid signature` / `secretOrPublicKey must...`). | Confirmed it was not missing assets/404; it was a signaling/auth failure between client and `dialog` (`stream.<domain>:4443`). |
| 2026-02-13 ~09:20Z-09:38Z | Shipped a custom `dialog` image that writes a valid `/app/certs/perms.pub.pem` by unescaping `PERMS_KEY` (handles double-escaped `\\\\n`) at runtime; fixed the `dialog` Dockerfile runtime Node version to match the build stage (avoids native module ABI crash). | `deployment/dialog` returned to `Running` and accepted protoo websocket connections. |
| 2026-02-13 ~09:39Z-09:41Z | Restarted `deployment/reticulum` so both `reticulum` and `dialog` used the same current `PERMS_KEY` from the `configs` secret. | Rooms load again (lobby shows `Join Room` instead of “Imposible conectarse…”). |
| 2026-02-13 ~09:41Z | Persisted the current `PERMS_KEY` into local deploy inputs (`deployment/input-values.local.yaml` and the working copy `hubs-cloud/community-edition/input-values.yaml`) to prevent silent key rotation on future `gen-hcce` runs (which can break rooms after partial restarts). | Prevents recurrence of “invalid signature” outages caused by regenerated PERMS keys. |
| 2026-02-13 ~09:47Z-09:55Z | Improved the in-room build/version badge logic to prefer the `frontend-<hash>.js` bundle hash (instead of matching the first hashed script like `webxr-polyfill-*`), built/pushed a new Hubs image via GitHub Actions, and rolled it out. | Toolbar now shows the correct build fingerprint (e.g. `743fbc0e`) to confirm which version is running in production. |

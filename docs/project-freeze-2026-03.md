# Project Freeze Handoff - March 2026

This document is the recovery guide for restarting YenHubs without relying on chat history.

## What was frozen

- Superproject: `/Users/Shared/Gits/YenHubs`
- Client subrepo: `/Users/Shared/Gits/YenHubs/hubs`
- Deployment subrepo: `/Users/Shared/Gits/YenHubs/hubs-cloud`
- Domain: `meta-hubs.org`
- DigitalOcean cluster: `hubs-ce` (region `ams3`)
- Namespace: `hcce`
- Bots backend at shutdown: `ghost`
- Shutdown status: completed on `2026-03-16` with no remaining cluster, node, load balancer, or DO block volumes

## Final branch model

- Superproject base branch: `main`
- `hubs` base branch: `master`
- `hubs-cloud` base branch: `master`
- Final merged `hubs/master`: `7aa9a35f4d3d6e9ac48cdf3cebf4553073f43823`
- Final merged `hubs-cloud/master`: `832d8e39566e22768b816422bffc9417f9f5a53c`

Do not assume the subrepos were renamed to `main`. They were intentionally left on `master` to avoid extra migration risk during closure.

## Local backup bundle created for shutdown

Backup folder:

```bash
/Users/Shared/Gits/YenHubs/output/project-freeze-20260316-090114/
```

Important files inside:

- `retdb-20260316-090114.sql.gz` - PostgreSQL dump from the live CE database
- `deployment-images.txt` - exact deployed image tags before shutdown
- `k8s-hcce-core.yaml` - exported core workloads/services/ingresses/PVCs
- `doctl-cluster-hubs-ce.json` - cluster metadata snapshot
- `git-heads.env` - repo heads recorded before final merge/shutdown
- `input-values.local.yaml` - local deployment values copy (sensitive, not for git)
- `input-values.working-copy.yaml` - working copy used by `gen-hcce`

## Sensitive configuration that stays local

These items must not be committed, but are required to rebuild:

- `/Users/Shared/Gits/YenHubs/deployment/input-values.local.yaml`
- the copied values file in the backup bundle
- API keys/tokens referenced by deployment values
- any kubeconfig or local `doctl` auth state

## Final production images before shutdown

- Hubs: `ghcr.io/yengalvez/hubs:runtime-fix-20260219-5e1344b00-55`
- Bot orchestrator: `ghcr.io/yengalvez/bot-orchestrator:ghost-fullsync-20260307-e38b70d-latest`
- Reticulum: `ghcr.io/yengalvez/reticulum:ret-cspfix-20260219-984ba9a-latest`
- Dialog: `ghcr.io/yengalvez/dialog:dialog-permsfix-20260213-1b23c9e-latest`

The authoritative full list is in `deployment-images.txt` inside the backup folder.

## Recovery order

1. Check out the merged base branches:
   - superproject `main`
   - `hubs/master`
   - `hubs-cloud/master`
2. Install tooling on the Mac:
   - `kubectl`
   - `doctl`
   - `helm`
   - `node`
3. Recreate the DigitalOcean cluster:
   - name `hubs-ce`
   - region `ams3`
   - one 8GB RAM / 4vCPU node
   - no HA
4. Restore kubeconfig with:
   - `doctl kubernetes cluster kubeconfig save hubs-ce`
5. Reinstall cert-manager and reapply:
   - `/Users/Shared/Gits/YenHubs/deployment/ingress-class.yaml`
   - `/Users/Shared/Gits/YenHubs/deployment/cluster-issuer.yaml`
6. Restore deployment values:
   - copy `input-values.local.yaml` into `hubs-cloud/community-edition/input-values.yaml`
7. Generate manifests:
   - `cd hubs-cloud/community-edition`
   - `npm ci`
   - `npm run gen-hcce`
8. Reapply the known manual `hcce.yaml` edits from `/Users/Shared/Gits/YenHubs/deployment/README.md`.
9. Deploy with `kubectl apply -f hcce.yaml`, patch HAProxy RBAC if needed, then restart HAProxy.
10. Restore the database dump into the new `pgsql` pod.
11. Validate:
   - home page
   - room entry
   - avatar selection/upload
   - bots with `ghost` runner
   - HTTPS/TLS

## Shutdown verification performed

- `doctl kubernetes cluster list` -> empty
- `doctl compute droplet list` -> no project worker node remaining
- `doctl compute load-balancer list` -> empty
- `doctl compute volume list` -> empty

## Critical gotchas

- The real CE database name is `retdb`, not `ret_dev`.
- `PERMS_KEY` must remain stable between deploys or Dialog/auth flows can break.
- `hubs-cloud/community-edition/input-values.yaml` is a working file and should stay out of git history.
- The cheapest full stop is deleting the cluster, not scaling to zero.
- Bots were left on `ghost` specifically to avoid Chromium cost.
- If rooms break after rebuild, first verify ingress manual edits, deployed image tags, and the preserved local values file.

## Where to look first when resuming

- Operational deploy guide: `/Users/Shared/Gits/YenHubs/deployment/README.md`
- Feature notes for bots: `/Users/Shared/Gits/YenHubs/features/bots/README.md`
- Historical implementation trail: `/Users/Shared/Gits/YenHubs/docs/session-changelog.md`

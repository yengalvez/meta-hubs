# YenHubs Deployment Guide

Hubs Community Edition 2.0.0 on DigitalOcean Kubernetes with automated SSL via cert-manager.

> **Last updated**: July 2026 | **Cluster**: `hubs-ce` active on DOKS `1.34.8-do.2`, `HA=false` | **Region**: AMS3
>
> The March baseline and database are restored. Mailtrap uses the `info@meta-hubs.org` account; Reticulum derives
> the sender as `noreply@<HUB_DOMAIN>` and has no `SMTP_FROM` input. DNS/TLS validation is the remaining reactivation
> gate before switching from the frozen images to the July audited candidates.

---

## Architecture

```
Internet
    |
    v
DigitalOcean regional Load Balancer (one instance; IP assigned on creation)
Ports: 80, 443, 4443, 5349
    |
    v
HAProxy Ingress Controller (haproxytech/kubernetes-ingress:3.2)
- Routes traffic by host/path
- TLS termination (certs from cert-manager)
- ssl-redirect per ingress annotation
    |
    +---> Reticulum (:4001)    -- API server, serves Hubs/Spoke HTML
    +---> Hubs (:8080)         -- Custom web client
    +---> Spoke (:8080)        -- Scene editor
    +---> Dialog (:4443)       -- WebRTC signaling (stream.domain)
    +---> Nearspark (:5000)    -- CORS image proxy (cors.domain)
    +---> Coturn (:5349)       -- STUN/TURN for WebRTC NAT traversal
    +---> PostgreSQL (:5432)   -- Database (via pgbouncer)

cert-manager (namespace: cert-manager)
- ClusterIssuer: letsencrypt-prod
- Auto-renews SSL certs every ~60 days
- HTTP-01 challenges via HAProxy
```

## Final Production State Before Freeze

| Component | Version / Image |
|-----------|----------------|
| Kubernetes | 1.34.1-do.3 |
| HAProxy | `haproxytech/kubernetes-ingress:3.2` |
| Hubs client | `ghcr.io/yengalvez/hubs:runtime-fix-20260219-5e1344b00-55` |
| Reticulum | `ghcr.io/yengalvez/reticulum:ret-cspfix-20260219-984ba9a-latest` |
| Spoke | `hubsfoundation/spoke:stable-latest` |
| Dialog | `ghcr.io/yengalvez/dialog:dialog-permsfix-20260213-1b23c9e-latest` |
| Bot orchestrator | `ghcr.io/yengalvez/bot-orchestrator:ghost-fullsync-20260307-e38b70d-latest` |
| Coturn | `mozillareality/coturn:stable-latest` |
| PostgreSQL | `mozillareality/postgres:stable-latest` |
| cert-manager | v1.19.3 (Helm chart) |
| Helm | v3.20.0 |

Final runtime notes before the project freeze:

- Domain: `meta-hubs.org`
- Cluster name: `hubs-ce`
- Namespace: `hcce`
- Bots backend: `ghost`
- Hubs repo base branch: `master`
- Hubs-cloud repo base branch: `master`
- Superproject base branch: `main`

## Audited Candidate Images (July 2026)

These images were built by the approved GitHub Actions workflows and are pinned in the local ignored values file.
They have not yet been validated in DOKS. The non-HA cluster and March baseline are restored, so these candidates
must only be rolled out after DNS/TLS and the frozen baseline pass their live smoke tests:

| Component | Candidate image | Actions run |
|-----------|-----------------|-------------|
| Hubs client | `ghcr.io/yengalvez/hubs:audit-20260713-430d98939-latest` | `29285879154` |
| Reticulum | `ghcr.io/yengalvez/reticulum:audit-20260713-ret-ff26b96-latest` | `29285617020` |
| Bot orchestrator | `ghcr.io/yengalvez/bot-orchestrator:audit-20260713-bots-5eb70e1-latest` | `29285037607` |

## Cost

| Resource | Monthly |
|----------|---------|
| DOKS Node (8GB RAM, 4 vCPU) | $48 |
| Load Balancer | $12 |
| Block Storage (2x 10Gi PVC) | ~$2 |
| SMTP (Mailtrap free tier) | $0 |
| **Total** | **~$62** |

> The 4GB node ($24) is NOT enough. Hubs CE uses ~3.5GB at idle. With 4GB, pods get OOM-killed and evicted in a cascade.

Pricing references: [DOKS](https://docs.digitalocean.com/products/kubernetes/details/pricing/),
[regional Load Balancers](https://docs.digitalocean.com/products/networking/load-balancers/details/pricing/) and
[block storage](https://docs.digitalocean.com/products/volumes/details/pricing/).

## Avoid Surprise DigitalOcean Charges

- Each additional Kubernetes `Service` of type `LoadBalancer` typically adds an extra DigitalOcean Load Balancer (about **$12/mo** each).
- Adding nodes (or extra node pools) increases monthly cost immediately.
- Increasing PVC sizes increases block storage cost.

For normal feature iteration, build with the approved GitHub Actions workflow, update the local image override, run
`gen-hcce`, review the generated manifest and deploy with `kubectl apply`. Do not use `kubectl set image` or another
deployment path unless the owner explicitly approves an emergency exception.

---

## Prerequisites

- **Node.js** v20+ ([nodejs.org](https://nodejs.org))
- **kubectl** matching your cluster version ([kubernetes.io](https://kubernetes.io/docs/tasks/tools/))
- **Helm** v3+ ([helm.sh](https://helm.sh/docs/intro/install/))
- **Git**
- **DigitalOcean account** with payment method
- **Domain name** with DNS access
- **SMTP service** (Mailtrap, Scaleway, etc.)

Before recreating a frozen deployment, run the read-only preflight from the repository root:

```bash
./deployment/preflight-reactivation.sh
```

It validates tools, pinned submodules, backup integrity, required local keys, GitHub/GHCR access, and DigitalOcean authentication without printing secrets or creating cloud resources.

---

## Deploy From Scratch

### Step 1: Create DigitalOcean Kubernetes Cluster

For the July 2026 restoration, reproduce the last known topology before testing Kubernetes upgrades:

```bash
doctl kubernetes cluster create hubs-ce \
  --region ams3 \
  --version 1.34.8-do.2 \
  --size s-4vcpu-8gb \
  --count 1 \
  --ha=false \
  --auto-upgrade=false \
  --surge-upgrade=true \
  --maintenance-window sunday=03:00 \
  --wait
```

Equivalent panel settings:

| Parameter | Value |
|-----------|-------|
| K8s version | `1.34.8-do.2` for baseline restoration |
| Region | `ams3` |
| Scaling | Fixed |
| Machine type | Basic, Regular SSD |
| Node plan | `s-4vcpu-8gb` (**$48/mo - 8GB RAM / 4 vCPU**) |
| Nodes | 1 |
| High Availability | No |

Use the exact name `hubs-ce` so backup and operational commands remain valid. Upgrade Kubernetes only after the
restored baseline passes smoke tests and a new database dump exists.

> **Cost guard for Kubernetes 1.36+**: set `HA=false` explicitly when using the API/CLI. If the `ha` field is omitted, newer DOKS create APIs can enable HA by default, which adds $40/month.

### Step 2: Connect kubectl

```bash
# Use the project context already authenticated on this Mac.
doctl auth switch --context yenhubs
doctl kubernetes cluster kubeconfig save hubs-ce

# Option B: download kubeconfig from DO dashboard
# Kubernetes > your-cluster > Download Config
# Then: export KUBECONFIG=~/path-to-kubeconfig.yaml

# Verify
kubectl get nodes  # Should show 1 node, STATUS: Ready
```

### Step 3: Configure Firewall

DigitalOcean > Networking > Firewalls > Create Firewall.

**Inbound rules** (delete the default SSH rule):

| Protocol | Port(s) | Source | Purpose |
|----------|---------|--------|---------|
| TCP | 80 | All IPv4 + IPv6 | HTTP / ACME challenges |
| TCP | 443 | All IPv4 + IPv6 | HTTPS |
| TCP | 4443 | All IPv4 + IPv6 | Hubs dialog (WebRTC) |
| TCP | 5349 | All IPv4 + IPv6 | STUN/TURN |
| UDP | 35000-60000 | All IPv4 + IPv6 | WebRTC media |

Apply to your cluster's droplet tag.

> Do this BEFORE deploying. cert-manager needs port 80 open for HTTP-01 challenges.

### Step 4: Install cert-manager

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --version v1.19.3 \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true \
  --set webhook.timeoutSeconds=10
```

> `webhook.timeoutSeconds=10` is **required** on DigitalOcean. The default (30s) exceeds DO's clusterlint limit (29s) and blocks K8s upgrades.

Verify:
```bash
kubectl get pods -n cert-manager
# 3 pods should be Running: cert-manager, cainjector, webhook
```

### Step 5: Create IngressClass + ClusterIssuer

```bash
kubectl apply -f deployment/ingress-class.yaml
kubectl apply -f deployment/cluster-issuer.yaml
```

Verify:
```bash
kubectl get ingressclass           # NAME: haproxy, CONTROLLER: haproxy.org/...
kubectl get clusterissuer          # NAME: letsencrypt-prod, READY: True
```

### Step 6: Configure input-values.yaml

```bash
# Preferred (real local values kept outside subrepo history):
cp deployment/input-values.local.yaml hubs-cloud/community-edition/input-values.yaml

# First-time setup only (if input-values.local.yaml does not exist yet):
# cp deployment/input-values.example.yaml hubs-cloud/community-edition/input-values.yaml
```

> Security note: este fork ignora `hubs-cloud/community-edition/input-values.yaml` mediante
> `hubs-cloud/.gitignore`. Comprueba siempre `git status` antes de un commit y nunca fuerces
> (`git add -f`) este archivo: contiene secretos reales del despliegue.

Edit `hubs-cloud/community-edition/input-values.yaml` with your real values:
- `HUB_DOMAIN` - your domain
- `ADM_EMAIL` - admin email for first login
- `SMTP_*` - your SMTP credentials
- `NODE_COOKIE`, `GUARDIAN_KEY`, `PHX_KEY` - **generate random 32+ character strings** (use `openssl rand -base64 48`)
- `PERSISTENT_VOLUME_STORAGE_CLASS` - `do-block-storage` for DigitalOcean
- `OVERRIDE_HUBS_IMAGE` - set this to your custom client image when you ship client-side features (official `hubsfoundation/hubs:*` images do not include local code changes)
- `OVERRIDE_BOT_ORCHESTRATOR_IMAGE` - set this to your custom bot orchestrator image when room bots/chat are enabled
- `BOT_ACCESS_KEY` - random shared key used by Reticulum <-> bot-orchestrator internal calls
- `OPENAI_API_KEY` - API key used by bot-orchestrator for LLM chat (model defaults to `gpt-5-nano`)
- `OVERRIDE_HAPROXY_IMAGE` - set to `haproxytech/kubernetes-ingress:3.2` for modern K8s compatibility

### Step 7: Generate hcce.yaml

```bash
cd hubs-cloud/community-edition
npm ci
npm run gen-hcce
```

Verify: `ls -lh hcce.yaml` should be 50-250KB.

### Step 8: Verify the generated manifest

`npm run gen-hcce` now runs `verify-generated-manifest.js` automatically. Generation fails unless all of these
invariants hold:

- `ret`, `dialog` and `nearspark` use cert-manager and per-ingress SSL redirect;
- every application ingress selects `haproxy` through `spec.ingressClassName`;
- global SSL redirect is disabled so ACME HTTP-01 solver ingresses remain reachable;
- HAProxy does not use the legacy Mozilla image or security context;
- HAProxy RBAC contains CRD and Gateway API permissions;
- no obsolete self-signed bootstrap secret or unresolved placeholder remains;
- exactly one `LoadBalancer` service and two 10 GiB DigitalOcean PVCs are generated.

Do not edit `hcce.yaml` manually. Fix the tracked template or input values and regenerate it.

### Step 9: Apply

```bash
kubectl apply -f hcce.yaml
```

### Step 10: Verify HAProxy RBAC and rollout

RBAC is part of the tracked template; no post-apply patch is required:

```bash
kubectl auth can-i list customresourcedefinitions.apiextensions.k8s.io \
  --as=system:serviceaccount:hcce:haproxy-sa
kubectl auth can-i list gateways.gateway.networking.k8s.io \
  --as=system:serviceaccount:hcce:haproxy-sa
kubectl rollout status deployment/haproxy -n hcce --timeout=5m
```

### Step 11: Get Load Balancer IP + Configure DNS

```bash
kubectl -n hcce get svc lb
# Wait for EXTERNAL-IP (1-3 min)
```

Create 4 A records in your DNS provider:

| Host | Type | Value |
|------|------|-------|
| `@` | A | EXTERNAL-IP |
| `assets` | A | EXTERNAL-IP |
| `cors` | A | EXTERNAL-IP |
| `stream` | A | EXTERNAL-IP |

Verify propagation:
```bash
dig yourdomain.com +short
dig assets.yourdomain.com +short
```

### Step 12: Wait for SSL Certificates

cert-manager will automatically request certificates once DNS propagates:

```bash
kubectl get certificates -n hcce
# Wait until all 4 show READY: True (2-5 min after DNS propagation)
```

If stuck:
```bash
kubectl get challenges -n hcce          # Check challenge status
kubectl describe challenge -n hcce      # Detailed error info
kubectl logs deployment/cert-manager -n cert-manager --tail=50
```

### Step 13: Finalize SSL

Once all certificates are READY:

```bash
kubectl get certificates -n hcce
curl -sI https://yourdomain.com
openssl s_client -connect yourdomain.com:443 -servername yourdomain.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

There is no bootstrap certificate to remove and no RBAC patch to repeat. Both were historical workarounds that are
now eliminated from the generator.

### Step 14: Login and Verify

1. Open `https://yourdomain.com` - should show Hubs with green padlock
2. Enter your admin email > check email for magic link > click it
3. Access admin panel at `https://yourdomain.com/admin`

Run the tracked read-only verifier from the repository root. It checks all four DNS records and certificates,
deployment readiness, restored DB counts, public HTTPS and the ghost-runner health contract without printing keys:

```bash
./deployment/verify-live-reactivation.sh
```

Do not continue to audited images or upstream upgrades until it reports zero failures. Functional room/UI tests are
still required afterwards; this script proves infrastructure health, not visual correctness.

---

## Content Bootstrap (Base/Default Avatars + Default Scene)

A fresh Hubs CE install often has **zero approved avatar/scene listings**. This is normal, but it breaks flows that assume listings exist (for example, the avatar editor and local avatar uploads from the Admin panel).

### Minimum required

1. **At least 1 base avatar listing** (tagged `base`)
2. **At least 1 default avatar listing** (tagged `default`)
3. **At least 1 default scene listing** (tagged `default`)

### Recommended bootstrap source

Use the official demo site as a known-good source:

```text
# Base avatars (pick 1)
https://demo.hubsfoundation.org/avatars/SSNk5gu    # Avatar Base - Bot
https://demo.hubsfoundation.org/avatars/wvaCk6Q    # Avatar Base - Default Block Avatar
https://demo.hubsfoundation.org/avatars/2QuHJnl    # Avatar Base - Bot Alternate
```

### Bootstrap workflow

1. Go to `Admin -> Import Content`.
2. Paste one URL from the list above.
3. Click `Preview Import`.
4. Ensure `Set to Base`, `Set to Default`, and `Featured` are checked.
5. Click `Import`.
6. Repeat as needed (for example import a default scene).

### Verify base avatars exist (API)

```bash
curl -s 'https://yourdomain.com/api/v1/media/search?filter=base&source=avatar_listings' | head -c 200
```

If this returns `entries: []`, local avatar creation will fail with a `400` when trying to create an avatar (because Reticulum expects new avatars to reference an existing base avatar listing).

---

## Redeploy After Code Changes

When you modify the Hubs client, Reticulum, or any configuration:

```bash
# 1. Update input-values.yaml if needed

# 2. Regenerate manifest
cd hubs-cloud/community-edition
npm run gen-hcce

# 3. Apply only after the automatic manifest verifier passes
kubectl apply -f hcce.yaml

# 4. Verify
kubectl get pods -n hcce            # All Running
kubectl get certificates -n hcce    # All READY: True
kubectl get deployment hubs -n hcce -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl get deployment bot-orchestrator -n hcce -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl port-forward deployment/bot-orchestrator -n hcce 15001:5001 &
curl -s http://127.0.0.1:15001/health | jq .
curl -sI https://your-domain.com    # HTTP/2 with valid TLS
```

Optional bot smoke test (internal API):

```bash
BOT_KEY=$(kubectl get secret configs -n hcce -o jsonpath='{.data.BOT_ACCESS_KEY}' | base64 --decode)

curl -s -X POST http://127.0.0.1:15001/internal/bots/room-config \
  -H "content-type: application/json" \
  -H "x-ret-bot-access-key: $BOT_KEY" \
  -d '{"hub_sid":"smoketest-room","bots":{"enabled":true,"count":2,"mobility":"medium","chat_enabled":true}}' | jq .
```

### Activar flags globales de bots (sin romper Reticulum)

Si activas flags en `ret0.app_configs` para mostrar bots/chat en todas las salas, **no** escribas un booleano JSON plano en `value`.

`ret0.app_configs.value` debe guardarse como objeto con wrapper:

- Correcto: `{"value": true}`
- Incorrecto: `true`

Si guardas `true` plano, Reticulum puede fallar en readiness con errores como:
`cannot load true as type :map for field :value`

Ejemplo seguro:

```sql
insert into ret0.app_configs (app_config_id, key, value, inserted_at, updated_at)
values
  ((extract(epoch from now()) * 1000000)::bigint, 'features|enable_room_bots', '{"value": true}'::jsonb, now(), now()),
  ((extract(epoch from now()) * 1000000)::bigint + 1, 'features|enable_bot_chat', '{"value": true}'::jsonb, now(), now())
on conflict (key) do update
set value = excluded.value, updated_at = now();
```

Y después:

```bash
kubectl -n hcce rollout restart deployment/reticulum
kubectl -n hcce rollout status deployment/reticulum --timeout=300s
```

---

## Custom Hubs Client Rollout

Use this when shipping client-side features (for example third-person camera, UI changes, avatar logic).

### Recommended Loop (No Extra DigitalOcean Cost)

The cheapest and most reliable loop is:

1. Push code to GitHub.
2. Build + push the image in **GitHub Actions** (no DO CPU/RAM usage, avoids in-cluster OOM builds).
3. Update `OVERRIDE_HUBS_IMAGE` in the local values file.
4. Run `npm run gen-hcce`, review the diff, and deploy with `kubectl apply`.
5. Verify the rollout and restart Reticulum to refresh page-origin HTML.

Concrete commands (after the image exists in your registry):

```bash
cd /Users/Shared/Gits/YenHubs
cp deployment/input-values.local.yaml hubs-cloud/community-edition/input-values.yaml
cd hubs-cloud/community-edition
npm run gen-hcce
kubectl apply -f hcce.yaml
kubectl -n hcce rollout status deployment/hubs --timeout=300s
kubectl -n hcce get deployment hubs -o jsonpath='{.spec.template.spec.containers[0].image}'; echo

# Reticulum caches the page-origin HTML and hashed asset references. After any hubs image update,
# restart reticulum so /admin and room pages don't reference missing old hashes.
kubectl -n hcce rollout restart deployment/reticulum
kubectl -n hcce rollout status deployment/reticulum --timeout=300s

curl -sI https://meta-hubs.org | head -n 1
```

The verifier ensures reapplying the manifest does not lose RBAC or TLS settings. This flow does not create additional
DigitalOcean resources because the manifest is constrained to one `LoadBalancer` service.

Avoid building container images inside the cluster (Kaniko pods) on a single 8GB node: it will often OOM/evict during `npm ci`, and the “fix” (bigger node) increases monthly cost.

If the site is blank and the browser console shows lots of `404` for `https://<hub-domain>/hubs/assets/...`:

- Check that the `ret` Ingress rule for `<hub-domain>` routes `/hubs` to the `hubs` service (and `/spoke` to `spoke`). If it only routes `/` to `ret`, all client asset requests will hit Reticulum and 404.
- Fix the tracked ingress template, regenerate with `npm run gen-hcce`, apply it through the normal flow and restart
  Reticulum. Do not leave a runtime-only patch that the next apply can erase.

### GitHub Actions Image Build (Preferred)

In the `hubs` repo, use the Actions workflow `custom-docker-build-push` to build/push the image (avoids local Docker and avoids in-cluster builds).

1. Go to GitHub Actions in `yengalvez/hubs` and open the workflow `custom-docker-build-push`.
2. Click “Run workflow”.
3. Set `Override_Image_Tag` (example: `rpm-avatar-import-YYYYMMDD-<shortsha>`).

Registry auth for GHCR:

- Recommended: configure repo vars/secrets once:
`REGISTRY_BASE_URL=ghcr.io`, `REGISTRY_NAMESPACE=<owner>`, and secrets `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` (PAT with `write:packages` + `read:packages`).
- Do not pass a PAT through `Override_Registry_Password`: workflow-dispatch inputs are retained in the run event. Store it as the masked repository secret `REGISTRY_PASSWORD` instead.
- The automatic `GITHUB_TOKEN` is acceptable only when the target GHCR package grants the repository Actions access. Existing packages such as `bot-orchestrator` may reject it even when the workflow declares `packages: write`.

Common failures:

- `Username and password required`: registry username/password are missing (no secrets, no override inputs).
- `403 Forbidden` from GHCR on HEAD requests (for example buildcache manifests or blobs): the token does not have package rights, or the GHCR package is not granting repo access. Set repository secrets `REGISTRY_USERNAME=<owner>` and `REGISTRY_PASSWORD=<PAT with read:packages + write:packages>`, then rerun the same workflow. Also verify that Actions has read/write workflow permissions and that the workflow requests `packages: write`. Do not switch to a local or in-cluster build as a workaround.
- `failed to read dockerfile: open Dockerfile: no such file or directory` on `hubs-cloud` bot-orchestrator builds: the workflow already defaults to `Override_Code_Path=community-edition/services/bot-orchestrator` and `Override_Dockerfile=community-edition/services/bot-orchestrator/Dockerfile`. Do not set `Override_Dockerfile=Dockerfile`; leave it empty or pass the full path.
- `Invalid workflow file ... Unrecognized named-value: 'secrets'`: the `hubs/.github/workflows/hubs-RetPageOrigin.yml` workflow had a job-level `if:` that referenced `secrets.*` on a job that calls a reusable workflow (`uses:`). GitHub Actions rejects this at parse time. Fix: gate that job using `github.repository_owner` (or an explicit repo var like `ENABLE_TURKEY_GITOPS`) and pass secrets only in the `secrets:` block, not in the job `if:`.
- Docker tag errors when building from branches like `codex/foo`: Docker tags cannot contain `/`. Fix: sanitize the tag in CI (replace `/` with `-`) or set `Override_Image_Tag` to a slash-free value.
- `bot-orchestrator` `ErrImagePull` after `kubectl apply`: `hcce.yaml` may point to `$Container_Dockerhub_Username/bot-orchestrator:$Container_Tag` (often unresolved in forks). Fix by setting `OVERRIDE_BOT_ORCHESTRATOR_IMAGE` to a valid pushed image, or temporarily scale `deployment/bot-orchestrator` to `0` until the image exists.

### Room join error: `Imposible conectarse a esta sala` + `JsonWebTokenError: invalid signature`

Cause:
- `reticulum` and `dialog` are using different `PERMS_KEY` material (JWT signing key mismatch).

Typical trigger:
- Running `gen-hcce` with regenerated keys, applying manifests, then restarting only one of the two deployments.

Fix:
```bash
kubectl -n hcce rollout restart deployment/reticulum
kubectl -n hcce rollout restart deployment/dialog
kubectl -n hcce rollout status deployment/reticulum --timeout=300s
kubectl -n hcce rollout status deployment/dialog --timeout=300s
```

Prevention:
- Keep `PERMS_KEY` stable in `deployment/input-values.local.yaml`.
- Ensure `PERMS_KEY` is actually present in your local inputs. If it is missing, `gen-hcce` will generate a new key on every run and update the `configs` secret; if you then restart only `reticulum` or only `dialog`, rooms will break until both are restarted on the same key.
- If you see `secretOrPublicKey must...` errors from the Dialog websocket (`stream.<domain>:4443`), it usually means Dialog is not loading a valid PEM. Use an `OVERRIDE_DIALOG_IMAGE` that writes `/app/certs/perms.pub.pem` by unescaping the env var (or adjust the Dialog entrypoint accordingly).

### Durable rollout

The durable rollout is the GitHub Actions + local image override + `gen-hcce` + `kubectl apply` sequence above. Local
Docker builds, in-cluster builds and runtime-only patches are not approved deployment methods for this project.

### GHCR notes (if using `ghcr.io`)

- Pushing from automation requires a token with package write scopes (for example PAT with `write:packages` and `read:packages`). Keep it in the repository secret `REGISTRY_PASSWORD`, never in a tracked YAML file or workflow-dispatch input.
- If the token is missing `write:packages`, the push fails with an error like: `permission_denied: The token provided does not match expected scopes.`
- If the package is private, the cluster also needs `imagePullSecrets` for `ghcr.io`; otherwise pods fail with `ErrImagePull` / `ImagePullBackOff`.
- If you are not managing registry auth explicitly, prefer a registry/tag that your cluster can pull without extra setup.

#### Cluster Pull Auth (Private GHCR)

Recommended: attach the pull secret to the **default ServiceAccount** in the namespace so you never forget it in YAML:

```bash
kubectl create secret generic ghcr-pull -n hcce \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/path/to/dockerconfig.json

kubectl patch serviceaccount default -n hcce \
  --type=merge \
  -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
```

If you must patch only one deployment instead:

```bash
kubectl patch deployment hubs -n hcce --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/imagePullSecrets","value":[{"name":"ghcr-pull"}]}]'
```

> Important: if `BASE_ASSETS_PATH` is not set during build, pages may reference `/assets/...` and return 404 in production domains that serve assets from `assets.<domain>/hubs/`.
>
> Debugging tip: the **correct** static host/path is `https://assets.<domain>/hubs/...`. Requests like `https://<domain>/assets/...` can return confusing errors (for example `bad Room ID`) because they hit reticulum instead of the hubs static service.

### Recovery from bad custom image

If hubs rollout gets stuck with `ErrImagePull` / `ImagePullBackOff`:

1. Restore the previous known-good `OVERRIDE_HUBS_IMAGE` in `deployment/input-values.local.yaml`.
2. Copy values, run `npm run gen-hcce`, apply and verify through the standard flow.
3. Do not fall back to an official image: it does not contain YenHubs features and can desynchronize CSP/assets.

---

## Things You Must Know

### RBAC is generated, not patched
`haproxy-cr` includes the required CRD and Gateway API reads in the tracked template. `verify-hcce` rejects a manifest
that drops them, so no post-apply patch is needed.

### ssl-redirect strategy
`ssl-redirect` is set to `false` in the global ConfigMap (`haproxy-config`) and `true` per-ingress via `haproxy.org/ssl-redirect` annotation. This allows cert-manager's temporary solver ingresses (which have no annotation) to serve HTTP challenges without redirect during certificate renewal.

### SMTP ports on DigitalOcean
DigitalOcean blocks outbound ports 25, 465, and 587. Use alternative ports:
- Mailtrap: port **2525**
- Scaleway: port **2587**

### Why not mozillareality/haproxy?
The official Hubs CE HAProxy image (`mozillareality/haproxy:stable-latest`) is based on `haproxytech/kubernetes-ingress:1.8.5` (2022), which only supports K8s 1.21-1.23. Since K8s 1.31 is no longer available on DigitalOcean, this image crashes on every available K8s version. We use `haproxytech/kubernetes-ingress:3.2` directly.

### Why not npm run gen-ssl?
The built-in SSL script (`npm run gen-ssl`) deploys a certbot pod that creates temporary ingresses for ACME challenges. This doesn't work with `haproxytech/kubernetes-ingress:3.2` because the routing priorities differ from the original 1.8.5. cert-manager solves this properly and also handles auto-renewal.

### Minimum node size
8GB RAM is the minimum for production. Hubs CE runs 11 deployments (~3.5GB at idle). The 4GB node ($24/mo) works for testing but causes OOM evictions under any real load.

---

## Troubleshooting

### Certificates not issuing
```bash
kubectl get challenges -n hcce
kubectl describe challenge -n hcce
# Common causes:
#   - DNS not propagated (verify with dig)
#   - Port 80 blocked (check firewall)
#   - ssl-redirect blocking challenges (check haproxy-config ConfigMap)
```

### HAProxy CrashLoopBackOff
```bash
kubectl logs deployment/haproxy -n hcce
# Common causes:
#   - incompatible HAProxy image override
#   - generated RBAC/template verification was bypassed
```

### Magic link email not arriving
```bash
# Test SMTP connectivity from inside the cluster
RET_POD=$(kubectl get pod -n hcce -l app=reticulum -o jsonpath='{.items[0].metadata.name}')
kubectl exec $RET_POD -c reticulum -n hcce -- nc -zv your-smtp-server your-port
# If closed: wrong port, or DO is blocking it
```

### Pod evictions / OOMKilled
```bash
kubectl top pods -n hcce          # Requires metrics-server
kubectl describe node              # Check Allocatable vs Allocated
# Solution: use 8GB node minimum
```

### 503 errors / pods not responding
```bash
kubectl get pods -n hcce                    # Check for CrashLoopBackOff
kubectl logs deployment/<name> -n hcce      # Check logs
kubectl rollout restart deployment -n hcce  # Restart all pods
```

### Featured avatars/scenes are empty

Hubs CE’s `featured_*` views filter on both:

- the listing tag: `tags.tags` contains `"featured"`
- the underlying object: `avatars.allow_promotion=true` / `scenes.allow_promotion=true`

So if you only add the `"featured"` tag on the listing but `allow_promotion` is still `false`, the Featured lists will stay empty.

Fix options:

- Admin UI: open the underlying Avatar/Scene record and set `allow_promotion=true`.
- Prefer: use the Admin “Feature” button on the listing (this repo’s `hubs` admin code makes “Feature” also set `allow_promotion=true` automatically).

### Avatar thumbnails missing in “Change Avatar”

Avatar tiles use the thumbnail owned file (e.g. `thumbnail_owned_file_id` / `images.preview.url`). If the avatar/listing has no thumbnail (or a broken owned file), the UI shows a blank/placeholder tile.

Fix:

- Re-upload / re-import the avatar so it gets a fresh thumbnail.
- Or update the avatar’s thumbnail in Admin > Avatars (the local upload flow generates a real thumbnail preview from the GLB on import).

---

## Backups

```bash
# Database backup (do this BEFORE any risky changes)
PGSQL_POD=$(kubectl get pod -n hcce -l app=pgsql -o jsonpath='{.items[0].metadata.name}')
kubectl exec $PGSQL_POD -n hcce -- pg_dump -U postgres retdb > backup_$(date +%Y%m%d).sql

# Built-in backup script (if available in your version)
cd hubs-cloud/community-edition
npm run backup
```

For the project freeze performed in March 2026, a full local snapshot was also saved outside the cluster at:

```bash
/Users/Shared/Gits/YenHubs/output/project-freeze-20260316-090114/
```

That snapshot contains:

- `retdb-*.sql.gz`
- current deployment image tags
- cluster metadata from `doctl`
- Kubernetes manifests/state exports
- local working deployment values copies kept out of git history

### Restore the Reticulum database

The database is named `retdb`. A plain `pg_dump` does not include cluster-level roles, but the restored grants need
the internal NOLOGIN role `ret_admin`. Use the tracked restore script instead of piping the dump directly into an
empty database:

```bash
# Read-only validation first.
RESTORE_DRY_RUN=1 ./deployment/restore-retdb.sh \
  output/project-freeze-20260316-090114/retdb-20260316-090114.sql.gz

# Destructive restore. This temporarily scales DB consumers to zero, recreates
# retdb, creates ret_admin if needed, restores with ON_ERROR_STOP and verifies counts.
CONFIRM_RESTORE=retdb ./deployment/restore-retdb.sh \
  output/project-freeze-20260316-090114/retdb-20260316-090114.sql.gz
```

If the restore fails, consumers intentionally remain at zero. Diagnose the restore before scaling them back or
reapplying the validated manifest.

## Cost Savings

```bash
# Optional maintenance mode: stops application workloads only.
kubectl scale deployment --all --replicas=0 -n hcce

# Scale back up
kubectl scale deployment --all --replicas=1 -n hcce
kubectl get pods -n hcce -w  # Wait for all Running
```

> Scaling deployments to zero does **not** reduce the DigitalOcean bill for this topology. The DOKS node (~$48/mo),
> Load Balancer (~$12/mo) and block volumes (~$2/mo) remain allocated and billable. It only frees CPU/RAM inside
> the already-paid node. For a long pause, make a verified backup and use the full shutdown procedure below.

## Project Freeze / Full Shutdown

Use this path if you are pausing the project for weeks or months and want DigitalOcean cost as close to zero as possible:

```bash
# 1. Confirm backups already exist
ls -lh /Users/Shared/Gits/YenHubs/output/project-freeze-20260316-090114/

# 2. Confirm cluster and LB that will be removed
doctl kubernetes cluster list
doctl compute load-balancer list

# 3. Delete the DOKS cluster (this also removes the managed LB and cluster-attached volumes)
doctl kubernetes cluster delete hubs-ce --force

# 4. Verify there is no cluster left
doctl kubernetes cluster list
doctl compute load-balancer list
doctl compute volume list
```

Expected result:

- the site goes offline until rebuilt
- DOKS node, managed LB, and attached block storage stop billing
- local backups and docs remain the source of truth for future recovery

This shutdown flow was executed successfully on `2026-03-16` and verified until:

- `doctl kubernetes cluster list` returned no clusters
- `doctl compute load-balancer list` returned no active load balancers
- `doctl compute volume list` returned no remaining block volumes

## Rebuild After The Freeze

When resuming the project:

1. Recreate the DOKS cluster in AMS3 with one 8GB / 4vCPU node and no HA.
2. Restore kubeconfig with `doctl kubernetes cluster kubeconfig save hubs-ce`.
3. Reinstall cert-manager and reapply `/Users/Shared/Gits/YenHubs/deployment/ingress-class.yaml` plus `/Users/Shared/Gits/YenHubs/deployment/cluster-issuer.yaml`.
4. Copy the local `input-values.local.yaml` back into `hubs-cloud/community-edition/input-values.yaml`.
5. Run `npm ci && npm run gen-hcce`; the command verifies TLS, ingress class, RBAC and the single-LB invariant.
6. Apply the generated file unchanged with `kubectl apply -f hcce.yaml`.
7. Restore the database dump into the new `pgsql` pod.
8. Validate `meta-hubs.org`, TLS, room entry, avatar flow, and bots (`ghost` backend).

The short handoff checklist for this rebuild is maintained in:

```bash
/Users/Shared/Gits/YenHubs/docs/project-freeze-2026-03.md
```

## References

- [Official Hubs CE Guide](https://docs.hubsfoundation.org/beginners-guide-to-CE.html)
- [cert-manager docs](https://cert-manager.io/docs/)
- [HAProxy Ingress Controller 3.2](https://www.haproxy.com/documentation/kubernetes-ingress/community/)
- [DigitalOcean Kubernetes](https://docs.digitalocean.com/products/kubernetes/)

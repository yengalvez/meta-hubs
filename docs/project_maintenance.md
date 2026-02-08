# Project Maintenance & Development Guide

## Overview

This guide covers the development workflow, deployment strategy, and maintenance procedures for the YenHubs custom Hubs CE deployment.

## Git Architecture

The project uses two **Git Submodules**:

1. **`hubs/`** - Fork of the Hubs client (`yengalvez/hubs`), synced with `Hubs-Foundation/hubs`. Used for custom features (third-person camera, avatar fixes).
2. **`hubs-cloud/`** - Official Hubs deployment tools (`Hubs-Foundation/hubs-cloud`). Contains the `community-edition/` scripts for generating and applying Kubernetes manifests.

### Why Submodules?

- **Version pinning**: Each submodule tracks a specific commit. If an update breaks something, revert the parent repo commit to return to the last working version.
- **Separation**: Project infrastructure (deployment configs, feature docs) stays separate from the massive Hubs client codebase.

### Daily Workflow

#### Modifying the Hubs Client (e.g., applying third-person camera)

```bash
cd hubs
git checkout -b feature/third-person-camera
# Apply diffs
git apply ../features/third-person/commit/store.js.diff
git apply ../features/third-person/commit/camera-system.js.diff
git apply ../features/third-person/commit/preferences-screen.js.diff
git add . && git commit -m "Add third-person camera toggle"
git push origin feature/third-person-camera
# Update parent
cd ..
git add hubs
git commit -m "Update hubs ref: third-person camera"
```

#### Updating from Upstream Hubs

```bash
cd hubs
git remote add upstream https://github.com/Hubs-Foundation/hubs.git  # if not added
git fetch upstream
git merge upstream/master
git push origin master
cd ..
git add hubs
git commit -m "Sync hubs with upstream"
```

#### Updating hubs-cloud

```bash
cd hubs-cloud
git pull origin master
cd ..
git add hubs-cloud
git commit -m "Update hubs-cloud to latest"
```

## Deployment Strategy (DigitalOcean / Kubernetes)

> **Full deployment guide**: [deployment/README.md](../deployment/README.md)

### Architecture

The deployment uses Hubs CE 2.0.0 on DigitalOcean Kubernetes with:

- **HAProxy Ingress Controller** (`haproxytech/kubernetes-ingress:3.2`) — routes all traffic
- **cert-manager** (v1.19.3 via Helm) — automated SSL certificates from Let's Encrypt
- **8GB RAM node** — minimum for production (4GB causes OOM evictions)

### Key Infrastructure Files

| File | Purpose |
|------|---------|
| `deployment/README.md` | Complete deploy-from-scratch guide |
| `deployment/input-values.example.yaml` | Template for input-values.yaml |
| `deployment/cluster-issuer.yaml` | Let's Encrypt ClusterIssuer manifest |
| `deployment/ingress-class.yaml` | HAProxy IngressClass manifest |
| `hubs-cloud/community-edition/input-values.yaml` | Real config values (**gitignored**) |
| `hubs-cloud/community-edition/hcce.yaml` | Generated K8s manifest (**gitignored**) |

### Quick Deploy (New Cluster)

```bash
# 1. Create DOKS cluster (8GB node) + firewall (see deployment/README.md)

# 2. Install cert-manager
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set installCRDs=true --set webhook.timeoutSeconds=10

# 3. Apply infrastructure
kubectl apply -f deployment/ingress-class.yaml
kubectl apply -f deployment/cluster-issuer.yaml

# 4. Configure and generate
cp deployment/input-values.example.yaml hubs-cloud/community-edition/input-values.yaml
# Edit input-values.yaml with real values
cd hubs-cloud/community-edition
npm ci && npm run gen-hcce

# 5. Edit hcce.yaml (4 mandatory changes — see deployment/README.md Step 8)
# 6. Apply + patch RBAC
kubectl apply -f hcce.yaml
kubectl patch clusterrole haproxy-cr --type=json -p '[
  {"op":"add","path":"/rules/-","value":{"apiGroups":["apiextensions.k8s.io"],"resources":["customresourcedefinitions"],"verbs":["get","list","watch"]}},
  {"op":"add","path":"/rules/-","value":{"apiGroups":["gateway.networking.k8s.io"],"resources":["gateways","gatewayclasses","httproutes","referencegrants","tcproutes"],"verbs":["get","list","watch"]}}
]'

# 7. Configure DNS (4 A records) → wait for certs → finalize SSL
# See deployment/README.md Steps 11-14
```

### Redeploy (After Code or Config Changes)

Every time you regenerate and apply `hcce.yaml`, you must repeat the manual edits and RBAC patch:

```bash
# 1. Update input-values.yaml if needed

# 2. Regenerate manifest
cd hubs-cloud/community-edition
npm run gen-hcce

# 3. Edit hcce.yaml — same 4 changes every time:
#    a) Add cert-manager.io/cluster-issuer: "letsencrypt-prod" to 3 ingresses (ret, dialog, nearspark)
#    b) Add haproxy.org/ssl-redirect: "true" to 3 ingresses
#    c) HAProxy image → haproxytech/kubernetes-ingress:3.2 (done via input-values)
#    d) Remove securityContext from HAProxy deployment
#    e) Comment out --default-ssl-certificate (if certs already issued)

# 4. Apply
kubectl apply -f hcce.yaml

# 5. Re-patch RBAC (apply ALWAYS resets the ClusterRole!)
kubectl patch clusterrole haproxy-cr --type=json -p '[
  {"op":"add","path":"/rules/-","value":{"apiGroups":["apiextensions.k8s.io"],"resources":["customresourcedefinitions"],"verbs":["get","list","watch"]}},
  {"op":"add","path":"/rules/-","value":{"apiGroups":["gateway.networking.k8s.io"],"resources":["gateways","gatewayclasses","httproutes","referencegrants","tcproutes"],"verbs":["get","list","watch"]}}
]'

# 6. Restart HAProxy
kubectl rollout restart deployment/haproxy -n hcce

# 7. Verify
kubectl get pods -n hcce            # All Running
kubectl get certificates -n hcce    # All READY: True
curl -sI https://your-domain.com    # HTTP/2 with Let's Encrypt cert
```

> **⚠️ Critical**: The RBAC patch is lost every time you run `kubectl apply -f hcce.yaml`. If you forget to re-patch, HAProxy will log errors about missing API group permissions and eventually fail.

### Custom Client Deployment

If you've modified the Hubs client (e.g., third-person camera, avatar fixes), you need to build a custom Docker image:

1. **Build the client**:
   ```bash
   cd hubs
   npm install
   export RETICULUM_SERVER="meta-hubs.org"
   export BASE_ASSETS_PATH="https://assets.meta-hubs.org/hubs/"
   npm run build
   ```

2. **Option A: Custom Docker Image** (Recommended)
   ```bash
   # Build Docker image with your custom dist/
   docker build -t your-registry/hubs:custom-v1 .
   docker push your-registry/hubs:custom-v1
   # Update OVERRIDE_HUBS_IMAGE in input-values.yaml
   # Then follow the Redeploy steps above (gen-hcce + edit hcce.yaml + apply + RBAC patch)
   ```

3. **Option B: Hot-fix via kubectl cp** (Emergency only)
   ```bash
   POD=$(kubectl get pods -n hcce | grep hubs | grep Running | awk '{print $1}')
   # Copy built assets
   for f in dist/*; do kubectl cp "$f" "$POD:/www/hubs/" -n hcce -c hubs-ce; done
   # IMPORTANT: Also update /www/hubs/pages/hub.html with new bundle references
   # Then restart Reticulum (it caches HTML in memory)
   kubectl rollout restart deployment reticulum -n hcce
   ```
   > **Warning**: The hot-fix method is fragile. Reticulum caches HTML files in memory and uses `/www/hubs/pages/` for templates. If you only copy to `/www/hubs/`, changes requiring new JS bundles won't work until Reticulum restarts AND `pages/` is updated.

### Important Notes

- **HAProxy 3.2 vs mozillareality**: The original `mozillareality/haproxy:stable-latest` image is based on haproxytech 1.8.5 (2022) and only supports K8s 1.21-1.23. Since K8s 1.31 is no longer available on DigitalOcean, we use `haproxytech/kubernetes-ingress:3.2` directly. This requires the `IngressClass` resource and RBAC patch.
- **SSL is fully automated**: cert-manager handles certificate issuance and renewal. The `ssl-redirect` is set to `false` globally and `true` per-ingress annotation, so cert-manager solver ingresses can serve HTTP challenges without being redirected.
- **SMTP ports on DO**: DigitalOcean blocks outbound ports 25, 465, 587. Use Mailtrap (port 2525) or Scaleway (port 2587).
- **`npm run gen-ssl` is obsolete**: The built-in SSL script deploys a certbot pod that doesn't work with HAProxy 3.2. cert-manager replaces this entirely.

## Troubleshooting

### CSP Errors
If external resources (images, scripts, iframes) are blocked:
```bash
kubectl edit configmap ret-config -n hcce
# Update [ret."Elixir.RetWeb.Plugs.AddCSP"] section
# Add domains to frame_src, connect_src, etc.
kubectl rollout restart deployment reticulum -n hcce
```

### Build Failures
```bash
cd hubs
rm -rf node_modules package-lock.json
npm install
npm run build
```

### Pod CrashLoopBackOff
```bash
kubectl get pods -n hcce
kubectl logs <pod-name> -n hcce
kubectl describe pod <pod-name> -n hcce
```

### Certificates Not Renewing
```bash
kubectl get certificates -n hcce    # Check READY status and expiry
kubectl get challenges -n hcce      # Check if challenges are stuck
kubectl describe challenge -n hcce  # Detailed error info
# Common cause: ssl-redirect blocking HTTP challenges
# Check: kubectl get configmap haproxy-config -n hcce -o yaml
# The global ssl-redirect must be "false" (per-ingress handles the redirect)
```

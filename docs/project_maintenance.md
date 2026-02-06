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

### Official Method (kubectl)

The deployment follows the official Hubs CE 2.0.0 method. Full guide: [deployment/README.md](../deployment/README.md)

Quick reference:

```bash
# 1. Configure values
cp deployment/input-values.local.yaml hubs-cloud/community-edition/input-values.yaml

# 2. Generate and apply
cd hubs-cloud/community-edition
npm install
npm run gen-hcce
kubectl apply -f hcce.yaml

# 3. Generate SSL
npm run gen-ssl
```

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
   # Update OVERRIDE_HUBS_IMAGE in input-values.yaml to use your image
   # Regenerate and apply: npm run gen-hcce && kubectl apply -f hcce.yaml
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

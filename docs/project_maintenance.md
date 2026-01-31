# Project Maintenance & Development Guide

## Overview
This guide provides best practices for maintaining the custom Mozilla Hubs client, including development workflows, versioning, and deployment.

## Git Architecture: The "Infrastructure-as-Code" Pattern

To professionally manage your changes ("custom features") alongside the official code and your deployment scripts, we will use a **Git Submodule** strategy. This is the industry standard for projects that "wrap" another large project.

### The Concept
We will have **two** connected repositories:

1.  **Parent Repo (`YenHubs`)**:
    *   **Contains**: Documentation (`docs/`), Deployment configs (`hubs-ce-deployment/`, `values.yaml`), and Helper scripts (`scripts/`).
    *   **Tracks**: The *specific version* of the Hubs code we are currently using.
2.  **Child Module (`hubs/`)**:
    *   **Contains**: The actual Mozilla Hubs application source code.
    *   **Points to**: Your private Fork of Hubs (e.g., `github.com/YenGalvez/hubs`).

### Why this is best?
*   **Safety**: If an update breaks something, you can revert a single commit in `YenHubs`, and it will automatically know to "downgrade" the `hubs/` folder to the last working version.
*   **Clarity**: Your project root only shows your custom infrastructure files. The massive Hubs code is encapsulated.

### Setup Instructions (Migration)

#### Phase 1: Prepare the Hubs Fork
1.  **Fork** `Hubs-Foundation/hubs` on GitHub to your account.
2.  **Rename Remote** in your local terminal:
    ```bash
    cd /Users/Shared/Gits/YenHubs/hubs
    git remote rename origin upstream
    git remote add origin https://github.com/<YOUR_GITHUB_USER>/hubs.git
    git push -u origin master
    ```

#### Phase 2: Create the Parent Repo
1.  Initialize the parent:
    ```bash
    cd /Users/Shared/Gits/YenHubs
    git init
    ```
2.  **Add Hubs as a Submodule**:
    *   *Note: Since you already have the folder, we convert it.*
    ```bash
    git submodule add https://github.com/<YOUR_GITHUB_USER>/hubs.git hubs
    ```
3.  **Track Infrastructure**:
    ```bash
    git add docs/ hubs-ce-deployment/ scripts/ get_helm.sh
    git commit -m "Initial Structure: Infrastructure + Hubs Submodule"
    ```

### Daily Workflow

#### Scenario A: Modifying Hubs (e.g., Camera Fix)
1.  Enter the module: `cd hubs`
2.  Create branch: `git checkout -b feature/better-camera`
3.  Make changes and commit **inside** `hubs`:
    ```bash
    git add .
    git commit -m "Fix camera smoothing"
    git push origin feature/better-camera
    ```
4.  **Update Parent** (Crucial Step):
    *   Go back up: `cd ..`
    *   You will see `hubs` has "changes" (it's pointing to a new commit).
    *   Commit this change to the parent:
        ```bash
        git add hubs
        git commit -m "Update Hubs reference to include Camera Fix"
        ```

#### Scenario B: Updating from Official Mozilla Hubs
1.  Enter module: `cd hubs`
2.  Fetch upstream: `git fetch upstream`
3.  Merge: `git merge upstream/master`
4.  Fix conflicts if any.
5.  Push to your fork: `git push origin master`
6.  **Update Parent**:
    *   `cd ..`
    *   `git add hubs`
    *   `git commit -m "Upgrade Hubs to latest Mozilla version"`

## Deployment Strategy (DigitalOcean / Kubernetes)

### Prerequisites
-   **kubectl**: If not installed, download directly:
    ```bash
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/darwin/arm64/kubectl"
    chmod +x kubectl && mkdir -p ~/bin && mv kubectl ~/bin/
    ```
-   **kubeconfig**: Must be configured for the DigitalOcean cluster `hubs-ce-ams3`.

### 1. Building the Client
-   Ensure production environment variables are set before building:
    ```bash
    export RETICULUM_SERVER="meta-hubs.org"
    export BASE_ASSETS_PATH="https://assets.meta-hubs.org/hubs/"
    npm run build
    ```

### 2. Deployment Methods

#### Quick Patch (Hot-fix) -- USE WITH CAUTION
> [!WARNING]  
> This method is fragile because Reticulum caches HTML files in memory and uses a separate `/www/hubs/pages/` directory for templates. If you only copy to `/www/hubs/`, changes requiring new JS bundles (hashes) will NOT work until Reticulum is restarted AND `pages/` is updated.
 
**Cluster Details:**
-   **Namespace**: `hcce`
-   **Pod**: `moz-hubs-ce-*` (use `kubectl get pods -n hcce | grep hubs`)
-   **Container**: `hubs-ce`

**Correct Hot-fix Procedure:**
1.  **Build**: `npm run build`
2.  **Copy Assets**: Copy `dist/` contents to `/www/hubs/` on the pod.
3.  **Update Pages**: You MUST also update the HTML templates in `/www/hubs/pages/`.
    *   *Critical*: The `dist/hub.html` contains references to the NEW JS bundles (e.g., `hub-abc1234.js`). The `pages/hub.html` has OLD references.
    *   You must replacing the `hub-*.js` and `hub-vendors-*.js` references in `/www/hubs/pages/hub.html` with the new ones from your build.
4.  **Restart Reticulum**: Reticulum caches these pages in RAM at startup. You MUST restart the Reticulum pods to see changes.
    *   `kubectl rollout restart deployment moz-reticulum -n hcce`

```bash
# Example Script for Hot-Fix
POD=$(~/bin/kubectl get pods -n hcce | grep moz-hubs-ce | grep Running | awk '{print $1}')
echo "Deploying to $POD..."

# 1. Copy assets
for f in hubs/dist/*; do ~/bin/kubectl cp "$f" "$POD:/www/hubs/" -n hcce -c hubs-ce; done

# 2. Update Pages (This is the tricky part - use manual editing or careful sed if confident)
# Verify the new bundle name:
grep -o 'hub-[a-z0-9]*\.js' hubs/dist/hub.html
# Then update /www/hubs/pages/hub.html on the pod to match.

# 3. Restart Reticulum
~/bin/kubectl rollout restart deployment moz-reticulum -n hcce
```

#### Robust Deployment (Recommended)
1.  **Dockerize**: Build a Docker image containing the `dist` folder.
2.  **Registry**: Push image to DigitalOcean Container Registry.
3.  **Helm/K8s**: Update the deployment yaml to use the new image tag.
4.  `kubectl rollouts` will handle the zero-downtime update.

## Troubleshooting
-   **CSP Errors**: Check `Content-Security-Policy` headers if external resources (images, scripts) are blocked.
    *   **Fix**: Edit the `ret-config` ConfigMap (`kubectl edit configmap ret-config -n hcce`) and update the `[ret."Elixir.RetWeb.Plugs.AddCSP"]` section (add domains to `frame_src`, `connect_src`, etc). Then restart Reticulum.
-   **Webpack Issues**: If the build fails, clean `node_modules` and `package-lock.json` and reinstall.
-   **kubectl not found**: Install using the curl command in Prerequisites or via `brew install kubectl`.


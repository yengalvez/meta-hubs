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

### 1. Building the Client
-   Ensure production environment variables are set before building:
    ```bash
    export RETICULUM_SERVER="meta-hubs.org"
    export BASE_ASSETS_PATH="https://assets.meta-hubs.org/hubs/"
    npm run build
    ```

### 2. Deployment Methods
-   **Quick Patch (Hot-fix)**: Use `kubectl cp` to overwrite files in a running pod for immediate testing/fixes.
    ```bash
    kubectl cp ./dist/ <pod-name>:/www/hubs/ -c <container-name>
    ```
-   **Robust Deployment (Recommended)**:
    1.  **Dockerize**: Build a Docker image containing the `dist` folder.
    2.  **Registry**: Push image to DigitalOcean Container Registry.
    3.  **Helm/K8s**: Update the deployment yaml to use the new image tag.
    4.  `kubectl rollouts` will handle the zero-downtime update.

## Troubleshooting
-   **CSP Errors**: Check `Content-Security-Policy` headers if external resources (images, scripts) are blocked.
-   **Webpack Issues**: If the build fails, clean `node_modules` and `package-lock.json` and reinstall.

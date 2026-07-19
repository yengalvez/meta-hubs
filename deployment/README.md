# YenHubs Deployment Guide

Hubs Community Edition 2.1.0 on DigitalOcean Kubernetes with automated SSL via cert-manager.

> **Last updated**: July 2026 | **Cluster**: `hubs-ce` active on DOKS `1.34.8-do.2`, `HA=false` | **Region**: AMS3
>
> DNS, TLS, Mailtrap SMTP and the 12 application deployments are operational.
> The Hubs and Spoke administrator is `info@virtualmente.com`. Mailtrap account
> ownership is independent from that address; use account ID `2385821` and the
> verified sender domain `meta-hubs.org` when locating the provider
> configuration. Start with `docs/project-handoff-2026-07.md`; use this file as
> the only active deployment runbook and
> `deployment/client-instance-lifecycle.md` for create/freeze/restore/retire.

> **Current rollout block — 17 July 2026:** an ignored generated manifest with
> real local values was displayed to the task log during candidate
> diagnostics. It was neither committed nor applied and production was not
> changed. Nevertheless, do not build or deploy the next candidate until a
> joint DB+storage checkpoint exists and every potentially included secret has
> been rotated through the procedures in this runbook. Verify only by hashes,
> configured-key presence and redacted reports; never reopen/print the ignored
> manifest to inventory values. After that rotation, integrate and validate
> `AUD-078` before dispatching candidate image builds.

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
    +---> Bot orchestrator     -- Parent control plane + private AI chat proxy
             +---> bot-runner Pods (integrated source: one per room/generation)
    +---> Coturn (:5349)       -- STUN/TURN for WebRTC NAT traversal
    +---> PostgreSQL (:5432)   -- Database (via pgbouncer)

cert-manager (namespace: cert-manager)
- ClusterIssuer: letsencrypt-prod
- Auto-renews SSL certs every ~60 days
- HTTP-01 challenges via HAProxy
```

## Accepted Live State (July 2026)

These images were built by the approved GitHub Actions workflows, deployed by
the procedure accepted at that historical cut and validated in DOKS. This table
records the last accepted live baseline; it is not an instruction to bypass the
current phase-aware `npm run apply` driver. The images are pinned in the ignored
local values file:

| Component | Live image | Actions run |
|-----------|-----------------|-------------|
| Hubs client | `ghcr.io/yengalvez/hubs@sha256:cff099ef4759c8ec8e8d6010ae9268c6b6e99f29ff5ecb50f6e50ce884d20a8c` | `29506573351` |
| Reticulum | `ghcr.io/yengalvez/reticulum@sha256:9ae6712fa5cd4380048ec559cbf75596507ae91cdbd653cac1978b685254faef` | CI `29506498175`; build `29506780044` |
| Bot orchestrator | `ghcr.io/yengalvez/bot-orchestrator@sha256:325c5c10e4ee039518693771c0974a0e5c876dcf54c443295e84490f4fa8ec53` | `29506574473` |
| Dialog | `ghcr.io/yengalvez/dialog@sha256:95687f4765e7a68ef05a714b807bf5c80e0f9187e2715f3a5a96e2d664377a23` | `29375052801` |
| Photomnemonic | `ghcr.io/yengalvez/photomnemonic@sha256:aef369b82212429d01c0f1f554b16c34a99cf4bbb75e0693e190c796b33012f2` | `29376531637` |
| Coturn | `ghcr.io/yengalvez/coturn@sha256:c2ad335349d477d342d5b17c82b513bfebc8c17b8e6b4e27a3049f3478207780` | `29371663849` |
| Spoke | `ghcr.io/yengalvez/spoke@sha256:f5120264938e189e702f835182ed4a28a5ce20b140d7262bc2a3074e6d0b6657` | `29410656894` |

Final acceptance on 2026-07-16 reported 12/12 Deployments Ready, four Ready certificates, HTTP 200, zero manifest
drift, DB schema 356 with 94 migrations and 33 active owned files, and storage with 47 complete pairs of which 14
were deferred. The matching checkpoint is documented in the Backups section.

Production uses `RUNNER_BACKEND=ghost`, `GHOST_NAVIGATION_MODE=navmesh_preferred`, `MAX_ACTIVE_ROOMS=5` and
`MAX_BOTS_PER_ROOM=10`. Cloud commit `5a82de5` adds `mobility=static`, safe partial GLB loading and A* navigation over
the Spoke navmesh while retaining the room config and prompt/runtime guardrails from the earlier audit.
The exact bot digest is `sha256:325c5c10e4ee039518693771c0974a0e5c876dcf54c443295e84490f4fa8ec53`.

`AUD-075` is closed in source at Cloud
`5392495b077249edcedfb3092551201645f648f1`, not in the live images above. Cloud
PR `#11` was merged into `development` as
`ebe960794735d378149966b78090e22acc60cc26`; PR `#12` promoted that exact line
to `master` as `5392495b077249edcedfb3092551201645f648f1`. The integrated source
separates parent and runner into two images and creates one hardened runner Pod
per room/generation. Cloud passes 128/128 orchestrator tests, 30/30 generator
tests over the exact 58-resource inventory, and Reticulum 430 tests + 5
properties. The root normal and `--full` gates are green: security 43,
recovery 239, runner Pods 45, pull configuration 19, orchestrator Deployment
18, Hubs 97, browser 11, capacity 115 fail-closed and Spoke 68. This is source
and validation closure only: no new image build, digest, checkpoint, deployment,
staging/live rollout or live attestation is claimed here.
The subrepository heads and root gitlinks were integrated through root PR `#5`
at `main=9f4ada1`. No candidate image, checkpoint, deployment or live acceptance
is implied by that source integration.

The isolated AUD-065 coordinator is now integrated through root PR `#6`:
head `4ac252b875e8b53cadc4e231129d89ac2478729b`, merge
`c87f5b3982f7b68547702b6fa5b6b6212705f679`, and green push/PR runs
`29667729457` and `29667730561`. This advances the tracked root source and
closes the tooling phase only. It did not change the accepted live images above,
create credentials or a checkpoint, or mutate the cluster.

Node ghost is the only production/authenticated runner. Chromium is retained
only as a legacy/local browser diagnostic without `--runner`; its renderer is
not given `BOT_RUNNER_ACCESS_KEY`, cannot authenticate against hardened Reticulum and
never counts toward readiness. Never pass that key in a URL or client-side
state.

Hubs commit `a7214eb88` includes the official `prod-2026-03-11` release, dependency hardening, safe cookie migration,
mobile viewport containment, sitting feedback, bot privacy copy, responsive avatar UI, fully localized profile
placeholders, the accepted Obsidian Aurora room interface, the Obsidian Aurora portal landing and the `static` bot
mobility control. It also retains runtime asset substitution, full-body/Avaturn validation, third-person, sitting and
bot features accepted during the audit. The landing contract and upgrade checks live in
`features/landing-aurora/README.md`.

Spoke commit `cc5c831` fixes the publish authentication retry without repeating exports/uploads and wires cancellation
to the main GLB upload. Commit `56afaee` additionally treats expired or malformed local JWTs as signed out before an
API request. Its tests/build must run with Node `16.13.2`, matching the Spoke Dockerfile; the legacy `esm` test loader
aborts under Node 22 before executing tests. Run the complete suite as `npx ava 'test/unit/**/*.test.js'`: the unquoted
package-script glob only selects part of the nested suite in some shells.

Reticulum was modernized and hardened through cloud commit `cc43df4`; commit `9781d06` adds the OTP 27 compatibility
fix required by the legacy Bamboo/gen_smtp adapter and correct delivery metrics, and commit `5a82de5` accepts
`mobility=static` across the persisted bot contract. It is pinned live at
`sha256:9ae6712fa5cd4380048ec559cbf75596507ae91cdbd653cac1978b685254faef`. It uses Elixir 1.18.4, OTP 27.3.4.14,
Phoenix 1.6.17, Plug 1.16.6, Cowboy 2.15, Ecto 3.14 and Postgrex 0.22.3. In addition to credential filtering, this
revision closes the audited CORS proxy rebinding/header issues, scopes entity operations to their room, fixes account
deletion ownership, replaces blocking Statix calls, reconciles abandoned Spoke files and validates avatar uploads
server-side. STARTTLS remains mandatory, while certificate verification is disabled specifically for this old SMTP
adapter because OTP 27 otherwise selects `verify_peer` without a CA bundle and fails before AUTH. CI on PostgreSQL
12/14, isolated storage tests, a real delivered magic link and the production rollout passed before this digest
became the lock.

After that rollout, all 13 live containers were changed from mutable tags to the exact digests they were already
running. `npm run gen-hcce` now rejects every Deployment image that is not in `repository@sha256:<64 hex>` form.
The ignored local values are therefore the authoritative image lock, not the readable tags in the table.

Persistent/exclusive workloads have explicit safe update strategies:

- `pgsql` and `reticulum`: exact `Recreate` with no residual
  `rollingUpdate`; Reticulum remains at exactly one replica and has no HPA.
  Bot-runner authority is database-fenced in the integrated source, but the
  live baseline is not yet migrated or attested. Even after that rollout, a
  second Reticulum replica remains prohibited until staging proves readiness,
  Endpoint behavior and the `ret-pvc` RWO placement constraint with two cold
  replicas.
- `dialog` and `coturn`: `Recreate`, so two revisions never compete for host ports `4443`/`5349` on the single node.
- HAProxy: startup, readiness and liveness checks on `/healthz:1042`; startup has up to 120 seconds before liveness
  may restart it.
- Reticulum: no privileged mode or bidirectional mount propagation; it disables privilege escalation, drops every
  Linux capability and uses the runtime-default seccomp profile.

Runtime capacity and isolation baseline (measured and accepted on 2026-07-14):

- all 13 containers declare CPU/memory requests and a memory limit;
- application requests total 665 mCPU and 3,200 MiB; with DOKS system pods the node reserves 1,297 mCPU (33%) and
  4,002 MiB (62%);
- no application has a CPU limit, so this guardrail does not introduce CFS throttling or an artificial CCU cap;
- memory limits are deliberately overcommitted (150% including system pods) to retain burst headroom. They protect
  individual runaway processes but do not prove capacity; run a staged room/WebRTC load test before promising 75 CCU;
- five Cilium ingress NetworkPolicies isolate bot-orchestrator, PostgreSQL, both PgBouncer pools and Photomnemonic to
  their exact same-namespace callers and ports. A sixth policy limits Photomnemonic egress to cluster DNS and public
  IPv4 HTTP/HTTPS while excluding private, loopback, link-local, metadata and reserved ranges. Egress remains open for
  TURN, SMTP, OpenAI and other media proxies; there is no unsafe namespace-wide `default-deny` yet.
- all 11 non-controller Deployments set `automountServiceAccountToken: false`; only HAProxy keeps a token and uses
  the dedicated `haproxy-sa` account because it must watch Kubernetes resources;
- Reticulum, both PgBouncer pools and Coturn share a generated DB-credential checksum annotation, so a local
  credential rotation cannot leave consumers on stale environment variables;
- Coturn uses the audited wrapper image, never logs `PSQL`, keeps the database URI out of process arguments and
  writes `/etc/turnserver.conf` as mode `0600`. The previous known-leaky digest is rejected by manifest verification.
- bot-orchestrator runs as UID/GID 1000 with no effective capabilities, privilege escalation disabled and the
  RuntimeDefault seccomp profile. Both generated and live verifiers enforce this baseline.
- Dialog uses Node 22 and Mediasoup 3.19.22, has zero production npm advisories, and runs as UID/GID 1000 with no
  capabilities, no privilege escalation, RuntimeDefault seccomp and TCP startup/readiness/liveness probes on 4443.
  Keep Mediasoup below 3.20 until the Dialog SCTP option contract is migrated deliberately; 3.20 changes that API.
- Photomnemonic uses Node 22, Puppeteer Core 25.1 and Chromium 149 with zero production npm advisories. It validates
  the initial URL, every redirect and every browser request against public HTTP/HTTPS destinations, permits one
  screenshot at a time, omits paths/queries from logs and always closes pages. Production runs as UID/GID 1000 with
  no capabilities, no privilege escalation, RuntimeDefault seccomp and HTTP probes. Its measured post-capture RSS was
  about 400 MiB, so its request/limit are 384/768 MiB rather than the unsafe previous 512 MiB limit.

Important deployment distinction:

- Hubs runs commit `a7214eb88`, published by Actions run `29506573351`.
- Reticulum and bot-orchestrator run cloud commit `5a82de5`; CI is `29506498175`, the Reticulum image build is
  `29506780044` and the bot-orchestrator image build is `29506574473`.
- Dialog runs cloud commit `4eb743b` (runtime change in `08a0cf3`), published by Actions run `29375052801` and pinned
  to digest `sha256:95687f4765e7a68ef05a714b807bf5c80e0f9187e2715f3a5a96e2d664377a23`.
- Photomnemonic runs cloud commit `e670a4a` (runtime change in `662035c`), published by Actions run `29376531637` and
  pinned to digest `sha256:aef369b82212429d01c0f1f554b16c34a99cf4bbb75e0693e190c796b33012f2`.
- Coturn runs the credential-safe commit `98f9b1c`, published by Actions run `29371663849` and pinned to digest
  `sha256:c2ad335349d477d342d5b17c82b513bfebc8c17b8e6b4e27a3049f3478207780`.
- The moderated, rate-limited, `store:false` OpenAI path and hardened same-origin scene loader are live. This reduces
  YenHubs-side retention but is **not** a claim of OpenAI Zero Data Retention; provider abuse-monitoring retention
  remains governed by the OpenAI account policy.

The pre-rollout runtime digests and the post-rollout bot digest/evidence captured on 2026-07-14 are stored locally in:

```text
/Users/Shared/Gits/YenHubs/output/audit-checkpoint-20260714-210044/runtime-image-digests.txt
/Users/Shared/Gits/YenHubs/output/audit-checkpoint-20260714-210044/postdeploy-botguard.txt
/Users/Shared/Gits/YenHubs/output/audit-imagepin-20260714-215632/
/Users/Shared/Gits/YenHubs/output/audit-db-rotation-20260714-235659/
/Users/Shared/Gits/YenHubs/output/audit-dialog-node22-20260715-0105/
/Users/Shared/Gits/YenHubs/output/audit-photomnemonic-20260715/
/Users/Shared/Gits/YenHubs/output/audit-photomnemonic-predeploy-20260715-0138/
/Users/Shared/Gits/YenHubs/output/audit-retmodern-predeploy-20260715-103120/
/Users/Shared/Gits/YenHubs/output/audit-botprivacy-predeploy-20260715-114137/
```

The 2026-07-14 ignored checkpoint contains the pre-reconciliation database, the 34 physical blob/metadata pairs, a
redacted manifest inventory and the coherent candidate that was restored twice in isolation. Its raw snapshot remains
intentionally labelled `INCOMPLETE` because it records the former 127-active/34-physical mismatch. Do not restore that
raw dump over the current environment. The authoritative coherent pair is the post-change dump plus storage archive
under `output/audit-retmodern-predeploy-20260715-103120/`.

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
[regional Load Balancers](https://www.digitalocean.com/pricing/load-balancers) and
[block storage](https://docs.digitalocean.com/products/volumes/details/pricing/).

## Avoid Surprise DigitalOcean Charges

- Each additional Kubernetes `Service` of type `LoadBalancer` typically adds an extra DigitalOcean Load Balancer (about **$12/mo** each).
- Adding nodes (or extra node pools) increases monthly cost immediately.
- Increasing PVC sizes increases block storage cost.

For normal feature iteration, build with the approved GitHub Actions workflow,
update the local image override, run `npm run gen-hcce`, review
`kubectl --context "$EXPECTED_KUBE_CONTEXT" diff -f hcce.yaml` and deploy with
the tracked Cloud `npm run apply` driver. Do not invoke `kubectl apply` directly
for `hcce.yaml`, use `kubectl set image` or choose another deployment path; the
driver owns the serialized, phase-aware mutation and its fail-closed gates.

---

## Prerequisites

- **Node.js** v20+ ([nodejs.org](https://nodejs.org))
- **System Python 3** available as `python3` through the restricted
  `/usr/bin:/bin` path (required by the owner-private `dir_fd` helpers)
- **kubectl** matching your cluster version ([kubernetes.io](https://kubernetes.io/docs/tasks/tools/))
- **Helm** v3+ ([helm.sh](https://helm.sh/docs/intro/install/))
- **Git**
- **DigitalOcean account** with payment method
- **Domain name** with DNS access
- **SMTP service** (Mailtrap, Scaleway, etc.)

Reticulum development and release validation require the exact versions in `hubs-cloud/community-edition/services/reticulum/.tool-versions`.
On this Mac they are managed with `mise`:

```bash
brew install mise
cd hubs-cloud/community-edition/services/reticulum
mise install
mise exec -- mix --version
```

Before recreating a frozen deployment, run the read-only preflight from the repository root:

```bash
BACKUP_DIR=/absolute/path/to/checkpoint-YYYYMMDD-HHMMSS \
  MAX_CHECKPOINT_AGE_SECONDS=86400 \
  ./deployment/preflight-reactivation.sh
```

`BACKUP_DIR` is mandatory and is never inferred from an older directory or a
"latest" pointer. The timestamp must be non-future and no older than the
explicit TTL. The gate validates the exact allowlisted artifact set, filename
equality in `SHA256SUMS`, the jointly coherent DB/storage pair, the structural
Deployment inventory, required local keys, exact GHCR digest overrides and
DigitalOcean state without printing secrets or creating resources. Export
`EXPECTED_KUBE_CONTEXT`, `NAMESPACE` and `EXPECTED_NAMESPACE_UID`. If the
DigitalOcean cluster exists, missing or unreadable Kubernetes identity is
fatal; command errors are never interpreted as resource absence.

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
- `OVERRIDE_HUBS_IMAGE` - set this to the digest-pinned custom client image when you ship client-side features
  (official `hubsfoundation/hubs:*` images do not include local code changes)
- `OVERRIDE_BOT_ORCHESTRATOR_IMAGE` - set this to the digest-pinned custom bot image when room bots/chat are enabled
- `OVERRIDE_BOT_RUNNER_IMAGE` - set this to the independently digest-pinned
  ghost data-plane image; both bot overrides must come from the same accepted
  Cloud commit
- `BOT_IMAGE_PULL_CONFIG_JSON_BASE64` - kubelet-only registry configuration for
  the generated `bot-images-pull` Secret. Never construct, decode or print this
  value by hand; use the tracked updater below
- `BOT_ACCESS_KEY` - legacy binding key consumed only by Reticulum
- `BOT_RUNNER_ACCESS_KEY` - legacy process-local transition key retained only by
  Reticulum; neither candidate bot image receives it
- `BOT_ORCHESTRATOR_ACCESS_KEY` - key shared only by Reticulum and the bot-orchestrator parent HTTP service
- `DASHBOARD_ACCESS_KEY` - Reticulum administrative-route key
- all four internal credentials must be distinct random strings of at least 32 characters; rotate them only in the
  ignored local values and then regenerate/apply the manifest
- `OPENAI_API_KEY` - API key used by bot-orchestrator for LLM chat (model defaults to `gpt-5-nano`)
- `OPENAI_TOTAL_BUDGET_MS` - fixed to `4000` by the generator; input moderation, model and output moderation share it
- `GHOST_NAVIGATION_MODE` - keep `navmesh_preferred` in production
- `GHOST_NAVIGATION_REQUIRE_NAVMESH` - keep `true`; collider/direct modes are legacy diagnostics, not readiness
- `GHOST_NAVMESH_MAX_TRIANGLES` - navmesh parser cap, default `50000`
- `GHOST_NAVMESH_MAX_ROUTE_POINTS` - route publication cap, default `64`
- `GHOST_NAVMESH_MAX_SNAP_DISTANCE_M` - maximum waypoint projection distance, default `3`
- `OVERRIDE_HAPROXY_IMAGE` - set to the approved digest for HAProxyTech 3.2 on modern Kubernetes

Every `OVERRIDE_*_IMAGE` used by a Deployment must be `repository@sha256:<digest>`. After an Actions build, resolve
the published tag to its registry digest, update the ignored local values and regenerate. The verifier deliberately
fails on `stable-latest`, `*-latest` and version tags, even when they currently point at the expected bytes.

Set or rotate the private bot-image pull config from
`hubs-cloud/community-edition/` in Bash. `GHCR_TOKEN` must arrive through hidden
input or an already protected environment variable; never put it in argv,
tracked YAML or terminal output:

```bash
read -r -p "GHCR username: " GHCR_USERNAME
read -r -s -p "GHCR read-packages token: " GHCR_TOKEN; echo
export GHCR_USERNAME GHCR_TOKEN
HCCE_INPUT_VALUES_PATH=/absolute/path/to/deployment/input-values.local.yaml \
  npm run set-bot-image-pull-config
unset GHCR_TOKEN GHCR_USERNAME
```

The updater atomically changes only `BOT_IMAGE_PULL_CONFIG_JSON_BASE64`, forces
the private input to mode `0600` and emits no credential. The generator rejects
empty credentials or a docker config that does not cover both selected bot
image registries. The resulting `bot-images-pull` Secret is referenced only by
the parent and runner ServiceAccounts through `imagePullSecrets`; it is never
mounted into either Node container.

Do not modify either secret-bearing values file with an in-place Perl/Ruby command. A replacement containing
`@sha256` can be interpolated and corrupt the file. Use this safe pattern instead:

1. Copy the source to a mode `0600` temporary file.
2. Update the temporary file with a parser that treats values literally.
3. Validate all required keys, exact image digest syntax and the `PERMS_KEY` PEM.
4. Generate `hcce.yaml`, run the tracked manifest verifier and compare only
   configured-key presence and checksum annotations with the redacted live
   inventory when preserving an existing environment. Never print either set
   of Secret values for comparison.
5. Atomically move the validated file into place.

Do not open, print or send `input-values.yaml`, `input-values.local.yaml` or
generated `hcce.yaml` to a terminal/chat as a diagnostic. They are ignored, not
sanitized. Use the manifest verifier and redacted inventory reports. If any
real value appears in task, terminal or CI output, treat every affected value
as compromised and rotate it before rollout.

The safe root parser accepts only top-level scalar values. Store `PERMS_KEY` on
one quoted line with each PEM newline encoded as the literal two characters
`\n`, as shown in `deployment/input-values.example.yaml`; YAML `|` block
scalars are deliberately rejected. The Hubs CE generator restores the physical
newlines before validating and deriving the public key.

### Rotate the four internal credentials safely for the later AUD-075 rollout

This subsection belongs only to the later 58-resource candidate rollout after
AUD-065 and AUD-078 are integrated. Do not generate or apply that manifest to
rotate the current `process-local` baseline; use the AUD-065 coordinator below.

None of `BOT_ACCESS_KEY`, `BOT_RUNNER_ACCESS_KEY`,
`BOT_ORCHESTRATOR_ACCESS_KEY` or `DASHBOARD_ACCESS_KEY` may be printed,
committed or copied into a command argument. Replace them with four new,
independent random values in `deployment/input-values.local.yaml`, copy that file to the ignored
`hubs-cloud/community-edition/input-values.yaml`, run `npm run gen-hcce` and apply the generated manifest.

The generator derives a SHA-256 checksum annotation for each credential. The
manifest verifier binds the legacy bot, legacy master-runner and dashboard
checksums only to Reticulum. Only the orchestrator checksum must match between
Reticulum and the parent; the parent must not carry the master-runner checksum.
Kubernetes then restarts the affected pod templates. Do not compensate with a
manual one-sided rollout.

After rotation, validate only those checksum annotations and filtered logging
behavior. Phoenix logs must contain `[FILTERED]` for every access-key field;
never copy a live value into a shell search or diagnostic. Production accepted
the former single-key contract on 2026-07-14; the four-domain candidate is not
live and requires the fresh checkpoint plus coordinated rotation mandated by
AUD-065 before rollout.

### AUD-065: coordinated rotation of the live `process-local` baseline

`deployment/rotate-process-local-credentials.sh` is the only approved mutation
path for closing AUD-065. It operates on the exact historical 42-resource
`process-local` inventory, plus the two existing legacy pull bindings
`Secret/ghcr-pull` and `ServiceAccount/default`, and keeps all 13 live image
digests unchanged. These two auxiliary objects are not added to the historical
generated inventory. The coordinator does not generate or apply the AUD-075
manifest and must not be combined with an upstream update, image change or
dependency upgrade.

The private new-values copy must retain every invariant field and rotate all of
`BOT_ACCESS_KEY`, `BOT_RUNNER_ACCESS_KEY`, `BOT_ORCHESTRATOR_ACCESS_KEY`,
`DASHBOARD_ACCESS_KEY`, `BOT_IMAGE_PULL_CONFIG_JSON_BASE64`, `DB_PASS`,
`GUARDIAN_KEY`, `NODE_COOKIE`, `OPENAI_API_KEY`, `PERMS_KEY`, `PHX_KEY` and
`SMTP_PASS`. Rotate `SKETCHFAB_API_KEY` and `TENOR_API_KEY` too when they are
configured. The three candidate-only bot domains are bound and promoted in the
private values source but are deliberately not projected into the live
`process-local` bundle. The pull config is different: the same private source
is projected by CAS only into the legacy `Secret/ghcr-pull`; the distinct
`bot-images-pull` objects remain exclusive to the later AUD-075 generator. The
tool validates both DB URIs against the DB fields, derives the JWT field,
verifies the Reticulum/Dialog `PERMS_KEY` relationship using cryptographic
material without printing it, and rejects rendered credentials inside
`ConfigMap/ret-config`. `PGRST_JWT_SECRET` may be absent from both complete
values sources because it is derived from `PERMS_KEY`; if the OLD source
contains that line, the preparer preserves its presence and writes the exact
new derivation.

All four bot-domain values must be distinct and contain at least 32 characters;
the live `BOT_ACCESS_KEY` must meet that same minimum. The new `DB_PASS` must be
32 to 128 characters using only ASCII letters, digits, `_` and `-`. `plan`
rejects any other contract before reporting readiness.

The sealed old and new snapshots must both pass a live GHCR acceptance gate
for every digest-pinned `ghcr.io/yengalvez/*` image in the process-local
contract plus the bot runner. The gate runs during `plan` and again after the
global Lease but before the operation lock, quiescence or any resource CAS.
Registry timeout, DNS failure, provider 5xx, denied token scope, missing
manifest or digest mismatch all fail closed; none proves acceptance. The new
snapshot is revalidated immediately before the first pool restart and again in
the final read-only audit, after the second exact process-local boundary and
before accepting the final source, terminal record or absent lock. Keep the old
PAT valid through terminal audit; revoke it only in the subsequent provider
revocation sequence.

Replacement Secret bytes are an internal coordinator stream, not diagnostic
output. The materializer emits them only with the explicit
`coordinator-cas-stream` purpose and rejects an interactive terminal target;
the approved caller pipes that stream directly into the guarded CAS replace.

Do not start `plan` or any coordinator execution until the AUD-065 tooling is
merged, its local and CI gates are green, and a fresh joint DB+storage checkpoint
has passed the restore and checksum gates. Credential preparation may begin
after the merged-tooling gates on a clean `main`, but every old credential must
remain valid and that preparation authorizes no Kubernetes mutation. The two
values sources and checkpoint are private inputs, not diagnostic files:

- use absolute paths with no symlink component;
- values sources must be regular, single-link, owner-owned mode `0600` files;
- the parent of the canonical values source must be owned by the current user
  and must not be writable by group or other users;
- the checkpoint and operation parent must be owner-owned mode `0700`
  directories;
- the operation directory itself must not exist before `plan`;
- never print, diff, edit or copy any operation artifact into a task, terminal
  transcript or PR.

Prepare the complete NEW source only through the tracked Keychain bridge. First
create new provider credentials while every OLD credential remains valid. Store
each newly displayed value in a new, revision-specific item in the default
Keychain search list used by `/usr/bin/security` (normally the login Keychain),
from an independent Terminal window. `-w` must be the final option so
`/usr/bin/security` prompts without placing the value in argv. Do not use `-U`,
`-A`, `-g`, a shell variable, clipboard history, chat or a Codex-controlled
terminal for the secret value:

- create an OpenAI project/service-account key, not a broader organization
  admin key solely for this rotation;
- use Mailtrap **Add Token** with only the sending/domain access required by
  this deployment; do not use provider-wide reset while OLD must remain valid;
- create a GitHub classic PAT with expiry, `read:packages` and
  `write:packages`, without `repo`; this same NEW credential must later replace
  the two `REGISTRY_PASSWORD` repository secrets through stdin;
- create Sketchfab/Tenor replacements only when the OLD source has those
  optional integrations configured.

```bash
export AUD065_KEYCHAIN_ACCOUNT='info@virtualmente.com'
export AUD065_KEYCHAIN_PREFIX='YenHubs-AUD065-NEW-20260719-01'

aud065_store_new_secret() {
  /usr/bin/security add-generic-password \
    -a "$AUD065_KEYCHAIN_ACCOUNT" \
    -s "${AUD065_KEYCHAIN_PREFIX}-$1" \
    -T "" \
    -w
}

aud065_store_new_secret OPENAI_API_KEY
aud065_store_new_secret SMTP_PASS
aud065_store_new_secret GHCR_TOKEN
```

Add `SKETCHFAB_API_KEY` and `TENOR_API_KEY` through the same function only when
the OLD source has each provider configured. The preparer detects that presence
internally and does not query an unconfigured optional item. A repeated
`add-generic-password` failure means the label already exists: choose a new
revision prefix; never overwrite it with `-U`. Keep these NEW items separate
from every OLD Keychain item through terminal audit and provider revocation.

Create a dedicated owner-private directory, point OLD at the existing regular
`0600` source without printing it, and require NEW not to exist:

```bash
export AUD065_PRIVATE_PARENT='/absolute/private/aud065-preparation'
export AUD065_OLD_VALUES='/absolute/private/or/canonical/input-values.local.yaml'
export AUD065_NEW_VALUES="$AUD065_PRIVATE_PARENT/new-values.yaml"

install -d -m 0700 "$AUD065_PRIVATE_PARENT"
test -f "$AUD065_OLD_VALUES"
test ! -e "$AUD065_NEW_VALUES"

node ./deployment/prepare-process-local-new-values-from-keychain.mjs \
  --old-values-source "$AUD065_OLD_VALUES" \
  --new-values-source "$AUD065_NEW_VALUES" \
  --keychain-account "$AUD065_KEYCHAIN_ACCOUNT" \
  --keychain-prefix "$AUD065_KEYCHAIN_PREFIX"

node ./deployment/prepare-process-local-new-values.mjs verify \
  --old-values-source "$AUD065_OLD_VALUES" \
  --new-values-source "$AUD065_NEW_VALUES"
```

The only successful outputs are respectively
`aud065_new_values_prepared_from_keychain` and
`aud065_new_values_verified`. The bridge reads Keychain values into the V1
frame in memory, sends it only through inherited FD 3 and wipes mutable buffers
best-effort. The preparer generates the internal domains, database password and
RSA key itself; it preserves every non-authorized source line byte-for-byte,
validates OLD -> NEW strongly and publishes NEW once with mode `0600`. A
failure before publication is generic and leaves NEW absent. If a generic
failure ever returns with NEW present, quarantine that path without opening,
deleting or reusing it and diagnose through the value-free tests. Do not
construct the V1 frame by hand or use the low-level FD interface outside a
separately audited supervisor.

Run from a clean root `main` that contains the merged AUD-065 tooling commit.
Record the exact root commit as non-secret evidence and do not change checkout
or executable files between `plan`, any recovery command and terminal
verification. Before creating live credentials or checkpoint data, require both
project gates:

```bash
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
./scripts/verify-project.sh
./scripts/verify-project.sh --full
```

Create the checkpoint through the tracked `## Backups` procedure with
`ALLOW_CHECKPOINT_DOWNTIME=1`, then run the combined read-only restore preflight
with `RESTORE_CHECKPOINT_PREFLIGHT=1`. The default rollout freshness ceiling is
24 hours (`MAX_CHECKPOINT_AGE_SECONDS=86400`); repeat the checkpoint whenever
that TTL expires or DB, storage, values, commits, images or inventory change.
Keep a maintenance window with no content or deployment mutation from before
`plan` until the terminal audit, provider revocations and closure record are
complete. The global Lease serializes this coordinator, and source promotion
repeatedly verifies the path, inode and bytes before an atomic rename. A POSIX
rename or unlink is not a linearizable compare-and-swap against an unrelated
process running as the same local user. Therefore no editor, updater, autosave
or other same-user process may write anywhere in this operation's local
contract: the old/new values sources and their parents, the checkpoint, the
operation directory and its parent, the canonical values source and its parent,
or any private staging/output directory used by AUD-065. This exclusion begins
before the first NEW preparation command and remains absolute through `plan`,
`execute`, any `resume`/`rollback`, the terminal `audit`, external revocation
checks and the closure record.
Directory-FD anchoring prevents pathname substitution from redirecting a
mutation, but it does not turn POSIX filesystems into a linearizable CAS against
an actively hostile writer with the same UID.

Pin the target explicitly. The values below are placeholders; obtain the
approved context and UIDs from the verified checkpoint/inventory without
printing secret-bearing files:

```bash
export NAMESPACE=hcce
export EXPECTED_KUBE_CONTEXT='<approved-kubernetes-context>'
export EXPECTED_NAMESPACE_UID='<checkpoint-namespace-uid>'
export EXPECTED_RET_PVC_UID='<checkpoint-ret-pvc-uid>'

export AUD065_CHECKPOINT='/absolute/private/checkpoint-directory'
export AUD065_OLD_VALUES='/absolute/private/old-values.yaml'
export AUD065_NEW_VALUES='/absolute/private/new-values.yaml'
export AUD065_OPERATION_PARENT='/absolute/private/aud065-operations'
export AUD065_OPERATION="$AUD065_OPERATION_PARENT/aud065-20260718-01"

install -d -m 0700 "$AUD065_OPERATION_PARENT"
./scripts/test-aud065.sh
```

First create and seal a read-only plan. This is the step that projects the two
private sources into the only credential snapshots, `old-snapshot.json` and
`new-snapshot.json`, and validates GHCR OLD -> NEW. It performs exact Kubernetes
reads and creates private local evidence, but it performs zero Kubernetes
mutations:

```bash
MAX_CHECKPOINT_AGE_SECONDS=86400 \
./deployment/rotate-process-local-credentials.sh plan \
  --operation-directory "$AUD065_OPERATION" \
  --checkpoint-directory "$AUD065_CHECKPOINT" \
  --old-values-source "$AUD065_OLD_VALUES" \
  --new-values-source "$AUD065_NEW_VALUES" \
  --rotation-revision aud065-20260718-01
```

The only successful output is `aud065_plan_ready`. A failed plan is not a
partially valid operation: retain its private directory for diagnosis, do not
modify it, and create a new operation identity after correcting the cause.

Reconfirm checkpoint freshness and then execute the exact sealed operation.
Both `plan` and the initial `execute` reject a future, expired or invalid TTL
before any Lease, lock or Kubernetes mutation. Once mutation has begun,
`resume`, `rollback` and `audit` deliberately remain available if wall-clock
time later crosses that TTL so recovery cannot be stranded:

```bash
MAX_CHECKPOINT_AGE_SECONDS=86400 \
./deployment/rotate-process-local-credentials.sh execute \
  --operation-directory "$AUD065_OPERATION" \
  --checkpoint-directory "$AUD065_CHECKPOINT"
```

The durable state sequence is:

| State | Proven boundary |
| --- | --- |
| `preflight` | global Lease and HMAC-bound operation lock acquired |
| `quiesced` | six consumers at zero, PostgreSQL policy closed by CAS, probe blocked three times, no client sessions |
| `db-rotated` | persistent PostgreSQL role classifies as the new verifier |
| `bundle-applied` | exact `Secret/configs`, `Secret/ghcr-pull` and six zero-replica Deployment replacements completed by UID/resourceVersion CAS; `ServiceAccount/default` remains byte- and resourceVersion-invariant |
| `verified` | pools and consumers use the new runtime values, old `DB_PASS` is rejected specifically for authentication, images/config/runtime and redacted report are exact |
| `cleanup-authorized` | cleanup permission is durable before policy-marker or probe removal; final and released evidence can be terminally bound |

On any ordinary error, `INT` or `TERM`, the coordinator attempts to close the
existing PostgreSQL policy, proves the CNI block and stops all six consumers
before exiting. The operation lock is deliberately retained. Do not delete the
lock, probe or private directory and do not repair the cluster with manual
`kubectl` commands. Resume the same identity instead:

```bash
./deployment/rotate-process-local-credentials.sh resume \
  --operation-directory "$AUD065_OPERATION" \
  --checkpoint-directory "$AUD065_CHECKPOINT"
```

Re-entry derives truth from the authenticated lock, policy, resource UIDs and
private artifacts. It accepts the DB role only as exactly old or new; an
unknown verifier fails closed and the previous DB password is never restored.
`resume` is also the correct recovery command after an interrupted cleanup or
after the terminal record was written but the client did not receive success.

If the normal forward path is deliberately abandoned while the durable state
is `db-rotated` or `bundle-applied`, the exceptional bounded baseline-recovery
path accepts only the already-new DB credential and converges to the same
rotated `process-local` terminal:

```bash
./deployment/rotate-process-local-credentials.sh rollback \
  --operation-directory "$AUD065_OPERATION" \
  --checkpoint-directory "$AUD065_CHECKPOINT"
```

This command is not a credential reversal. It applies or revalidates the same
new bundle, never restores the previous Secret or password, and rejects every
other starting state. Use `resume` for ordinary re-entry from any durable
state; use the `rollback` CLI only to assert this narrower one-way recovery from
`db-rotated` or `bundle-applied`.

The mutating coordinator completes only with the exact output
`aud065_rotation_complete`. Then run its separate read-only live audit:

```bash
./deployment/rotate-process-local-credentials.sh audit \
  --operation-directory "$AUD065_OPERATION" \
  --checkpoint-directory "$AUD065_CHECKPOINT"
```

Its only successful output is `aud065_rotation_verified`. The audit creates no
Lease, takes no lock, executes no callback and performs no Kubernetes mutation.
It reauthenticates the terminal operation and source promotion, requires the
exact 42-resource `process-local` inventory, all 12 baseline Deployments ready,
the two legacy pull bindings exact, the six rotated consumers exact, checkpoint
image continuity, released-normal
PostgreSQL policy, absent probe and absent operation lock.

Do not use `./deployment/verify-live-reactivation.sh` as the `AUD-065` gate: it
correctly requires the later `AUD-075` isolated-runner control plane. Its full
zero-failure/zero-warning result and cold desktop/mobile acceptance belong to
Fase 6, after `AUD-075` and `AUD-078` are deployed. At this baseline stage run
only the narrow functional smokes for credential rotation. Record only rotated
key names, operation state and safe verdicts; never record the operation ID,
HMACs, private baselines or credential material.

After that exact audit token, but before revoking the OLD GHCR PAT, update both
GitHub Actions `REGISTRY_PASSWORD` secrets from the same NEW Keychain item. Run
this only in the independent Terminal that owns the private rotation session;
the credential travels through stdin and is never placed in argv, an environment
variable, a workflow input or task output. Run exactly one supervisor instance
with the same immutable revision prefix; never start concurrent invocations or
switch Keychain items during a retry:

```bash
node ./deployment/update-aud065-actions-secrets-from-keychain.mjs \
  --keychain-account "$AUD065_KEYCHAIN_ACCOUNT" \
  --keychain-prefix "$AUD065_KEYCHAIN_PREFIX"
```

Its only successful output is `aud065_actions_secrets_updated`. The supervisor
holds one global per-user `/usr/bin/lockf` writer window, finishes and validates
the Keychain read before any GitHub mutation, preflights both repositories,
supplies the same mutable in-memory buffer only through each `gh secret set`
stdin, and requires a strictly newer non-secret `updatedAt` after each write. A
failure cannot reuse the pre-existing secret name as false evidence;
because OLD remains valid, a partial first-repository update is safe to retry.
The two repository writes are not atomic and cannot be rolled back by reading a
GitHub secret, so never revoke OLD after a partial/error result: re-run this
supervisor with the same unchanged Keychain item until its fixed success token.
Before revoking OLD, require the documented NEW digest pulls and non-publishing
upload authorization to succeed. Then revoke OLD, require its rejection to be
an explicit authentication failure, and repeat the same NEW checks. Record only
repository names, run IDs/timestamps and safe verdicts. A network error or
provider `5xx` is never revocation evidence.

Do not treat runtime convergence as provider revocation. Only after the
read-only audit has returned exactly `aud065_rotation_verified`, keep the
operation and old-values source private until each applicable external trust
domain has completed this sequence: new credential accepted, old credential
revoked at the provider, old credential rejected specifically as authentication
failure, then the new credential accepted again. A timeout, DNS failure, rate
limit or provider `5xx` is inconclusive and never proves revocation. Apply the
sequence to OpenAI, SMTP, GHCR package pulls and configured Sketchfab/Tenor
credentials; also perform the documented functional chat, magic-link and
asset-provider smokes. The three candidate-only bot keys are superseded by the
sealed, promoted values source but their replacements are deliberately not
applied to the legacy runtime. The pull credential is different: the
coordinator applies it by CAS to the legacy `Secret/ghcr-pull`; the separate
`bot-images-pull` objects remain exclusive to the later AUD-075 rollout.

Only after terminal re-entry, the process-local live gate, provider rejection
and functional acceptance may the old-values source and operation directory be
removed from active plaintext storage. Keep the joint checkpoint according to
the backup policy. The promoted root values file remains the only canonical
source for future generation: pass it through `HCCE_INPUT_VALUES_PATH` and do
not reuse an older ignored `hubs-cloud/community-edition/input-values.yaml`.

### Step 7: Generate hcce.yaml

```bash
cd hubs-cloud/community-edition
npm ci
npm run gen-hcce
```

Verify: `ls -lh hcce.yaml` should be 50-250KB.

### Step 8: Verify the generated manifest

`npm run gen-hcce` now runs `verify-generated-manifest.js` automatically. The
final `AUD-075` source generates exactly 58 resources and fails unless all of
these
invariants hold:

- `ret`, `dialog` and `nearspark` use cert-manager and per-ingress SSL redirect;
- every application ingress selects `haproxy` through `spec.ingressClassName`;
- global SSL redirect is disabled so ACME HTTP-01 solver ingresses remain reachable;
- HAProxy does not use the legacy Mozilla image or security context;
- every Deployment image and the separate runner image are pinned by an exact
  SHA-256 digest;
- PostgreSQL, Reticulum, Dialog and Coturn use `Recreate` for single-writer
  storage or exclusive host ports; bot-orchestrator also uses `Recreate` so an
  update never overlaps two authoritative runners;
- Reticulum has exactly one desired replica, no `rollingUpdate` fields and no
  HPA targeting its Deployment;
- Reticulum is non-privileged, drops every capability and has no propagated host mount;
- bot-orchestrator runs as UID/GID 1000, drops every capability, uses
  RuntimeDefault seccomp and receives only its namespaced Pod-control
  ServiceAccount;
- every dynamic runner uses the second digest, UID/GID 10001, a tokenless/RBAC-
  free ServiceAccount, read-only root, bounded `/tmp`, requests/limits, drop-ALL
  capabilities and RuntimeDefault seccomp;
- Photomnemonic runs as UID/GID 1000, drops every capability, uses RuntimeDefault seccomp and exposes only its
  audited HTTP health probes;
- Reticulum and bot-orchestrator carry the same orchestrator-key checksum, while
  the master runner key remains only in Reticulum;
- bot-orchestrator uses `/health` for liveness and `/transport-ready` for its
  Kubernetes readiness probe. The latter opens only after orphan cleanup;
  authoritative bot acceptance remains `/ready`, with navmesh, lease/epoch,
  config and spawn ACKs required;
- Reticulum, both PgBouncer pools and Coturn carry one matching DB-credential checksum;
- every Deployment except HAProxy and bot-orchestrator disables service-account
  token automounting; both exceptions use separate least-privilege accounts;
- Coturn does not use the known credential-leaking image;
- HAProxy has startup, readiness and liveness probes on `/healthz:1042`;
- all 13 containers have audited requests/memory limits and no CPU limit;
- the inventory contains exactly the primary namespace and
  `hcce-bot-runners`; the latter enforces, audits and warns at Pod Security
  `restricted` v1.34;
- there are exactly two equal `bot-images-pull` Secrets, one per namespace,
  referenced by the two bot ServiceAccounts only as `imagePullSecrets`;
- `bot-runner-capacity` limits the runner namespace to 10 Pods, 250 mCPU/1280
  MiB of requests and 5 CPU/5 GiB of limits;
- the cluster-scoped `ValidatingAdmissionPolicy/bot-runner-pods.yenhubs.org`
  and its exact `Deny` binding admit only the generated runner-Pod contract;
- the parent ServiceAccount receives create/delete/get/list Pod authority only
  through the Role/RoleBinding in `hcce-bot-runners`; the same-named legacy
  Role in the primary namespace has zero rules and both legacy objects carry
  `yenhubs.org/legacy-runner-authority: neutralized`;
- all eight NetworkPolicies keep the exact audited caller/port matrix. The two
  runner policies deny all ingress/default traffic, then allow only DNS,
  parent control and public TCP/443 egress;
- the Photomnemonic egress policy permits only kube-dns and public IPv4 TCP/80,443 while excluding private/reserved
  destinations;
- HAProxy RBAC contains CRD and Gateway API permissions;
- no obsolete self-signed bootstrap secret or unresolved placeholder remains;
- exactly one `LoadBalancer` service, two 10 GiB DigitalOcean PVCs and 58 total
  resources are generated.

Do not edit `hcce.yaml` manually. Fix the tracked template or input values and regenerate it.

### Step 9: Apply

```bash
kubectl --context "$EXPECTED_KUBE_CONTEXT" diff -f hcce.yaml
KUBECTL_CONTEXT="$EXPECTED_KUBE_CONTEXT" npm run apply
```

`npm run apply` reruns the generated-manifest verifier before its first cluster
mutation, requires that the pinned context is also the current context, holds
the global operation Lease and applies the generated resources sequentially.
Do not replace it with a direct `kubectl apply -f hcce.yaml`.

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
2. Enter the admin email `info@virtualmente.com` > check email for magic link > click it
3. Access admin panel at `https://yourdomain.com/admin`

Run the tracked read-only verifier from the repository root. It checks all four DNS records and certificates,
deployment readiness, restored DB counts, public HTTPS and the ghost-runner health contract without printing keys:

```bash
export NAMESPACE=hcce
export EXPECTED_KUBE_CONTEXT='<contexto-kubectl-exacto>'
export EXPECTED_NAMESPACE_UID="$(
  kubectl --context "$EXPECTED_KUBE_CONTEXT" get namespace "$NAMESPACE" \
    -o jsonpath='{.metadata.uid}'
)"
./deployment/verify-live-reactivation.sh
```

Do not continue to audited images or upstream upgrades until it reports zero failures. Functional room/UI tests are
still required afterwards; this script proves infrastructure health, not visual correctness.

Both this verifier and `preflight-reactivation.sh` require the Reticulum
Deployment to be the exact singleton contract above, exactly one Ready
Reticulum Pod, and a verified Pod -> ReplicaSet -> Deployment ownership chain
ending at that Deployment UID. Any extra Ready pod, owner/UID mismatch, HPA or
rolling strategy is a hard stop; it is not rollout overlap to tolerate.

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

# 3. Inspect the complete generated change, then use the tracked apply driver
kubectl --context "$EXPECTED_KUBE_CONTEXT" diff -f hcce.yaml
KUBECTL_CONTEXT="$EXPECTED_KUBE_CONTEXT" npm run apply

# 4. Verify
kubectl get pods -n hcce            # All Running
kubectl get certificates -n hcce    # All READY: True
kubectl get deployment hubs -n hcce -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl get deployment bot-orchestrator -n hcce -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl port-forward deployment/bot-orchestrator -n hcce 15001:5001 &
curl -s http://127.0.0.1:15001/health | jq .
curl -sI https://your-domain.com    # HTTP/2 with valid TLS
```

Do not extract any internal access key into a shell variable or process argument for an
ad-hoc smoke. The generated-manifest verifier, orchestrator tests and live
verifier cover the authenticated contract without exposing it. Any future
manual internal smoke must first add a reviewed helper that consumes the key
through a non-printing channel and never stores it in argv, history or output.

Bot-orchestrator security gate before promotion:

- `npm test` in `community-edition/services/bot-orchestrator` must pass.
- `npm audit --omit=dev` must report zero vulnerabilities.
- The Responses request must keep `store:false`, a pseudonymous
  `safety_identifier` and reply-only strict JSON Schema output. The model has no
  movement authority.
- Input/output moderation fails closed and shares a 4-second deadline with the
  model. Malformed or incomplete moderation responses are not allowed.
- `scene.model_url` is same-origin by default. Add a CDN only through `GHOST_SCENE_ALLOWED_HOSTS`; never disable the
  allowlist to fix a scene.
- The generated manifest fixes a 10 s timeout, 64 MiB scene limit, 4 MiB JSON limit, 50,000 nodes and 200,000 edges.
- GLB accessors are preflighted before any range fetch or allocation, and only
  the exact required byte range counts against the bounded aggregate scene budget.
- Production must expose `GHOST_NAVIGATION_MODE=navmesh_preferred`,
  `GHOST_NAVIGATION_REQUIRE_NAVMESH=true`, a 30-second clean recovery restart,
  a 50,000-triangle navmesh cap, 64 route points and a 3 m projection cap.
  `verify-generated-manifest.js` and `verify-live-reactivation.sh` enforce this.
- Before promotion, parse the current production GLB and require a valid navmesh plus routes between its expected
  `spawbot-*` points. A log such as `No valid navmesh` means readiness must be
  503; it is not an accepted fallback.
- Require authenticated runner Presence, exact
  `room-bot-<hub_sid>-bot-<1..10>` identities and authoritative spawn ACKs.
  `/ready` must remain 503 while auth, navmesh, population, ACK or a new room
  configuration is pending; `/health=200` alone is not acceptance.
- For the isolated runtime, require `/transport-ready=200` only as the parent
  bootstrap probe, then prove `/ready=200` separately. The live verifier must
  observe one stable Ready Pod per configured room, the exact runner digest,
  parent-Pod UID ownership, generation/room-HMAC labels, the tokenless
  `bot-runner` ServiceAccount and zero stale/terminal/unknown managed Pods.
- Verify that `bot-images-pull` exists only as the generated kubelet pull
  Secret, both bot ServiceAccounts reference it, neither container mounts it,
  and the parent Role/RoleBinding has no verb/resource beyond the exact
  generated Pod lifecycle contract.
- Validate one neutral chat reply and one explicit human
  `go_to_waypoint` command after rollout; the action must be derived outside
  model output and revalidated by Reticulum.
- `store:false` is not Zero Data Retention. Confirm the OpenAI organization policy and publish a privacy notice before
  real public conversations.

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

### Rollout compatible de Reticulum y runners aislados

`AUD-075`/`AUD-076` and the terminal-stop correction in `AUD-078` require a
server-first transition through three complete generated manifests. Do not
hand-edit, split or hotpatch `hcce.yaml`:

1. From the last accepted live `process-local` baseline, create and validate a
   fresh joint DB+storage checkpoint. Complete the coordinated `AUD-065`
   rotation next, using the existing live digests and configuration so that the
   rotation itself does not advance the candidate runtime. Verify the baseline
   and rollback with current credentials before continuing.
2. Integrate and validate `AUD-078` in its own Cloud branch and PR. Only after
   `AUD-075` through `AUD-078` are in the accepted Cloud source may the approved
   workflow build `bot-orchestrator` and `bot-runner` from that same commit.
   Record both immutable digests and update the private pull config only in a
   mode-`0600` values copy.
3. Generate the complete 58-resource manifest with
   `BOT_RUNNER_ACTIVATION_PHASE=bootstrap`. Review the context-pinned,
   redacted `kubectl diff`, then apply it exclusively with
   `KUBECTL_CONTEXT="$EXPECTED_KUBE_CONTEXT" npm run apply`. Reticulum and its
   migrations become compatible while the parent and runner authority remain
   fenced.
4. Regenerate the same complete 58-resource inventory with phase `admission`,
   review the diff and run the same wrapper. Require the admission policy,
   effective RBAC checks and the negative unauthorized-Pod probe before
   granting runner authority.
5. Regenerate the complete 58-resource inventory with phase `active`, review
   the diff and run the wrapper again. Require `/transport-ready`, authoritative
   `/ready`, all eight NetworkPolicies and the live per-room Pod verifier.
6. Complete cold desktop/mobile, 0/5/10 bot, chat/privacy, quarantine inventory,
   terminal-stop acceptance and `./deployment/verify-live-reactivation.sh`.
   Until every gate is green, the source integration is not a deployed or
   attested result.

A new runner cannot authenticate against old Reticulum; this is expected
fail-closed behavior, not permission to bypass the order. Rollback is the
reverse compatibility sequence: first disable/quarantine public bots and prove
zero managed runner Pods, then apply a complete generated rollback phase that
restores the previous process-local parent while retaining compatible new
Reticulum.
Verify legacy authentication privately, and only then apply the generated old
Reticulum manifest. The current live `process-local` runtime remains the last
accepted historical baseline. If a candidate rollout returns to it, keep public
bots disabled and do not reopen or re-declare that rollback accepted until the
current preflight, live verifier and cold-browser gates pass with the rotated
credentials. It is never evidence for capacity certification.

Applying the older manifest does **not** prune objects it no longer contains.
Do not declare rollback clean merely because the old Deployments are Ready:
inventory the candidate ServiceAccounts, Role, RoleBinding,
`bot-images-pull` Secret and runner NetworkPolicy. Keep them inert while no
managed runner Pod exists, then remove them only through a reviewed tracked
cleanup/prune transition. Do not improvise manual RBAC or Secret patches.

---

## Custom Hubs Client Rollout

Use this when shipping client-side features (for example third-person camera, UI changes, avatar logic).

### Authoritative sitting: mandatory server-first order

The waypoint reservation protocol 2 client must never be promoted before its matching
Reticulum migration/channel implementation:

1. complete local gates, commit/push and build both images only through GitHub
   Actions; resolve immutable digests before any staging rollout;
2. create and validate a joint PostgreSQL + `ret-pvc` checkpoint for any shared
   target;
3. generate/apply staging with Reticulum protocol 2 first while preserving the
   previous Hubs digest, then confirm the migration, legacy join compatibility
   and the PostgreSQL-backed globally monotonic `state_version` source; the
   read-only `GET /health/capabilities` response must match the exact protocol 2
   `state_version` and `snapshot_state_version` semantics accepted by
   `deployment/verify-live-reactivation.sh`;
4. keep seats closed during that mixed-client window: legacy NAF occupancy is
   not an authoritative grant;
5. regenerate/apply staging with Hubs protocol 2 immediately afterwards; its
   join snapshot must expose `snapshot_state_version` as the state floor and it
   must ignore equal/older broadcasts;
6. in staging, race two isolated browser contexts for the same published seat
   and require exactly one winner, identical remote pose/state, safe Stand,
   reclaim and disconnect release;
7. only after staging is clean, promote the same digests to production using
   the same Reticulum-first/Hubs-second generations, then perform cold
   desktop/mobile and live verifier gates.

A valid seat has a stable published network identity and the Spoke flags
`Disable motion`, `Can be occupied` and `Clickable`. Reticulum protocol 2 may remain in
place during a client rollback; do not drop the reservation table or reverse a
migration while leases may exist.

The endpoint is a rollout negotiation contract, not a substitute for the
two-browser race. An older or extended response fails closed: do not promote the
Hubs digest until the exact Reticulum capability and the isolated-browser
acceptance both pass.

### Recommended Loop (No Extra DigitalOcean Cost)

The cheapest and most reliable loop is:

1. Push code to GitHub.
2. Build + push the image in **GitHub Actions** (no DO CPU/RAM usage, avoids in-cluster OOM builds).
3. Resolve the published registry digest and update `OVERRIDE_HUBS_IMAGE` as `repository@sha256:<digest>` in the local
   values file.
4. Run `npm run gen-hcce`, review the complete context-pinned `kubectl diff`,
   and deploy with `KUBECTL_CONTEXT="$EXPECTED_KUBE_CONTEXT" npm run apply`.
5. Verify the rollout and restart Reticulum to refresh page-origin HTML.

Concrete commands (after the image exists in your registry):

```bash
cd /Users/Shared/Gits/YenHubs
cp deployment/input-values.local.yaml hubs-cloud/community-edition/input-values.yaml
cd hubs-cloud/community-edition
npm run gen-hcce
kubectl --context "$EXPECTED_KUBE_CONTEXT" diff -f hcce.yaml
KUBECTL_CONTEXT="$EXPECTED_KUBE_CONTEXT" npm run apply
kubectl -n hcce rollout status deployment/hubs --timeout=300s
kubectl -n hcce get deployment hubs -o jsonpath='{.spec.template.spec.containers[0].image}'; echo

# Reticulum caches the page-origin HTML and hashed asset references. After any hubs image update,
# restart reticulum so /admin and room pages don't reference missing old hashes.
kubectl -n hcce rollout restart deployment/reticulum
kubectl -n hcce rollout status deployment/reticulum --timeout=300s

curl -sI https://meta-hubs.org | head -n 1
```

The HTTP/CSP verifier is necessary but not sufficient. After the Reticulum restart, perform a cache-disabled cold load
of the room in a real browser and verify all of the following before accepting the rollout:

- `window.APP` and `window.AFRAME` exist in the page's main execution context;
- the lobby/scene renders instead of a blank page;
- the console has no first-party `Runtime.exceptionThrown` event;
- the room HTML references the new `hub-*.js` hash;
- desktop, tablet and mobile layouts do not create document-level horizontal overflow.

This gate caught the `js-cookie` 2 -> 3 runtime incompatibility even though every asset returned 200 and CSP was
valid. Never accept a Hubs rollout using only `curl` or `verify-page-assets.mjs`.

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

Current credential state (2026-07-16): registry authentication was renewed in
the macOS Keychain (`YenHubs-GHCR`), both repositories' masked Actions secrets
and `Secret/ghcr-pull`. Pull by digest succeeds for Hubs, Reticulum and
bot-orchestrator, and the credential can initiate a GHCR upload. The complete
preflight reports 0 failures and 0 warnings.

For the next rotation, create the replacement PAT through a private provider
channel and keep the previous PAT valid. Update the macOS Keychain and the
masked `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` secrets in both GitHub
repositories without placing the credential in argv, workflow inputs or task
output. Put the same new credential into the private new-values source only via
the tracked hidden-input updater. The AUD-065 coordinator then replaces
`Secret/ghcr-pull` by UID/resourceVersion CAS and verifies
`ServiceAccount/default` as a read-only invariant. Never use the former
`kubectl apply` plus `kubectl patch serviceaccount` sequence: it bypasses the
operation binding and is no longer an approved path.

After the coordinator and its audit succeed, verify pulls of every applicable
live GHCR digest and a non-publishing upload authorization, revoke the previous
PAT, prove its authentication rejection, and repeat the new pull/upload checks.
Do not treat a timeout, DNS error, rate limit or provider 5xx as revocation
evidence.

Do not restart nodes or deployments after a future rotation until the preflight
proves that all private digests can be pulled.

Common failures:

- `Username and password required`: registry username/password are missing (no secrets, no override inputs).
- `403 Forbidden` from GHCR on HEAD requests (for example buildcache manifests or blobs): the token does not have package rights, or the GHCR package is not granting repo access. Set repository secrets `REGISTRY_USERNAME=<owner>` and `REGISTRY_PASSWORD=<PAT with read:packages + write:packages>`, then rerun the same workflow. Also verify that Actions has read/write workflow permissions and that the workflow requests `packages: write`. Do not switch to a local or in-cluster build as a workaround.
- `failed to read dockerfile: open Dockerfile: no such file or directory` on `hubs-cloud` bot-orchestrator builds: the workflow already defaults to `Override_Code_Path=community-edition/services/bot-orchestrator` and `Override_Dockerfile=community-edition/services/bot-orchestrator/Dockerfile`. Do not set `Override_Dockerfile=Dockerfile`; leave it empty or pass the full path.
- `Invalid workflow file ... Unrecognized named-value: 'secrets'`: the `hubs/.github/workflows/hubs-RetPageOrigin.yml` workflow had a job-level `if:` that referenced `secrets.*` on a job that calls a reusable workflow (`uses:`). GitHub Actions rejects this at parse time. Fix: gate that job using `github.repository_owner` (or an explicit repo var like `ENABLE_TURKEY_GITOPS`) and pass secrets only in the `secrets:` block, not in the job `if:`.
- Docker tag errors when building from branches like `codex/foo`: Docker tags cannot contain `/`. Fix: sanitize the tag in CI (replace `/` with `-`) or set `Override_Image_Tag` to a slash-free value.
- `bot-orchestrator` or dynamic `bot-runner` `ErrImagePull`: require both exact
  digests, regenerate `BOT_IMAGE_PULL_CONFIG_JSON_BASE64` through the hidden
  updater and rerun preflight. If either image is unavailable, stop; restore the
  previous generated manifest through the compatible rollback order instead of
  scaling or patching workloads by hand.

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

The durable rollout is checkpoint and coordinated rotation first, then accepted
source (`AUD-078` included), GitHub Actions images, immutable local overrides,
three complete 58-resource generations (`bootstrap` -> `admission` -> `active`)
and the context-pinned `npm run apply` driver for every phase. Local Docker
builds, direct `kubectl apply -f hcce.yaml`, in-cluster builds and runtime-only
patches are not approved deployment methods for this project.

### GHCR notes (if using `ghcr.io`)

- Pushing from automation requires a token with package write scopes (for example PAT with `write:packages` and `read:packages`). Keep it in the repository secret `REGISTRY_PASSWORD`, never in a tracked YAML file or workflow-dispatch input.
- If the token is missing `write:packages`, the push fails with an error like: `permission_denied: The token provided does not match expected scopes.`
- If the package is private, the cluster also needs `imagePullSecrets` for `ghcr.io`; otherwise pods fail with `ErrImagePull` / `ImagePullBackOff`.
- If you are not managing registry auth explicitly, prefer a registry/tag that your cluster can pull without extra setup.

#### Cluster Pull Auth (Private GHCR)

The historical live baseline can still contain registry authentication created
under its earlier procedure. Treat that state as inventory only: do not repeat
manual `kubectl create secret` or ServiceAccount patches for the candidate.

The candidate uses the generated dedicated `bot-images-pull` contract. The
58-resource generator creates that Secret and binds it explicitly to
`bot-orchestrator` and `bot-runner`
ServiceAccounts. Populate its private source only with
`npm run set-bot-image-pull-config` and hidden/environment `GHCR_TOKEN`; never
print or decode `BOT_IMAGE_PULL_CONFIG_JSON_BASE64`, and never attach the pull
Secret to a container volume.

> Important: if `BASE_ASSETS_PATH` is not set during build, pages may reference `/assets/...` and return 404 in production domains that serve assets from `assets.<domain>/hubs/`.
>
> Debugging tip: the **correct** static host/path is `https://assets.<domain>/hubs/...`. Requests like `https://<domain>/assets/...` can return confusing errors (for example `bad Room ID`) because they hit reticulum instead of the hubs static service.

### Recovery from bad custom image

If hubs rollout gets stuck with `ErrImagePull` / `ImagePullBackOff`:

1. Restore the previous known-good digest-pinned `OVERRIDE_HUBS_IMAGE` in `deployment/input-values.local.yaml`.
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
The official Hubs CE HAProxy image (`mozillareality/haproxy:stable-latest`) is based on `haproxytech/kubernetes-ingress:1.8.5` (2022), which only supports K8s 1.21-1.23. Since K8s 1.31 is no longer available on DigitalOcean, this image crashes on every available K8s version. We use the captured HAProxyTech 3.2 digest directly; the readable `3.2` tag is documentation, not the runtime pin.

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

For this deployment, the administrator login is `info@virtualmente.com`; it is not necessarily the identity used to
sign in to the Mailtrap dashboard. Locate the provider configuration by Mailtrap account ID `2385821` and verified
domain `meta-hubs.org`.

If Reticulum logs an error equivalent to:

```text
{error,{options,incompatible,[{verify,verify_peer},{cacerts,undefined}]}}
```

the network and credentials may be correct. Bamboo's legacy `gen_smtp` adapter inherits `verify_peer` on OTP 27 but
does not receive a CA bundle. Keep `tls: :always`, `ssl: false` and `tls_verify: :verify_none` together in
`community-edition/services/reticulum/config/prod.exs`. Do not remove STARTTLS and do not report the email as sent
unless `Ret.Mailer.deliver_now/1` returns success.

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

Usar el comando compuesto, que crea DB, storage, inventario y checksums:

```bash
export NAMESPACE=hcce
export EXPECTED_KUBE_CONTEXT='<contexto-kubectl-exacto>'
test "$(kubectl config current-context)" = "$EXPECTED_KUBE_CONTEXT"
export EXPECTED_NAMESPACE_UID="$(
  kubectl --context "$EXPECTED_KUBE_CONTEXT" get namespace "$NAMESPACE" \
    -o jsonpath='{.metadata.uid}'
)"
test -n "$EXPECTED_NAMESPACE_UID"
export EXPECTED_RET_PVC_UID="$(
  kubectl --context "$EXPECTED_KUBE_CONTEXT" get pvc ret-pvc -n "$NAMESPACE" \
    -o jsonpath='{.metadata.uid}'
)"
test -n "$EXPECTED_RET_PVC_UID"
ALLOW_CHECKPOINT_DOWNTIME=1 ./deployment/create-checkpoint.sh
```

La opción de downtime es obligatoria: el comando toma un lock global
inmutable, captura el contrato post-lock y lleva Reticulum, ambos Pgbouncers,
bot-orchestrator y Coturn exactamente a cero mediante CAS antes de leer DB o
PVC. Además espera y monitoriza cero Pods dinámicos gestionados de `bot-runner`
durante toda la quiescencia; si reaparece uno, falla cerrado y no reanuda
escritores. Si no puede reanudar bajo las mismas
UID/resourceVersion/plantillas, retiene el lock y deja los escritores a cero
para revisión.

Antes de la primera mutación, `create-checkpoint.sh` clasifica y liga una de dos
fronteras exactas. El baseline histórico `process-local` solo es admisible con
su Deployment legacy completo, token de ServiceAccount desactivado, sin
bindings ni anotaciones del runner aislado y sin el namespace
`hcce-bot-runners`. El modo `kubernetes-pod` exige el manifiesto `active`,
admission, Role y RBAC efectivo exactos. Cualquier mezcla, fase parcial o
namespace residual selecciona el gate aislado y falla: nunca cae al camino
legacy. El modo capturado se vuelve a comprobar mientras los writers están a
cero y justo antes de reanudar el parent; si cambia, conserva el lock y la
autoridad del parent permanece parada.

Antes de cualquier mutación del clúster, el driver liga los valores locales a
una copia privada `0600`, inmutable para esa ejecución. En modo
`kubernetes-pod` liga además el manifiesto generado antes de reducir workloads;
`process-local` no requiere ese manifiesto. Todos los gates posteriores
consumen exclusivamente esas copias y las eliminan al salir. Una rotación
posterior de los ficheros originales no cambia la autorización capturada ni
impide la reanudación exacta; una deriva durante la copia falla antes del
downtime.

Las trampas `ERR` heredadas por sustituciones de comando o procesos en segundo
plano solo propagan el fallo. Esos subshells contienen copias obsoletas del
estado de ownership y nunca pueden reanudar escritores ni liberar locks. Solo
el shell principal ejecuta una única recuperación autoritativa; si la
reanudación exacta no es posible, conserva el lock y los escritores permanecen
detenidos.

El dump verifica esquema y migraciones; el backup de storage exige que cada `owned_file` activo tenga su par
`.blob`/`.meta.json` y que no exista ningun par fisico incompleto. Puede incluir pares completos adicionales en estado
diferido: Reticulum los conserva durante la ventana de gracia de 24 horas antes de moverlos a `expiring`. Un checkpoint
no se considera completo si falta cualquiera de los dos artefactos. Antes de
crear `SHA256SUMS`, `validate-checkpoint.sh` vuelve a extraer los UUID activos
del dump SQL, exige al menos una sala y un UUID activo, y los compara offline
con ambos miembros de cada par del tar. `SHA256SUMS` contiene un nombre exacto,
sin prefijo, para cada artefacto permitido y ninguna entrada adicional. El
checkpoint incluye `database-contract.json`, `checkpoint-metadata.json`,
`deployment-images.json` y `k8s-hcce-structure.json`. El contrato de base de
datos fija de forma checksummed los schemas, todas las relaciones, las versiones
exactas de migracion, los SID de salas, todos los UUID/estados de `owned_files`
y los conteos criticos; se captura antes y despues de
`pg_dump` y debe coincidir exactamente con el DDL/COPY del dump. La captura
Kubernetes es solo estructural: omite
valores de entorno, comandos, argumentos y valores de anotaciones; de los
ConfigMap conserva solo los nombres de claves. El inventario exige los 12
Deployments, 13 pares Deployment/contenedor, ningun `initContainer` ni
contenedor efimero. `deployment-images.json` usa schema 3 y añade
`bot_runner_runtime`: el rollback legacy es exactamente
`{mode:"process-local",image:null}`; el runtime aislado es
`{mode:"kubernetes-pod",image:"...@sha256:..."}`, ligado al override privado
exacto de `bot-runner`. Todos los digests y la paridad con los overrides se
capturan desde una copia
temporal `0600`. Todos los artefactos se crean con `umask 077` y permisos
`0600`. El directorio final aparece mediante un unico `mv` solo despues de
validar contenido y checksums; una colision o fallo elimina unicamente el
staging privado de esa ejecucion y nunca publica un checkpoint parcial.

Solo se acepta para restauración destructiva un
`checkpoint-metadata.json` schema 2 generado localmente por este flujo, con
`external_import=false` y la misma evidencia de quiescencia/lock. Los SHA-256
detectan deriva de bytes —incluido cualquier DDL SQL no inventariado—, pero no
autentican un artefacto externo: copiarlo y recalcular sus checksums no lo
convierte en un checkpoint autorizado.

El checkpoint siguiente es evidencia historica anterior al contrato actual de
layout exacto y frescura. No usarlo para otro rollout: crear uno nuevo con el
comando trackeado inmediatamente antes del rollout.

```text
output/backups/20260716-183112/
```

Contiene schema 356, 94 migraciones, 33 archivos activos, 47 pares completos y
14 diferidos validos bajo el contrato anterior.

> A Reticulum backup is complete only when it contains **both** the PostgreSQL dump and the `ret-pvc` archive.
> PostgreSQL stores UUIDs, keys and relationships; the actual scenes, Spoke projects, avatars and thumbnails are
> encrypted files in `ret-pvc`. A database-only dump cannot restore user content.

The March 2026 DB-only freeze was incomplete and must not be used as a current
restore source. Its forensic documentation is archived in `OLD/docs/`. Never
fabricate files under `/storage/owned`; owned files are encrypted and coupled
to DB metadata. A recovery project can still be generated for investigation:

```bash
node deployment/generate-recovery-spoke-project.js \
  --scene-url 'https://meta-hubs.org/files/<UPLOADED-UUID>.glb' \
  --output-dir output/media-recovery-project
```

The generated bot and sitting waypoint positions and its two recovery lights are provisional and must be checked
visually before publishing to a new test room. The command performs no upload and makes no cluster changes.

The functional recovery completed on 2026-07-14 is:

| Artifact | Identifier / URL |
|----------|------------------|
| Verified source upload | scene `fuWfRdF` |
| Editable Spoke project | `https://meta-hubs.org/spoke/projects/qa3U3Ke` |
| Published recovery scene | `https://meta-hubs.org/scenes/f6VKtim` |
| Functional test room | `https://meta-hubs.org/XesSAqd/prickly-nice-huddle` |

The room contains one spawn, eight `spawbot-recovery-*` patrol points and two `Disable motion` sitting waypoints.
Live smoke testing confirmed three ghost bots, movement, hidden runner identity, first/third-person toggle and the bot
chat endpoint. The scene is a functional reconstruction, not an exact byte-for-byte copy of the lost Spoke project.

On 2026-07-16 the same Spoke project was republished after adding a native `Floor Plan`. The published scene SID
remained `f6VKtim` and now points to model
`https://meta-hubs.org/files/749efd34-73a0-496c-8584-3958b01ef186.bin`. The GLB contains a node named `navMesh`
with the `nav-mesh` component, and a cold room load confirmed one runtime nav mesh and no browser errors.

Later on 2026-07-16 the two sitting waypoints were corrected so that they are both `Disable motion` and `Clickable`.
The scene SID remains `f6VKtim`; its current model is
`https://meta-hubs.org/files/beadd397-5ade-4105-ae24-2e7189edea9e.glb`. The current editable project is still
`qa3U3Ke`. Production verification found 10 waypoints, exactly two sitting waypoints, exactly two clickable sitting
waypoints, and both `navMesh` and `Floor Plan` nodes. Holding Space after fully entering the room shows two white
waypoint targets. `Mirar` leaves the user in the lobby and is not a valid test of entered-room waypoint interaction.

That live authoring predates the authoritative reservation candidate. Before
using this scene for its staging acceptance, publish `Can be occupied=true` on
each intended seat and verify that its `networked.id` is stable. Until then the
two current waypoints demonstrate the legacy Sit/Stand UI only; they do not
satisfy the reservation protocol 2 seat contract.

Waypoint property distinction:

- `Disable motion`: YenHubs treats the waypoint as a seat and applies the sitting state/animation.
- `Can be occupied`: opts the waypoint into the authoritative reservation
  protocol; required by the candidate Sit button.
- `Clickable`: Hubs renders a target for that waypoint while the entered user holds Space.
- `networked.id`: persistent identity used as the server `waypoint_id`; recreating
  a waypoint can change it and must be treated as a content migration.
- A legacy seat can work through the old toolbar proximity flow with only
  `Disable motion`, but it is not an acceptable authoritative seat.

Ownership is also split between room and content records. The current account for `info@virtualmente.com` owns scene
`f6VKtim` and project `qa3U3Ke`. Room `VJopCY3` retains its historical creator and additionally grants that current
account an owner membership. Therefore:

- room settings and lifecycle controls are available in Hubs after a fresh authenticated room join;
- permanent geometry, waypoints and publishing are available through the direct Spoke project URL;
- placing temporary media/objects inside a room is not the same operation as editing and republishing the scene.

This distinction is mandatory for recovered scenes:

- `walkable`/`collidable` on the imported office model describes the model but does not generate player navigation.
- A Spoke `Floor Plan` generates the `nav-mesh` used both by the Hubs character controller and by the ghost runner.
  Bots project `spawbot-*` waypoints onto this mesh and use A* to route around structures.
- `box-collider` remains a legacy/diagnostic aid for old scenes. It is not a
  production fallback, does not satisfy bot readiness and cannot calculate a
  route around an obstacle.

Before republishing a live scene, create a matching DB and `ret-pvc` checkpoint. The checkpoint for this repair is
`output/magiclink-scene-prepublish-20260716-093347/`, with hashes in `SHA256SUMS`.

The checkpoint immediately before the room-ownership and clickable-seat correction is
`output/room-seat-ownership-prechange-20260716-114047/`. It contains a compressed Reticulum database dump, the
Reticulum storage archive and checksums. The nested `seat-clickable-publish/` directory records the downloaded
pre-change files, exact pre/post hashes and authenticated publication responses; temporary auth material is ignored
and must never be committed.

The nine recovered avatar GLBs can be reimported from Admin at `https://meta-hubs.org/admin#/import`. Do not use the
trailing-slash form `/admin/`; it is not a valid route in this deployment. The preferred flow is `Upload Avatars from
Disk`. The current Hubs/Reticulum images allow a standalone GLB to bootstrap without a historical base parent and
space avatar creation requests by 1100 ms to respect Reticulum's 1 TPS rate limit.

`deployment/verify-live-reactivation.sh` must report a non-zero coherent active
set and a physical pair for every active UUID. At the 2026-07-16 checkpoint the
expected state is 33 active rows and 47 complete pairs, including 14 deferred
pairs. A zero volume, missing active UUID or incomplete physical pair is a hard
failure; stop instead of forcing DB rows active.

For disaster recovery when the native file selector is unavailable, render fresh thumbnails and use the tracked API
import helper. Supply a short-lived admin token through the environment; never put it in Git or command history:

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python deployment/render-avatar-thumbnails.py -- \
  --input-dir /path/to/avatar-glbs \
  --output-dir /path/to/avatar-thumbnails

YENHUBS_AUTH_TOKEN='<temporary-admin-token>' \
node deployment/import-local-avatars.mjs \
  --base-url https://meta-hubs.org \
  --thumbnail-dir /path/to/avatar-thumbnails \
  --featured --base base.glb --default base.glb \
  /path/to/avatar-glbs/*.glb
```

The helper preserves PostgREST 64-bit IDs, detects RPM/full-body skeleton names, generates active listings and marks
avatars reviewed. It also reuses an unreviewed parentless avatar left by an interrupted attempt. It is a recovery
tool, not the normal day-to-day import path.

After restoring `retdb`, invalidate assumptions about browser login state. A stale Spoke token may still render a
`Logout` link while `/api/v1/projects` returns `401` (sometimes labelled as a possible CORS error by the UI). Log out
and request a fresh magic link for `info@virtualmente.com` before diagnosing the API or ingress.

Do not run `/ret/bin/ret eval` or `/ret/bin/ret rpc` inside the production Reticulum container. Both release helpers
start enough BEAM runtime state to exceed the live container budget on this topology and can restart the service.
Use the authenticated Reticulum APIs, SQL through PostgreSQL or a separate isolated pod/canary. If a diagnostic
command does restart Reticulum, stop all mutations, wait for `reticulum` to return `2/2`, and require public HTTP 200
before continuing.

### Restore one coordinated Reticulum checkpoint

The database is named `retdb`. A plain `pg_dump` does not include cluster-level
roles, but the restored grants need the internal NOLOGIN role `ret_admin`. Never
pipe the dump directly into an empty database. The DB dump, storage archive,
`database-contract.json` and every checksummed inventory artifact must remain in
one exact checkpoint directory. The coordinated driver verifies the directory,
copies DB, storage and the contract into one private `0600` materialization,
rehashes and jointly validates those copies, then has both restore children
consume only their own independently revalidated copies:

```bash
# Combined read-only preflight; it does not execute or rehearse either restore.
export EXPECTED_RET_PVC_UID="$(kubectl --context "$EXPECTED_KUBE_CONTEXT" \
  get pvc ret-pvc -n "$NAMESPACE" -o jsonpath='{.metadata.uid}')"
RESTORE_CHECKPOINT_PREFLIGHT=1 ./deployment/restore-checkpoint.sh \
  /absolute/path/to/checkpoint

# Resolve confirmation fields by exact filename equality.
STAMP=YYYYMMDD-HHMMSS
DUMP_SHA="$(awk -v f="retdb-$STAMP.sql.gz" 'substr($0,67)==f {print substr($0,1,64)}' \
  /absolute/path/to/checkpoint/SHA256SUMS)"
STORAGE_SHA="$(awk -v f="ret-storage-$STAMP.tar.gz" 'substr($0,67)==f {print substr($0,1,64)}' \
  /absolute/path/to/checkpoint/SHA256SUMS)"

# Destructive restore into a fresh/empty ret-pvc. The only accepted
# confirmation binds the cluster, namespace, complete checkpoint and PVC UID.
CONFIRM_RESTORE_CHECKPOINT="checkpoint:${EXPECTED_KUBE_CONTEXT}:${NAMESPACE}:${EXPECTED_NAMESPACE_UID}:${STAMP}:${DUMP_SHA}:${STORAGE_SHA}:${EXPECTED_RET_PVC_UID}" \
  ./deployment/restore-checkpoint.sh /absolute/path/to/checkpoint
```

Standalone destructive calls to `restore-retdb.sh` and
`restore-ret-storage.sh` are rejected; those scripts remain directly callable
only in their read-only `*_PREFLIGHT=1` modes. The driver records the original
replicas and keeps Reticulum, both Pgbouncers, bot-orchestrator and Coturn at
zero continuously from before the DB drop until the DB contract, exact active
UUID set, restored PVC pairs and live target identities have all passed. There
must also be zero managed dynamic `bot-runner` Pods throughout quiesce and
restore; their reappearance aborts the operation and preserves the fail-closed
state. There is no intermediate DB-only scale-up. The storage child independently holds all
five consumers at zero and rechecks both the checksummed DB contract and the
exact active UUID set immediately before creating its restore pod. Before the
first DB mutation, the driver creates an immutable, create-only ConfigMap lock
bound to the exact context, namespace UID, PVC UID, checkpoint stamp and both
artifact hashes. A contender cannot adopt or delete that lock and exits before
scaling or dropping anything. The driver revalidates its UID, private token and
exact metadata at every destructive phase; it deletes the lock only after the
complete ordered resume succeeds. It resumes Pgbouncer first, then Reticulum
and only after Reticulum is Ready starts Coturn and bot-orchestrator, whose
readiness depends on an authoritative Reticulum snapshot.

El fail-close del restore también tiene un único propietario: solo el driver
principal puede volver a cercar consumidores, retener el lock o completar la
recuperación. Un error o reintento dentro de un subshell devuelve estado al
driver, pero no puede duplicar el fencing ni liberar el lock.

```bash
# Optional component diagnosis remains read-only.
RESTORE_PREFLIGHT=1 ./deployment/restore-retdb.sh \
  /absolute/path/to/checkpoint/retdb-$STAMP.sql.gz
RESTORE_STORAGE_PREFLIGHT=1 ./deployment/restore-ret-storage.sh \
  /absolute/path/to/checkpoint/ret-storage-$STAMP.tar.gz
```

The coordinated restore refuses unsafe/symlinked artifacts or directory
components, an incomplete or drifted DB contract, unsafe archive paths, a
zero/incoherent DB UUID
baseline, missing active UUIDs, incomplete blob/metadata pairs, a non-empty
destination and a Reticulum image not pinned by an exact digest. Complete
deferred pairs are restored with the active set so Reticulum can finish its
normal grace-period cleanup. A timeout or remaining Reticulum pod blocks
creation of the tokenless, non-root (`UID/GID/fsGroup 1000`), read-only-root
restore pod and any PVC write. That pod is also create-only and is accepted
only after its admitted UID, unpredictable owner token, sole container, exact
digest, command, hardening and direct `ret-pvc` -> `/storage` mount (without
`subPath`) match; a same-name replacement is neither used nor deleted. The PVC
UID and pod ownership are rechecked and every consumer is polled throughout
extraction; only that exact restore pod may mount `ret-pvc`. On a failure after
quiescing, every DB consumer is forced back to zero and the global lock is
retained for inspection.

After reviewing and correcting the failure, clear a retained lock only while
all five consumers remain at zero. The clearance mode is deliberately
clear-only: it revalidates the exact checkpoint, cluster, namespace, PVC, lock
UID/token and absence of PVC consumers, requires exact confirmation, deletes
only the owned lock and never resumes a workload:

```bash
RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1 \
CONFIRM_CLEAR_RESTORE_LOCK="restore-lock:${EXPECTED_KUBE_CONTEXT}:${NAMESPACE}:${EXPECTED_NAMESPACE_UID}:${STAMP}:${DUMP_SHA}:${STORAGE_SHA}:<LOCK_UID>:${EXPECTED_RET_PVC_UID}" \
  ./deployment/restore-checkpoint.sh /absolute/path/to/checkpoint
```

Do not scale individual workloads manually; clear or rerun the complete
coordinated restore, or reapply a validated manifest, only after recovery has
been reviewed.

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

The complete client lifecycle and offboarding checklist is maintained in
`deployment/client-instance-lifecycle.md`. Do not delete infrastructure from
this abbreviated sequence unless the complete checkpoint has passed both
restore preflights and exists in a second encrypted location.

```bash
# 1. Confirm a matching DB dump and ret-pvc archive both exist and validate.
gzip -t /path/to/retdb-YYYYMMDD-HHMMSS.sql.gz
./deployment/validate-checkpoint.sh \
  /path/to/retdb-YYYYMMDD-HHMMSS.sql.gz /path/to/ret-storage-YYYYMMDD-HHMMSS.tar.gz
RESTORE_CHECKPOINT_PREFLIGHT=1 ./deployment/restore-checkpoint.sh \
  /path/to/checkpoint

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

## Rebuild After The Freeze

When resuming the project:

1. Recreate the DOKS cluster in AMS3 with one 8GB / 4vCPU node and no HA.
2. Restore kubeconfig with `doctl kubernetes cluster kubeconfig save hubs-ce`.
3. Reinstall cert-manager and reapply `/Users/Shared/Gits/YenHubs/deployment/ingress-class.yaml` plus `/Users/Shared/Gits/YenHubs/deployment/cluster-issuer.yaml`.
4. Copy the local `input-values.local.yaml` back into `hubs-cloud/community-edition/input-values.yaml`.
5. Run `npm ci && npm run gen-hcce`; the command verifies TLS, ingress class, RBAC and the single-LB invariant.
6. Complete the tracked `bootstrap` -> `admission` -> `active` generation,
   context-pinned diff and `npm run apply` sequence documented above; never
   hand-edit or apply `hcce.yaml` directly.
7. Restore DB and the matching fresh/empty `ret-pvc` only through
   `deployment/restore-checkpoint.sh`; never resume between the two halves.
8. Confirm the driver brings proxies and Reticulum Ready before bot-orchestrator.
9. Validate `meta-hubs.org`, TLS, room entry, avatar flow, and bots (`ghost` backend).

The full lifecycle checklist for this rebuild is maintained in:

```bash
/Users/Shared/Gits/YenHubs/deployment/client-instance-lifecycle.md
```

## References

- [Official Hubs CE Guide](https://docs.hubsfoundation.org/beginners-guide-to-CE.html)
- [cert-manager docs](https://cert-manager.io/docs/)
- [HAProxy Ingress Controller 3.2](https://www.haproxy.com/documentation/kubernetes-ingress/community/)
- [DigitalOcean Kubernetes](https://docs.digitalocean.com/products/kubernetes/)

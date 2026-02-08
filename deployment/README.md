# YenHubs Deployment Guide

Hubs Community Edition 2.0.0 on DigitalOcean Kubernetes with automated SSL via cert-manager.

> **Last updated**: February 2026 | **Cluster**: K8s 1.34 | **Region**: AMS3

---

## Architecture

```
Internet
    |
    v
DigitalOcean Load Balancer (152.42.148.243)
Ports: 80, 443, 4443, 5349
    |
    v
HAProxy Ingress Controller (haproxytech/kubernetes-ingress:3.2)
- Routes traffic by host/path
- TLS termination (certs from cert-manager)
- ssl-redirect per ingress annotation
    |
    +---> Reticulum (:4001)    -- API server, serves Hubs/Spoke HTML
    +---> Hubs (:8080)         -- Web client (stable-3108)
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

## Current Cluster State

| Component | Version / Image |
|-----------|----------------|
| Kubernetes | 1.34.1-do.3 |
| HAProxy | `haproxytech/kubernetes-ingress:3.2` |
| Hubs client | `hubsfoundation/hubs:stable-3108` |
| Reticulum | `hubsfoundation/reticulum:stable-latest` |
| Spoke | `hubsfoundation/spoke:stable-latest` |
| Dialog | `mozillareality/dialog:stable-latest` |
| Coturn | `mozillareality/coturn:stable-latest` |
| PostgreSQL | `mozillareality/postgres:stable-latest` |
| cert-manager | v1.19.3 (Helm chart) |
| Helm | v3.20.0 |

## Cost

| Resource | Monthly |
|----------|---------|
| DOKS Node (8GB RAM, 4 vCPU) | $48 |
| Load Balancer | $12 |
| Block Storage (2x 10Gi PVC) | ~$2 |
| SMTP (Mailtrap free tier) | $0 |
| **Total** | **~$62** |

> The 4GB node ($24) is NOT enough. Hubs CE uses ~3.5GB at idle. With 4GB, pods get OOM-killed and evicted in a cascade.

---

## Prerequisites

- **Node.js** v20+ ([nodejs.org](https://nodejs.org))
- **kubectl** matching your cluster version ([kubernetes.io](https://kubernetes.io/docs/tasks/tools/))
- **Helm** v3+ ([helm.sh](https://helm.sh/docs/intro/install/))
- **Git**
- **DigitalOcean account** with payment method
- **Domain name** with DNS access
- **SMTP service** (Mailtrap, Scaleway, etc.)

---

## Deploy From Scratch

### Step 1: Create DigitalOcean Kubernetes Cluster

1. DigitalOcean > Kubernetes > Create Cluster
2. Settings:

| Parameter | Value |
|-----------|-------|
| K8s version | Latest available (1.32+) |
| Region | Closest to your users |
| Scaling | Fixed |
| Machine type | Basic, Regular SSD |
| Node plan | **$48/mo - 8GB RAM / 4 vCPU** |
| Nodes | 1 |
| High Availability | No |

3. Name: lowercase + dashes only (e.g., `hubs-ce-ams3`)
4. Wait ~5 min for provisioning

### Step 2: Connect kubectl

```bash
# Option A: via doctl
doctl auth init
doctl kubernetes cluster kubeconfig save <cluster-name>

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
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
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
cp deployment/input-values.example.yaml hubs-cloud/community-edition/input-values.yaml
```

Edit `hubs-cloud/community-edition/input-values.yaml` with your real values:
- `HUB_DOMAIN` - your domain
- `ADM_EMAIL` - admin email for first login
- `SMTP_*` - your SMTP credentials
- `NODE_COOKIE`, `GUARDIAN_KEY`, `PHX_KEY` - **generate random 32+ character strings** (use `openssl rand -base64 48`)
- `PERSISTENT_VOLUME_STORAGE_CLASS` - `do-block-storage` for DigitalOcean

### Step 7: Generate hcce.yaml

```bash
cd hubs-cloud/community-edition
npm ci
npm run gen-hcce
```

Verify: `ls -lh hcce.yaml` should be 50-250KB.

### Step 8: Modify hcce.yaml (CRITICAL)

The generated hcce.yaml needs **4 manual edits** before applying. These are required because the official template doesn't support cert-manager or modern K8s versions.

#### 8a. Add cert-manager + ssl-redirect annotations to all 3 Ingresses

Find the 3 Ingress resources (`ret`, `dialog`, `nearspark`) and add these 2 lines to each `annotations:` block:

```yaml
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    haproxy.org/ssl-redirect: "true"
```

Example for `ret`:
```yaml
metadata:
  name: ret
  namespace: hcce
  annotations:
    kubernetes.io/ingress.class: haproxy
    cert-manager.io/cluster-issuer: "letsencrypt-prod"     # ADD
    haproxy.org/ssl-redirect: "true"                        # ADD
    haproxy.org/response-set-header: |
      ...existing annotations...
```

Do the same for `dialog` and `nearspark`.

#### 8b. Change HAProxy image

If you set `OVERRIDE_HAPROXY_IMAGE` in input-values.yaml, this is already done. Otherwise, find the HAProxy deployment and change:

```yaml
# FROM:
image: mozillareality/haproxy:stable-latest
# TO:
image: haproxytech/kubernetes-ingress:3.2
```

> **Why?** `mozillareality/haproxy:stable-latest` is based on haproxytech 1.8.5 (2022) and only supports K8s 1.21-1.23. It will crash on any version of K8s currently available on DigitalOcean (1.32+).

#### 8c. Remove securityContext from HAProxy deployment

Find and **delete** the entire `securityContext` block from the HAProxy container:

```yaml
          # DELETE these lines:
          securityContext:
            runAsUser: 1000
            runAsGroup: 1000
            capabilities:
              drop:
                - ALL
              add:
                - NET_BIND_SERVICE
```

> HAProxy 3.2 uses s6-overlay which needs root access to `/run`.

#### 8d. Keep --default-ssl-certificate (for now)

Leave this line in HAProxy args:
```yaml
- --default-ssl-certificate=hcce/cert-hcce
```
This bootstrap cert lets HAProxy start before real certs are issued. You'll remove it in Step 13.

### Step 9: Apply

```bash
kubectl apply -f hcce.yaml
```

### Step 10: Patch ClusterRole RBAC

HAProxy 3.2 needs extra API permissions that aren't in the official template:

```bash
kubectl patch clusterrole haproxy-cr --type=json -p '[
  {"op":"add","path":"/rules/-","value":{"apiGroups":["apiextensions.k8s.io"],"resources":["customresourcedefinitions"],"verbs":["get","list","watch"]}},
  {"op":"add","path":"/rules/-","value":{"apiGroups":["gateway.networking.k8s.io"],"resources":["gateways","gatewayclasses","httproutes","referencegrants","tcproutes"],"verbs":["get","list","watch"]}}
]'
```

Then restart HAProxy:
```bash
kubectl rollout restart deployment/haproxy -n hcce
```

> **WARNING**: `kubectl apply -f hcce.yaml` resets the ClusterRole every time. You MUST re-run this patch after every apply.

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

1. Edit hcce.yaml - comment out the bootstrap cert:
```yaml
# - --default-ssl-certificate=hcce/cert-hcce
```

2. Re-apply and re-patch:
```bash
kubectl apply -f hcce.yaml
# Re-patch RBAC (apply resets it):
kubectl patch clusterrole haproxy-cr --type=json -p '[
  {"op":"add","path":"/rules/-","value":{"apiGroups":["apiextensions.k8s.io"],"resources":["customresourcedefinitions"],"verbs":["get","list","watch"]}},
  {"op":"add","path":"/rules/-","value":{"apiGroups":["gateway.networking.k8s.io"],"resources":["gateways","gatewayclasses","httproutes","referencegrants","tcproutes"],"verbs":["get","list","watch"]}}
]'
```

3. Verify:
```bash
curl -sI https://yourdomain.com
# Should show HTTP/2 with valid SSL (issuer: Let's Encrypt)
```

### Step 14: Login and Verify

1. Open `https://yourdomain.com` - should show Hubs with green padlock
2. Enter your admin email > check email for magic link > click it
3. Access admin panel at `https://yourdomain.com/admin`

---

## Redeploy After Code Changes

When you modify the Hubs client, Reticulum, or any configuration:

```bash
# 1. Update input-values.yaml if needed

# 2. Regenerate manifest
cd hubs-cloud/community-edition
npm run gen-hcce

# 3. Edit hcce.yaml (same 4 changes as Step 8):
#    - cert-manager annotation on 3 ingresses
#    - ssl-redirect annotation on 3 ingresses
#    - HAProxy image: haproxytech/kubernetes-ingress:3.2
#    - Remove HAProxy securityContext
#    - Comment out --default-ssl-certificate (if certs already issued)

# 4. Apply
kubectl apply -f hcce.yaml

# 5. Re-patch RBAC (apply always resets it!)
kubectl patch clusterrole haproxy-cr --type=json -p '[
  {"op":"add","path":"/rules/-","value":{"apiGroups":["apiextensions.k8s.io"],"resources":["customresourcedefinitions"],"verbs":["get","list","watch"]}},
  {"op":"add","path":"/rules/-","value":{"apiGroups":["gateway.networking.k8s.io"],"resources":["gateways","gatewayclasses","httproutes","referencegrants","tcproutes"],"verbs":["get","list","watch"]}}
]'

# 6. Restart HAProxy to pick up changes
kubectl rollout restart deployment/haproxy -n hcce

# 7. Verify
kubectl get pods -n hcce            # All Running
kubectl get certificates -n hcce    # All READY: True
```

---

## Things You Must Know

### RBAC resets on every apply
`kubectl apply -f hcce.yaml` overwrites the ClusterRole `haproxy-cr` with the original permissions (missing apiextensions + gateway API). You MUST re-patch after EVERY apply. Forgetting this will cause HAProxy to log errors and eventually fail.

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
#   - securityContext not removed (s6-overlay can't write to /run)
#   - Missing RBAC permissions (re-patch ClusterRole)
#   - --default-ssl-certificate pointing to non-existent secret
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

---

## Backups

```bash
# Database backup (do this BEFORE any risky changes)
PGSQL_POD=$(kubectl get pod -n hcce -l app=pgsql -o jsonpath='{.items[0].metadata.name}')
kubectl exec $PGSQL_POD -n hcce -- pg_dump -U postgres ret_dev > backup_$(date +%Y%m%d).sql

# Built-in backup script (if available in your version)
cd hubs-cloud/community-edition
npm run backup
```

## Cost Savings

```bash
# Scale to 0 (stops compute, keeps storage + LB billing)
kubectl scale deployment --all --replicas=0 -n hcce

# Scale back up
kubectl scale deployment --all --replicas=1 -n hcce
kubectl get pods -n hcce -w  # Wait for all Running
```

> The Load Balancer ($12/mo) keeps billing even at 0 replicas. To fully stop costs, delete the cluster (data is lost unless backed up).

## References

- [Official Hubs CE Guide](https://docs.hubsfoundation.org/beginners-guide-to-CE.html)
- [cert-manager docs](https://cert-manager.io/docs/)
- [HAProxy Ingress Controller 3.2](https://www.haproxy.com/documentation/kubernetes-ingress/community/)
- [DigitalOcean Kubernetes](https://docs.digitalocean.com/products/kubernetes/)

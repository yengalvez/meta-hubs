# Deployment Guide - Hubs CE 2.0.0 on DigitalOcean

Step-by-step guide to deploy Hubs Community Edition on DigitalOcean Kubernetes, following the official method from [Hubs Foundation](https://docs.hubsfoundation.org/beginners-guide-to-CE.html).

## Cost Breakdown

| Resource | Monthly Cost |
|----------|-------------|
| DOKS Node (4GB RAM, 2 vCPU) | $24 |
| Load Balancer | $12 |
| Block Storage (10Gi) | ~$2 |
| **Subtotal** | **~$38** |
| SMTP service (Mailtrap/Scaleway) | $1-5 |
| Domain renewal | ~$0.40 ($5/year) |
| **Total** | **~$40-48** |

Taxes may apply depending on your location (e.g., 20% VAT in UK).

Capacity: 30-60 concurrent users with a single node.

## Prerequisites

1. **Node.js** v20+ - [nodejs.org](https://nodejs.org)
2. **kubectl** - [kubernetes.io](https://kubernetes.io/docs/tasks/tools/)
3. **doctl** (DigitalOcean CLI) - [docs.digitalocean.com](https://docs.digitalocean.com/reference/doctl/how-to/install/)
4. **Domain name** registered (e.g., Porkbun, Namecheap)
5. **DigitalOcean account** with payment method
6. **SMTP service** (Mailtrap, Scaleway, or similar)

## Step 1: Create DigitalOcean Kubernetes Cluster

1. Log into [DigitalOcean](https://cloud.digitalocean.com)
2. Go to **Kubernetes** > **Create Cluster**
3. Settings:
   - **Datacenter**: Choose the closest to your users
   - **Scaling**: Fixed (for cost control)
   - **Node size**: $24/month (4GB RAM, 2 vCPU)
   - **Nodes**: 1
   - **Name**: lowercase alphanumeric and dashes only (e.g., `hubs-ce-ams3`)
4. Click **Create Cluster** and wait for provisioning

## Step 2: Configure kubectl Access

### Option A: Via DigitalOcean Panel
Download the kubeconfig file from: Kubernetes > your-cluster > Download Config

### Option B: Via doctl CLI
```bash
# Authenticate with DigitalOcean
doctl auth init

# Generate API token at: https://cloud.digitalocean.com/account/api/tokens
# Scope: Full Access, Expiry: No expire

# Connect kubectl to your cluster
doctl kubernetes cluster kubeconfig save <cluster-name>

# Verify connection
kubectl get nodes
```

## Step 3: Configure Deployment Values

```bash
# From the project root, copy the template
cp deployment/input-values.example.yaml hubs-cloud/community-edition/input-values.yaml

# Edit with your real values
# Or if you have a local backup:
cp deployment/input-values.local.yaml hubs-cloud/community-edition/input-values.yaml
```

Edit `hubs-cloud/community-edition/input-values.yaml`:
- `HUB_DOMAIN`: Your domain (e.g., `meta-hubs.org`)
- `ADM_EMAIL`: Admin email for first login
- `DB_PASS`: Change from default `123456` to a strong password
- `SMTP_*`: Your SMTP provider credentials
- `NODE_COOKIE`, `GUARDIAN_KEY`, `PHX_KEY`: Random secure strings
- `PERSISTENT_VOLUME_STORAGE_CLASS`: `do-block-storage` for DigitalOcean

For SMTP setup, see the official guide: [Set up SMTP email service](https://docs.hubsfoundation.org/set-up-SMTP-email-service.html)

## Step 4: Deploy

```bash
cd hubs-cloud/community-edition
npm install
npm run gen-hcce    # Generates hcce.yaml from your input-values.yaml
kubectl apply -f hcce.yaml
```

## Step 5: Verify Deployment

```bash
# Check all deployments are ready (READY should show 1/1)
kubectl get deployment -n hcce

# All pods should be Running
kubectl get pods -n hcce

# Typical startup time: 70-90 seconds
```

Expected output - all deployments showing `1/1` READY:
```
NAME        READY   UP-TO-DATE   AVAILABLE
coturn      1/1     1            1
dialog      1/1     1            1
haproxy     1/1     1            1
hubs        1/1     1            1
nearspark   1/1     1            1
pgbouncer   1/1     1            1
pgbouncer-t 1/1     1            1
pgsql       1/1     1            1
postgrest   1/1     1            1
reticulum   1/1     1            1
spoke       1/1     1            1
```

## Step 6: Get Load Balancer IP

```bash
kubectl -n hcce get svc lb
```

Note the `EXTERNAL-IP` value. If it shows `<pending>`, wait a few minutes for DigitalOcean to provision the load balancer.

## Step 7: Configure DNS

In your domain registrar, create four **A records** pointing to the EXTERNAL-IP:

| Host | Type | Value |
|------|------|-------|
| `@` | A | EXTERNAL-IP |
| `assets` | A | EXTERNAL-IP |
| `cors` | A | EXTERNAL-IP |
| `stream` | A | EXTERNAL-IP |

DNS propagation may vary. Some registrars (like Porkbun) may delete the `@` host after adding - verify it persists.

## Step 8: Generate SSL Certificates

```bash
cd hubs-cloud/community-edition
npm run gen-ssl
```

This process generates Let's Encrypt certificates for all subdomains. It may take approximately 5 minutes. Certificates are valid for 90 days.

Before SSL is configured, you will see security warnings in the browser - this is expected.

## Step 9: Post-Deployment

1. Navigate to `https://your-domain.com` in your browser
2. Click "Sign In" and enter the admin email you configured
3. Check your email for the magic link
4. Access the Admin Panel at `https://your-domain.com/admin`
5. Configure scenes, avatars, and room settings

## SSL Certificate Renewal

Certificates expire every 90 days. To regenerate:

See official docs: [Regenerating SSL Certificates](https://docs.hubsfoundation.org/regenerating-ssl-certificates.html)

## Cost Savings: Startup/Shutdown Scripts

To save costs when not in use, you can scale pods to 0 replicas:

```bash
# Shutdown (saves ~70% cost by stopping compute, keeps storage)
kubectl scale deployment --all --replicas=0 -n hcce

# Startup
kubectl scale deployment --all --replicas=1 -n hcce

# Wait for pods to be ready
kubectl get pods -n hcce -w
```

Note: The Load Balancer ($12/month) continues billing even when pods are scaled to 0. To fully stop costs, delete the cluster (you will lose data unless backed up).

## Backups

The hubs-cloud repo includes backup/restore scripts:
```bash
cd hubs-cloud/community-edition
# See backup_script/ and restore_backup_script/ directories
```

## Troubleshooting

- **503 errors**: Check `kubectl get pods -n hcce` for CrashLoopBackOff. Check logs with `kubectl logs <pod-name> -n hcce`
- **Can't receive emails**: Verify SMTP credentials in input-values.yaml and redeploy
- **CSP errors**: Edit the reticulum ConfigMap to add allowed domains:
  ```bash
  kubectl edit configmap ret-config -n hcce
  # Update [ret."Elixir.RetWeb.Plugs.AddCSP"] section
  # Then restart: kubectl rollout restart deployment reticulum -n hcce
  ```
- **SSL issues**: Re-run `npm run gen-ssl` from the community-edition directory

## References

- [Official Beginner's Guide](https://docs.hubsfoundation.org/beginners-guide-to-CE.html)
- [Troubleshooting and FAQs](https://docs.hubsfoundation.org/faq.html)
- [Managing Content](https://docs.hubsfoundation.org/setup-configuring-content.html)
- [Backing Up Your Instance](https://docs.hubsfoundation.org/how-to-backup-your-Hubs-instance.html)

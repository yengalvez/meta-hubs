# YenHubs - Hubs CE 2.0.0 Custom Deployment

Custom deployment of [Hubs Foundation Community Edition](https://hubsfoundation.org/) on DigitalOcean Kubernetes.

## Features

- **Third-person camera** - Toggle between first and third person view ([docs](features/third-person/doc-thirdperson.md))
- **ReadyPlayer.me GLB avatars** - Pre-downloaded full-body avatars with validation ([docs](features/rpm-avatars/README.md))
- **Automated SSL** - Let's Encrypt certificates via cert-manager with auto-renewal
- **Cost-optimized** - DigitalOcean deployment at ~$62/month

## Quick Start

See [deployment/README.md](deployment/README.md) for the complete guide including cert-manager, HAProxy 3.2, and SSL setup.

```bash
# 1. Clone with submodules
git clone --recurse-submodules https://github.com/yengalvez/meta-hubs.git
cd meta-hubs

# 2. Create DOKS cluster (8GB node) + firewall
# 3. Install cert-manager via Helm
# 4. Apply IngressClass + ClusterIssuer
kubectl apply -f deployment/ingress-class.yaml
kubectl apply -f deployment/cluster-issuer.yaml

# 5. Configure
cp deployment/input-values.example.yaml hubs-cloud/community-edition/input-values.yaml
# Edit input-values.yaml with your domain, SMTP, etc.

# 6. Deploy
cd hubs-cloud/community-edition
npm ci && npm run gen-hcce
# Edit hcce.yaml (4 mandatory changes — see deployment/README.md Step 8)
kubectl apply -f hcce.yaml
# Patch RBAC + configure DNS → SSL auto-provisions
```

## Project Structure

```
YenHubs/
├── hubs/               # Hubs client fork (submodule: yengalvez/hubs)
├── hubs-cloud/         # Official deploy scripts (submodule: Hubs-Foundation/hubs-cloud)
├── deployment/         # Deployment config, manifests, and guide
│   ├── README.md              # Complete deployment guide
│   ├── input-values.example.yaml  # Values template
│   ├── cluster-issuer.yaml    # Let's Encrypt ClusterIssuer
│   └── ingress-class.yaml     # HAProxy IngressClass
├── features/
│   ├── third-person/   # Third-person camera implementation
│   ├── rpm-avatars/    # ReadyPlayer.me GLB avatar docs and validator
│   └── future/         # Features for potential future implementation
│       └── Avaturn/    # Avaturn avatar editor (not active)
└── docs/               # Project maintenance documentation
```

## Cost Estimate

| Resource | Monthly |
|----------|---------|
| DOKS Node (8GB RAM, 4 vCPU) | $48 |
| Load Balancer | $12 |
| Block Storage (2x 10Gi) | ~$2 |
| SMTP (Mailtrap) | $0-5 |
| **Total** | **~$62** |

> The 4GB node ($24) is NOT enough for production. See [deployment/README.md](deployment/README.md) for details.

## References

- [Official Hubs CE Guide](https://docs.hubsfoundation.org/beginners-guide-to-CE.html)
- [Hubs Foundation Docs](https://docs.hubsfoundation.org)
- [Hubs GitHub](https://github.com/Hubs-Foundation/hubs)
- [cert-manager Docs](https://cert-manager.io/docs/)
- [HAProxy Ingress Controller](https://www.haproxy.com/documentation/kubernetes-ingress/community/)
